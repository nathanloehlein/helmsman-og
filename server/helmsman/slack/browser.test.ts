import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackBrowserReader, extractSlackMessages, findSlackBrowserSurface, inspectSlackSearch, runSlackBrowserCommand, type SlackBrowserMessage, type SlackBrowserTransport } from './browser';

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

const config = { clientId: 'ET123', channelId: 'C123', channelName: 'airo-editing', surface: 'surface:17' };
const pr = 'https://github.com/org/repo/pull/42';

function row(ts = '1700000000.000001', content = `<a href="${pr}">PR</a>`, channel = config.channelId): string {
  return `<article data-qa="search_result"><div data-message-channel="${channel}"></div><a data-ts="${ts}" href="https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}">Time</a><span data-qa="message_sender_name" data-message-sender="U123">Author</span><div data-qa="message-text">${content}</div></article>`;
}

function message(ts: string): SlackBrowserMessage {
  return { channelId: config.channelId, ts, author: 'Author', permalink: `https://example.slack.com/archives/C123/p${ts.replace('.', '')}`, prUrls: [pr] };
}

function fakeBrowser(pages: SlackBrowserMessage[][], total: number | null = pages.flat().length) {
  let page = 0;
  let query = '';
  const commands: string[][] = [];
  const transport: SlackBrowserTransport = async args => {
    commands.push(args);
    if (args.includes('tree')) return JSON.stringify({ active: { surface_ref: 'surface:17' }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: 'surface:17', surfaces: [{ ref: 'surface:17', type: 'browser', url: 'https://app.slack.com/client/ET123/search' }] }] }] }] });
    if (args[2] === 'fill') {
      query = args[4] ?? '';
      return 'OK';
    }
    const script = args[3] ?? '';
    if (script.includes('function inspectSlackSearch')) return JSON.stringify({
      href: 'https://app.slack.com/client/ET123/search', query, full: true, newest: true,
      total, page: String(page + 1), hasNext: page < pages.length - 1, pagination: true, loading: false, empty: pages.flat().length === 0,
      results: (pages[page] ?? []).map(message => message.ts).join(','),
    });
    if (script.includes('function extractSlackMessages')) return JSON.stringify({ messages: pages[page] ?? [], unexpanded: 0 });
    if (script.includes('search_expand')) return 'false';
    if (script.includes('c-pagination_forward_btn')) page++;
    return 'true';
  };
  return { transport, commands };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Slack DOM message extraction', () => {
  it('preserves exact source identity and canonicalizes full PR anchors without requiring intent or a mention', () => {
    document.body.innerHTML = row(undefined, `<a href="${pr}?diff=split#discussion">label</a><a href="${pr}">again</a>`);
    expect(extractSlackMessages(document, config.channelId)).toEqual({ messages: [message('1700000000.000001')], unexpanded: 0 });
  });

  it('ignores plain text, lookalike hosts, non-PR URLs, quotations and unfurls', () => {
    document.body.innerHTML = row(undefined, `${pr}<a href="https://github.com.evil.test/org/repo/pull/42">bad</a><a href="https://github.com/org/repo/issues/42">issue</a><blockquote><a href="${pr}">quote</a></blockquote><div data-qa="message_unfurl"><a href="${pr}">unfurl</a></div>`);
    expect(extractSlackMessages(document, config.channelId).messages[0]?.prUrls).toEqual([]);
  });

  it('retains URL query context in Slack thread permalinks', () => {
    document.body.innerHTML = row();
    const anchor = document.querySelector('a[data-ts]');
    anchor?.setAttribute('href', `${anchor.getAttribute('href')}?thread_ts=1699999999.000001&cid=C123`);
    expect(extractSlackMessages(document, config.channelId).messages[0]?.permalink).toContain('thread_ts=1699999999.000001');
  });

  it('rejects every result from an unexpected channel', () => {
    document.body.innerHTML = row() + row('1700000001.000001', '', 'COTHER');
    expect(() => extractSlackMessages(document, config.channelId)).toThrow('unexpected channel');
  });

  it('rejects missing identity fields and a permalink belonging to another message', () => {
    document.body.innerHTML = row();
    document.querySelector('a[data-ts]')?.setAttribute('href', 'https://example.slack.com/archives/C123/p999');
    expect(() => extractSlackMessages(document, config.channelId)).toThrow('permalink');
    document.querySelector('[data-qa="message-text"]')?.remove();
    expect(() => extractSlackMessages(document, config.channelId)).toThrow('missing required fields');
  });

  it('accepts attachment-only messages using the exact search-header channel and never treats attachment links as PRs', () => {
    document.body.innerHTML = row();
    document.querySelector('[data-message-channel]')?.remove();
    document.querySelector('[data-qa="message-text"]')?.remove();
    document.querySelector('[data-qa="search_result"]')?.insertAdjacentHTML('beforeend', `<span data-qa="search_result_channel_name"><span data-channel-id="C123"></span></span><div data-qa="message_attachment_v2"><a href="${pr}">Attachment</a></div>`);
    expect(extractSlackMessages(document, config.channelId).messages[0]?.prUrls).toEqual([]);
  });

  it('reports unexpanded snippets and missing author without accepting incomplete data', () => {
    document.body.innerHTML = row(undefined, `<button data-qa="search_expand">Expand</button><a href="${pr}">PR</a>`);
    expect(extractSlackMessages(document, config.channelId).unexpanded).toBe(1);
    document.querySelector('[data-qa="message_sender_name"]')?.remove();
    expect(() => extractSlackMessages(document, config.channelId)).toThrow('missing required fields');
  });

  it('serializes its extraction function for execution in the browser without module dependencies', () => {
    document.body.innerHTML = row();
    expect(window.eval(`(${extractSlackMessages.toString()})(document, 'C123')`)).toEqual({ messages: [message('1700000000.000001')], unexpanded: 0 });
  });

  it('uses aria-disabled for pagination and refuses relevance order', () => {
    document.body.innerHTML = '<button data-qa="message_sort_toggle-button">Sort: Relevance</button><button data-qa="c-pagination_forward_btn" aria-disabled="true"></button>';
    expect(inspectSlackSearch(document)).toMatchObject({ full: false, newest: false, hasNext: false, pagination: true });
  });
});

describe('Slack browser discovery', () => {
  const tree = (surfaces: unknown[]) => ({ windows: [{ workspaces: [{ panes: [{ surfaces }] }] }] });
  it('discovers the browser again after search changes its route', () => {
    expect(findSlackBrowserSurface(tree([{ type: 'browser', ref: 'surface:99', url: 'https://app.slack.com/client/ET123/search' }]), config)).toBe('surface:99');
  });
  it('rejects missing, malformed, ambiguous and other-client surfaces', () => {
    expect(() => findSlackBrowserSurface(null, config)).toThrow('unavailable');
    expect(() => findSlackBrowserSurface(tree([null, { type: 'browser', ref: 'surface:1', url: 'https://app.slack.com/client/OTHER/C123' }]), config)).toThrow('unavailable');
    expect(() => findSlackBrowserSurface(tree([1, 2].map(id => ({ type: 'browser', ref: `surface:${id}`, url: 'https://app.slack.com/client/ET123/C123' }))), config)).toThrow('Multiple');
  });
});

describe('Slack browser scans', () => {
  it('submits a fresh scoped UI query and deduplicates overlapping pages through the final page', async () => {
    const a = message('1700000000.000001');
    const b = message('1700000000.000002');
    const c = message('1700000000.000003');
    const browser = fakeBrowser([[c, b], [b, a]], 3);
    const result = await createSlackBrowserReader(config, browser.transport).scan({ since: '2026-09-17T12:00:00Z' });
    expect(result).toEqual({ messages: [c, b, a], complete: true });
    expect(browser.commands).toContainEqual(['browser', 'surface:17', 'fill', '[role="combobox"][aria-label="Query"]', 'in:airo-editing after:2026-09-15']);
    expect(browser.commands.findIndex(args => args[2] === 'wait')).toBeLessThan(browser.commands.findIndex(args => args[2] === 'fill'));
    expect(browser.commands.some(args => args[3]?.includes('Search for:'))).toBe(true);
    expect(browser.commands.every(args => !args.includes('navigate'))).toBe(true);
  });

  it('does not claim complete coverage when the reported result count exceeds extracted messages', async () => {
    const browser = fakeBrowser([[message('1700000000.000001')]], 22);
    expect((await createSlackBrowserReader(config, browser.transport).scan({ since: null })).complete).toBe(false);
  });

  it('waits for message rows after search chrome appears and after the next-page indicator changes', async () => {
    const first = message('1700000000.000002');
    const second = message('1700000000.000001');
    const browser = fakeBrowser([[first], [second]], 2);
    let submitted = false;
    let shellObserved = false;
    let stalePageObserved = false;
    const reader = createSlackBrowserReader(config, async args => {
      if (args[2] === 'click' && args[3]?.includes('"submit"')) submitted = true;
      const output = await browser.transport(args);
      if (!args[3]?.includes('function inspectSlackSearch')) return output;
      const view = JSON.parse(output) as Record<string, unknown>;
      if (submitted && !shellObserved) {
        shellObserved = true;
        return JSON.stringify({ ...view, results: '', total: null, pagination: false, hasNext: false });
      }
      if (view.page === '2' && !stalePageObserved) {
        stalePageObserved = true;
        return JSON.stringify({ ...view, results: first.ts });
      }
      return output;
    });
    expect(await reader.scan({ since: null })).toEqual({ messages: [first, second], complete: true });
    expect(shellObserved && stalePageObserved).toBe(true);
  });

  it('accepts exact Slack decimal timestamp cursors and overlaps two days for timezone/date boundaries', async () => {
    const browser = fakeBrowser([[]], 0);
    await createSlackBrowserReader(config, browser.transport).scan({ since: '1789667936.000000' });
    expect(browser.commands.find(args => args[2] === 'fill')?.[4]).toBe('in:airo-editing after:2026-09-15');
  });

  it('returns a validated empty search successfully', async () => {
    const browser = fakeBrowser([[]], 0);
    expect(await createSlackBrowserReader(config, browser.transport).scan({ since: null })).toEqual({ messages: [], complete: true });
  });

  it('rejects signed-out pages and releases the scan lock after failure', async () => {
    const browser = fakeBrowser([[]], 0);
    let expired = true;
    const reader = createSlackBrowserReader(config, async args => expired && args[3]?.includes('function inspectSlackSearch') ? JSON.stringify({ href: 'https://app.slack.com/signin' }) : browser.transport(args));
    await expect(reader.scan({ since: null })).rejects.toThrow('signed out');
    expired = false;
    await expect(reader.scan({ since: null })).resolves.toMatchObject({ complete: true });
  });

  it('propagates command timeout failures and rejects invalid cursors before touching the browser', async () => {
    const transport = vi.fn<SlackBrowserTransport>().mockRejectedValue(new Error('command timed out'));
    const reader = createSlackBrowserReader(config, transport);
    await expect(reader.scan({ since: 'invalid' })).rejects.toThrow('cursor');
    expect(transport).not.toHaveBeenCalled();
    await expect(reader.scan({ since: null })).rejects.toThrow('timed out');
  });

  it.each(['unchanged', 'new-tab', 'new-focus'])('restores selection after a failed scan only when the user has not changed it: %s', async change => {
    const browser = fakeBrowser([[]], 0);
    let selected = 'surface:26';
    let active = 'surface:16';
    const focusCommands: string[] = [];
    const reader = createSlackBrowserReader(config, async args => {
      if (args.includes('tree')) return JSON.stringify({ active: { surface_ref: active }, windows: [{ workspaces: [{ panes: [{ selected_surface_ref: selected, surfaces: [{ ref: 'surface:17' }, { ref: 'surface:26' }] }] }] }] });
      if (args[0] === 'rpc') {
        const target = (JSON.parse(args[2] ?? '{}') as { surface_id?: string }).surface_id ?? '';
        focusCommands.push(target);
        active = target;
        if (target !== 'surface:16') selected = target;
        return '{}';
      }
      if (args[2] === 'wait') {
        if (change === 'new-tab') selected = 'surface:99';
        if (change === 'new-focus') active = 'surface:99';
        throw new Error('input unavailable');
      }
      return browser.transport(args);
    });
    await expect(reader.scan({ since: null })).rejects.toThrow('input unavailable');
    expect(focusCommands).toEqual(change === 'unchanged' ? ['surface:17', 'surface:16', 'surface:26', 'surface:16'] : ['surface:17', 'surface:16']);
    if (change === 'unchanged') expect({ selected, active }).toEqual({ selected: 'surface:26', active: 'surface:16' });
  });

  it('reuses an already-open search dialog after a prior failure', async () => {
    const browser = fakeBrowser([[]], 0);
    expect(await createSlackBrowserReader(config, browser.transport).scan({ since: null })).toMatchObject({ complete: true });
    expect(browser.commands.some(args => args[2] === 'click' && args[3]?.includes('top_nav_search'))).toBe(false);
  });

  it('returns partial when rendered messages change while a page is being read', async () => {
    const browser = fakeBrowser([[message('1700000000.000001')]], 1);
    let reads = 0;
    const result = await createSlackBrowserReader(config, async args => {
      if (args[3]?.includes('function extractSlackMessages') && ++reads === 2) return JSON.stringify({ messages: [], unexpanded: 0 });
      return browser.transport(args);
    }).scan({ since: null });
    expect(result.complete).toBe(false);
  });

  it('runs cmux without a shell and with bounded output and execution time', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: null, stdout: string) => void;
      callback(null, '[]');
      return undefined as never;
    });
    await expect(runSlackBrowserCommand(['tree', '--all', '--json'])).resolves.toBe('[]');
    expect(execFile).toHaveBeenCalledWith('cmux', ['tree', '--all', '--json'], expect.objectContaining({ timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls[0]?.[2]).not.toHaveProperty('shell');
  });
});
