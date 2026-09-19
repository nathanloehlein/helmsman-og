interface PreparedReview {
  clientId: string;
  channelId: string;
  channelName: string;
  groupId: string;
  text: string;
}

interface ComposerState {
  href: string;
  name: string;
  channelId: string | null;
  editors: number;
  draft: string | null;
  groups: { id: string }[];
  attachments: boolean;
  otherDraft: boolean;
}

export function prepareSlackReview(doc: Document, expected: Omit<PreparedReview, 'groupId'>, inspect: (doc: Document) => ComposerState): boolean {
  const view = inspect(doc);
  const url = new URL(view.href);
  if (url.origin !== 'https://app.slack.com' || url.pathname !== `/client/${expected.clientId}/${expected.channelId}`
    || view.name !== expected.channelName || view.channelId !== expected.channelId || view.editors !== 1
    || view.draft || view.groups.length || view.attachments || view.otherDraft) return false;
  const editors = doc.querySelectorAll<HTMLElement>('[data-helmsman-review-editor="true"]');
  const editor = editors.length === 1 ? editors[0] : undefined;
  const selection = doc.getSelection();
  if (!editor?.isConnected || editor.getAttribute('contenteditable') !== 'true'
    || editor.textContent?.trim() || !selection || typeof doc.execCommand !== 'function') return false;
  editor.focus();
  if (editor.textContent?.trim()) return false;
  const range = doc.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  return doc.execCommand('insertText', false, expected.text);
}

export function sendPreparedSlackReview(doc: Document, expected: PreparedReview, inspect: (doc: Document) => ComposerState): boolean {
  const view = inspect(doc);
  const url = new URL(view.href);
  if (url.origin !== 'https://app.slack.com' || url.pathname !== `/client/${expected.clientId}/${expected.channelId}`
    || view.name !== expected.channelName || view.channelId !== expected.channelId || view.editors !== 1
    || view.draft !== expected.text || view.attachments || view.otherDraft
    || view.groups.length !== 1 || view.groups[0]?.id !== expected.groupId) return false;
  const editors = doc.querySelectorAll<HTMLElement>('[data-helmsman-review-editor="true"]');
  const editor = editors.length === 1 ? editors[0] : undefined;
  if (!editor?.isConnected || editor.getAttribute('contenteditable') !== 'true'
    || (editor.textContent ?? '').replace(/[\s\u200b]+/g, ' ').trim() !== expected.text) return false;
  const composer = editor.closest('[data-qa="message_input_container"], .p-message_input, .p-message_pane__bottom');
  const buttons = composer?.querySelectorAll<HTMLButtonElement>('button[data-qa="texty_send_button"]');
  const button = buttons?.length === 1 ? buttons[0] : undefined;
  if (!button?.isConnected || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
  button.click();
  return true;
}
