import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackBrowserReviewSender, inspectSlackReviewPage, markSlackReviewChannel, markSlackReviewGroup } from './browser-review';
import { withSlackBrowserLock, type SlackBrowserTransport } from './browser';

const config = { clientId: 'ET123', channelId: 'C123', channelName: 'reviews', surface: 'surface:4' };
const input = { repo: 'owner/repo', prNumber: 42, requestId: '11111111-1111-4111-8111-111111111111', channel: 'reviews', mention: 'reviewers' };
const text = '@reviewers Could you review this PR? https://github.com/owner/repo/pull/42';

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

function fakeBrowser(options: { draft?: string; wrongGroup?: boolean; sendError?: boolean; wrongReceipt?: boolean; invalidSend?: boolean } = {}) {
  const commands: string[][] = [];
  let draft = options.draft ?? '';
  let typed = false;
  let draftReads = 0;
  let sent = false;
  let sendCount = 0;
  const transport: SlackBrowserTransport = async args => {
    commands.push(args);
    if (args.includes('tree')) return JSON.stringify({ active: { surface_ref: 'surface:4' }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: 'surface:4', surfaces: [{ ref: 'surface:4', type: 'browser', url: 'https://app.slack.com/client/ET123/C123' }] }] }] }] });
    const script = args[3] ?? '';
    if (script.includes('function prepareSlackReview')) { draft = text; typed = true; return 'true'; }
    if (script.includes('function sendPreparedSlackReview')) {
      if (options.invalidSend) return 'false';
      sent = true; draft = ''; sendCount++;
      if (options.sendError) throw new Error('transport disconnected');
      return 'true';
    }
    if (typed && script.includes('function inspectSlackReviewPage')) draftReads++;
    if (script.includes('function inspectSlackReviewPage')) return JSON.stringify({ href: 'https://app.slack.com/client/ET123/C123', name: 'reviews', channelId: 'C123', editors: 1, draft, groups: typed ? [{ id: options.wrongGroup && draftReads > 1 ? 'SOTHER' : 'S123', text: 'reviewers' }] : [], attachments: false, otherDraft: false,
      rows: sent ? [{ channel: options.wrongReceipt ? 'COTHER' : 'C123', ts: '1700000000.000001', text, groups: [{ id: 'S123', text: 'reviewers' }], href: 'https://example.slack.com/archives/C123/p1700000000000001' }] : [] });
    if (script.includes('function markSlackReviewChannel')) return JSON.stringify({ id: 'C123', name: 'reviews' });
    if (script.includes('function markSlackReviewGroup')) return JSON.stringify({ id: 'S123', handle: 'reviewers' });
    if (args[2] === 'eval') return String(!options.invalidSend || !script.includes('texty_send_button'));
    if (args[2] === 'fill' && script.includes('review-editor')) { draft = args[4] ?? ''; typed = true; }
    if (args[2] === 'type') { draft = text; typed = true; }
    return 'OK';
  };
  return { transport, commands, get sendCount() { return sendCount; } };
}

describe('Slack browser review preparation', () => {
  it('resolves an exact visible channel name or ID and refuses ambiguous matches', () => {
    document.body.innerHTML = '<span data-channel-id="C123"><span data-qa="inline_channel_entity__name">reviews</span></span><span data-channel-id="C456">other</span>';
    expect(markSlackReviewChannel(document, 'reviews')).toEqual({ id: 'C123', name: 'reviews' });
    expect(markSlackReviewChannel(document, 'C123')).toEqual({ id: 'C123', name: 'reviews' });
    expect(markSlackReviewChannel(document, 'review')).toBeNull();
    document.body.insertAdjacentHTML('beforeend', '<span data-channel-id="C789">reviews</span>');
    expect(markSlackReviewChannel(document, 'reviews')).toBeNull();
  });

  it('requires a real matching user group rather than a similarly named person or plain text', () => {
    document.body.innerHTML = '<div role="option" data-entity-id="U123">@reviewers</div><div role="option" data-usergroup-id="S123"><span>@reviewers</span></div>';
    expect(markSlackReviewGroup(document, 'reviewers')).toEqual({ id: 'S123', handle: 'reviewers' });
    expect(markSlackReviewGroup(document, 'reviewer')).toBeNull();
    document.querySelector('[data-usergroup-id]')?.remove();
    expect(markSlackReviewGroup(document, 'reviewers')).toBeNull();
  });

  it('extracts only real mention chips and detects drafts, attachments and extra editors', () => {
    document.body.innerHTML = '<span data-qa="channel_name">reviews</span><div data-qa="message_input" contenteditable="true">@plain <span data-mention-id="S123">@reviewers</span></div><div data-qa="thread_view"><div contenteditable="true" class="ql-editor">Other draft</div></div><div data-qa="file_upload_preview"></div>';
    const state = inspectSlackReviewPage(document);
    expect(state).toMatchObject({ name: 'reviews', editors: 1, draft: '@plain @reviewers', groups: [{ id: 'S123', text: 'reviewers' }], attachments: true, otherDraft: true });
    expect(window.eval(`(${inspectSlackReviewPage.toString()})(document)`)).toEqual(state);
  });
});

describe('Slack browser review sender', () => {
  it('sends once through DOM controls and confirms channel, exact text and real mention', async () => {
    const browser = fakeBrowser();
    await expect(createSlackBrowserReviewSender(config, browser.transport).send(input)).resolves.toEqual({ channel: 'reviews', mention: 'reviewers', permalink: 'https://example.slack.com/archives/C123/p1700000000000001' });
    expect(browser.sendCount).toBe(1);
    expect(browser.commands.some(args => args[2] === 'eval' && args[3]?.includes('function prepareSlackReview'))).toBe(true);
    expect(browser.commands.some(args => args.join(' ').includes('slack.com/api/'))).toBe(false);
  });

  it('refuses existing drafts without typing or attempting a send', async () => {
    const browser = fakeBrowser({ draft: 'User draft' });
    await expect(createSlackBrowserReviewSender(config, browser.transport).send(input)).rejects.toMatchObject({ uncertain: false, status: 409 });
    expect(browser.commands.some(args => ['fill', 'type', 'click'].includes(args[2] ?? ''))).toBe(false);
  });

  it.each([{ wrongGroup: true }, { invalidSend: true }])('does not send when final preparation fails: %j', async options => {
    const browser = fakeBrowser(options);
    await expect(createSlackBrowserReviewSender(config, browser.transport).send(input)).rejects.toMatchObject({ uncertain: false });
    expect(browser.sendCount).toBe(0);
  });

  it('reports transport failure after the single send attempt as uncertain', async () => {
    const browser = fakeBrowser({ sendError: true });
    await expect(createSlackBrowserReviewSender(config, browser.transport).send(input)).rejects.toMatchObject({ uncertain: true });
    expect(browser.sendCount).toBe(1);
  });

  it('never retries after a message appears in the wrong channel', async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser({ wrongReceipt: true });
    const result = expect(createSlackBrowserReviewSender(config, browser.transport).send(input)).rejects.toMatchObject({ uncertain: true });
    await vi.runAllTimersAsync();
    await result;
    expect(browser.sendCount).toBe(1);
  });

  it('requires group handles and rejects bad input before touching the browser', async () => {
    const browser = fakeBrowser();
    await expect(createSlackBrowserReviewSender(config, browser.transport).send({ ...input, mention: 'S123' })).rejects.toMatchObject({ uncertain: false, status: 400 });
    expect(browser.commands).toHaveLength(0);
  });

  it('queues the sender behind existing browser work and releases the lock after failure', async () => {
    let release!: () => void;
    const held = withSlackBrowserLock(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const browser = fakeBrowser();
    const send = createSlackBrowserReviewSender(config, browser.transport).send(input);
    await Promise.resolve();
    expect(browser.commands).toHaveLength(0);
    release(); await held; await send;
    await expect(withSlackBrowserLock(async () => { throw new Error('reader failed'); })).rejects.toThrow('reader failed');
    await expect(withSlackBrowserLock(async () => 'released')).resolves.toBe('released');
  });
});
