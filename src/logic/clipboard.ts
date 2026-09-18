export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  if (typeof document.execCommand !== 'function') return false;
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => selection!.getRangeAt(index).cloneRange());
  const inputSelection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  try {
    document.body.appendChild(input);
    input.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    input.remove();
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    ranges.forEach(range => selection?.addRange(range));
    if (inputSelection?.start != null && inputSelection.end != null
      && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
      focused.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    }
  }
}
