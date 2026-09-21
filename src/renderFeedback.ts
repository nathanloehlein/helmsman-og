import './feedback.css';

const UNCONFIRMED = 'Could not confirm submission. Check Helmsman’s GitHub issues before trying again.';
const ISSUE_URL = 'https://github.com/nloehlein-godaddy/helmsman/issues/new';

export function openFeedback(opener: HTMLElement): void {
  const existing = document.querySelector<HTMLDialogElement>('.feedback-dialog');
  if (existing) { existing.querySelector<HTMLElement>('input:not(:disabled), [data-feedback-close]:not(:disabled)')?.focus(); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'feedback-dialog';
  dialog.setAttribute('aria-labelledby', 'feedback-title');
  dialog.innerHTML = `<form class="feedback-form">
    <h2 id="feedback-title">Helmsman feedback</h2>
    <p>Create an issue in <a href="https://github.com/nloehlein-godaddy/helmsman/issues" target="_blank" rel="noopener noreferrer">Helmsman’s GitHub tracker</a>.</p>
    <label>Title<input name="title" required maxlength="256" autocomplete="off" /></label>
    <label>Description<textarea name="body" required maxlength="10000" rows="7"></textarea></label>
    <p class="feedback-status" role="status" aria-live="polite"></p>
    <div class="feedback-actions"><a data-feedback-browser href="${ISSUE_URL}" target="_blank" rel="noopener noreferrer">Open in GitHub</a><button type="button" data-feedback-close>Cancel</button><button type="submit">Create issue</button></div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const title = form.elements.namedItem('title') as HTMLInputElement;
  const body = form.elements.namedItem('body') as HTMLTextAreaElement;
  const status = form.querySelector<HTMLElement>('.feedback-status')!;
  const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const close = form.querySelector<HTMLButtonElement>('[data-feedback-close]')!;
  const browser = form.querySelector<HTMLAnchorElement>('[data-feedback-browser]')!;
  let pending = false;
  let completed = false;
  const updateLink = () => {
    const url = new URL(ISSUE_URL);
    url.searchParams.set('title', title.value);
    url.searchParams.set('body', body.value);
    browser.href = url.href;
  };
  form.addEventListener('input', updateLink);
  close.addEventListener('click', () => { if (!pending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (opener.isConnected) opener.focus(); }, { once: true });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pending || completed || !form.reportValidity()) return;
    pending = true;
    submit.disabled = close.disabled = title.disabled = body.disabled = true;
    browser.hidden = true;
    status.textContent = 'Creating issue…';
    void (async () => {
      let errorMessage = UNCONFIRMED;
      try {
        const response = await fetch('/api/feedback', { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.value, body: body.value }) });
        const result = await response.json() as { url?: unknown; error?: unknown } | null;
        if (!response.ok) {
          errorMessage = typeof result?.error === 'string' && result.error.trim() ? result.error : UNCONFIRMED;
          throw new Error(errorMessage);
        }
        if (typeof result?.url !== 'string' || !/^https:\/\/github\.com\/nloehlein-godaddy\/helmsman\/issues\/[1-9]\d*$/.test(result.url)) throw new Error(UNCONFIRMED);
        completed = true;
        status.replaceChildren(document.createTextNode('Feedback created. '));
        const link = document.createElement('a');
        link.href = result.url; link.textContent = 'View issue'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        status.append(link);
        submit.hidden = true;
        close.textContent = 'Done';
      } catch {
        status.textContent = errorMessage;
        submit.disabled = title.disabled = body.disabled = false;
        browser.hidden = false;
      } finally {
        pending = false;
        close.disabled = false;
        (completed ? close : title).focus();
      }
    })();
  });
  dialog.showModal();
  title.focus();
}
