import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectSlackReviewPage } from './browser-review';
import { prepareSlackReview, sendPreparedSlackReview } from './browser-review-send';
import { slackBrowserEvaluation } from './browser';

const expected = { clientId: 'ET123', channelId: 'C123', channelName: 'reviews', groupId: 'S123', text: '@reviewers Could you review this PR? https://github.com/owner/repo/pull/42' };
let href: string;
const sent = vi.fn();
const inspect = (doc: Document) => ({ ...inspectSlackReviewPage(doc), href });

beforeEach(() => {
  href = 'https://app.slack.com/client/ET123/C123';
  sent.mockClear();
  document.body.innerHTML = `<span data-qa="channel_name">reviews</span><div data-channel-id="C123" data-qa="message_input_container"><div class="ql-editor" contenteditable="true" data-helmsman-review-editor="true"><ts-mention data-id="S123">@reviewers</ts-mention> Could you review this PR? https://github.com/owner/repo/pull/42</div><button data-qa="texty_send_button">Send</button></div>`;
  document.querySelector('button')?.addEventListener('click', sent);
});
afterEach(() => { document.body.innerHTML = ''; Reflect.deleteProperty(document, 'execCommand'); });

describe('atomic Slack preparation', () => {
  it('inserts into an empty verified composer using browser editing events', () => {
    const editor = document.querySelector('.ql-editor')!;
    editor.textContent = '';
    const insert = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: insert });
    const prepare = window.eval(`(${prepareSlackReview.toString()})`) as typeof prepareSlackReview;
    expect(prepare(document, expected, inspect)).toBe(true);
    expect(insert).toHaveBeenCalledWith('insertText', false, expected.text);
  });

  it('preserves text entered after an earlier empty-composer check', () => {
    const editor = document.querySelector('.ql-editor')!;
    editor.textContent = '';
    expect(inspect(document).draft).toBe('');
    editor.textContent = 'New user draft';
    const insert = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: insert });
    expect(prepareSlackReview(document, expected, inspect)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(editor.textContent).toBe('New user draft');
  });
});

describe('atomic Slack send guard', () => {
  it('evaluates serialized functions containing the tsx name-preservation helper', () => {
    const script = slackBrowserEvaluation('(() => { const clean = __name(text => text.trim(), "clean"); return clean(" ready "); })()');
    expect(JSON.parse(window.eval(script))).toBe('ready');
  });

  it('validates the current composer and sends within one browser operation', () => {
    const send = window.eval(`(${sendPreparedSlackReview.toString()})`) as typeof sendPreparedSlackReview;
    expect(send(document, expected, inspect)).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['workspace', () => { href = 'https://app.slack.com/client/OTHER/C123'; }],
    ['channel route', () => { href = 'https://app.slack.com/client/ET123/COTHER'; }],
    ['channel composer', () => { document.querySelector('[data-channel-id]')?.setAttribute('data-channel-id', 'COTHER'); }],
    ['draft', () => { document.querySelector('.ql-editor')?.append(' user edit'); }],
    ['mention', () => { document.querySelector('ts-mention')?.setAttribute('data-id', 'SOTHER'); }],
    ['attachment', () => { document.body.insertAdjacentHTML('beforeend', '<div data-qa="file_upload_preview"></div>'); }],
    ['another draft', () => { document.body.insertAdjacentHTML('beforeend', '<div class="p-thread_view"><div class="ql-editor" contenteditable="true">user draft</div></div>'); }],
    ['disabled button', () => { document.querySelector('button')?.setAttribute('disabled', ''); }],
    ['duplicate send buttons', () => { document.querySelector('[data-qa="message_input_container"]')?.insertAdjacentHTML('beforeend', '<button data-qa="texty_send_button">Other send</button>'); }],
    ['unmarked editor', () => { document.querySelector('.ql-editor')?.removeAttribute('data-helmsman-review-editor'); }],
  ] as const)('refuses a changed %s before clicking', (_label, change) => {
    expect(inspect(document).draft).toBe(expected.text);
    change();
    expect(sendPreparedSlackReview(document, expected, inspect)).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });
});
