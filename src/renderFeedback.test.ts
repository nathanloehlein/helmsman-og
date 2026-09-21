import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFeedback } from './renderFeedback';

beforeEach(() => {
  document.body.innerHTML = '<button id="open">Feedback</button>';
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function open() {
  openFeedback(document.querySelector<HTMLElement>('#open')!);
  const form = document.querySelector<HTMLFormElement>('form')!;
  (form.elements.namedItem('title') as HTMLInputElement).value = 'A bug';
  (form.elements.namedItem('body') as HTMLTextAreaElement).value = 'Steps <script>literal</script>';
  form.dispatchEvent(new Event('input'));
  return form;
}

describe('feedback dialog', () => {
  it('submits once, shows created issue and prevents duplicates', async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>(r => { resolve = r; }));
    vi.stubGlobal('fetch', fetch);
    const form = open();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    resolve(new Response(JSON.stringify({ url: 'https://github.com/nloehlein-godaddy/helmsman/issues/1' })));
    await vi.waitFor(() => expect(form.textContent).toContain('Feedback created.'));
    expect(form.querySelector<HTMLAnchorElement>('.feedback-status a')?.href).toBe('https://github.com/nloehlein-godaddy/helmsman/issues/1');
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.hidden).toBe(true);
    expect(document.activeElement).toBe(form.querySelector('[data-feedback-close]'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    form.querySelector<HTMLButtonElement>('[data-feedback-close]')?.click();
    expect(document.querySelector('dialog')).toBeNull();
    expect(document.activeElement?.id).toBe('open');
  });
  it('preserves draft and offers GitHub fallback after a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'GitHub not configured' }), { status: 503 })));
    const form = open();
    expect(document.activeElement).toBe(form.elements.namedItem('title'));
    const link = form.querySelector<HTMLAnchorElement>('[data-feedback-browser]')!;
    expect(new URL(link.href).searchParams.get('body')).toBe('Steps <script>literal</script>');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(form.textContent).toContain('GitHub not configured'));
    expect((form.elements.namedItem('title') as HTMLInputElement).value).toBe('A bug');
    expect(link.hidden).toBe(false);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(false);
  });
  it.each(['network', 'invalid-json', 'invalid-url'])('warns about unconfirmed creation after %s without retrying', async failure => {
    const request = vi.fn();
    if (failure === 'network') request.mockRejectedValue(new TypeError('Failed to fetch'));
    else request.mockResolvedValue(new Response(failure === 'invalid-json' ? '<html>Proxy failure</html>' : JSON.stringify({ url: 'https://untrusted.invalid/issues/1' })));
    vi.stubGlobal('fetch', request);
    const form = open();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(form.textContent).toContain('Could not confirm submission. Check Helmsman’s GitHub issues before trying again.'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(document.activeElement).toBe(form.elements.namedItem('title'));
    expect(form.querySelector('.feedback-status a')).toBeNull();
  });

});
