import './feedback.css';

const ISSUE_URL = 'https://github.com/nloehlein-godaddy/helmsman/issues/new';

export function openFeedback(opener: HTMLElement): void {
  const existing = document.querySelector<HTMLDialogElement>('.feedback-dialog');
  if (existing) { existing.querySelector<HTMLInputElement>('input')?.focus(); return; }
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
    if (pending || !form.reportValidity()) return;
    pending = true;
    submit.disabled = close.disabled = title.disabled = body.disabled = true;
    browser.hidden = true;
    status.textContent = 'Creating issue…';
    void (async () => {
      try {
        const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.value, body: body.value }) });
        const result = await response.json() as { url?: unknown; error?: unknown } | null;
        if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Could not confirm submission. Check GitHub before trying again.');
        if (typeof result?.url !== 'string' || !/^https:\/\/github\.com\/nloehlein-godaddy\/helmsman\/issues\/[1-9]\d*$/.test(result.url)) throw new Error('Could not confirm submission. Check GitHub before trying again.');
        status.replaceChildren(document.createTextNode('Feedback created. '));
        const link = document.createElement('a');
        link.href = result.url; link.textContent = 'View issue'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        status.append(link);
        submit.hidden = true;
        close.textContent = 'Done';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Could not confirm submission. Check GitHub before trying again.';
        submit.disabled = title.disabled = body.disabled = false;
        browser.hidden = false;
      } finally { pending = false; close.disabled = false; }
    })();
  });
  dialog.showModal();
}
