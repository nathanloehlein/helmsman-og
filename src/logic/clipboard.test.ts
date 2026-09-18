import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const UUID = '550e8400-e29b-41d4-a716-446655440001';
let originalClipboard: PropertyDescriptor | undefined;
let originalExecCommand: PropertyDescriptor | undefined;

function clipboard(value: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

function legacyCopy(implementation: (command: string) => boolean) {
  const execCommand = vi.fn(implementation);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
  return execCommand;
}

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');
  document.body.innerHTML = '';
  clipboard(undefined);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand);
  else Reflect.deleteProperty(document, 'execCommand');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('copies the complete value through the Clipboard API without invoking a fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = legacyCopy(() => true);
    clipboard({ writeText });
    expect(await copyText(UUID)).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(UUID);
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back after denied clipboard permission and removes the temporary copy input', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    clipboard({ writeText });
    const execCommand = legacyCopy(command => {
      expect(command).toBe('copy');
      const textarea = document.querySelector('textarea');
      expect(textarea?.value).toBe(UUID);
      expect(textarea?.selectionStart).toBe(0);
      expect(textarea?.selectionEnd).toBe(UUID.length);
      return true;
    });
    expect(await copyText(UUID)).toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(UUID);
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('restores the focused input and its selection direction after a successful fallback', async () => {
    document.body.innerHTML = '<input value="Retain this selection">';
    const field = document.querySelector('input')!;
    field.focus();
    field.setSelectionRange(2, 8, 'backward');
    legacyCopy(() => {
      document.querySelector('textarea')?.focus();
      return true;
    });
    expect(await copyText(UUID)).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Retain this selection');
    expect([field.selectionStart, field.selectionEnd, field.selectionDirection]).toEqual([2, 8, 'backward']);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('restores selected page text and the focused control after fallback copying', async () => {
    document.body.innerHTML = '<button>Copy</button><p>Keep this selected</p>';
    const button = document.querySelector('button')!;
    const text = document.querySelector('p')!.firstChild!;
    button.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 9);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe('this');
    legacyCopy(() => {
      document.querySelector('textarea')?.focus();
      selection.removeAllRanges();
      const changedRange = document.createRange();
      changedRange.selectNodeContents(document.body);
      selection.addRange(changedRange);
      return true;
    });
    expect(await copyText(UUID)).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(selection.toString()).toBe('this');
    expect(selection.getRangeAt(0).startContainer).toBe(text);
    expect(selection.getRangeAt(0).startOffset).toBe(5);
    expect(selection.getRangeAt(0).endOffset).toBe(9);
  });

  it.each(['returns false', 'throws'])('reports failure and restores focus when the fallback %s', async (failure) => {
    document.body.innerHTML = '<input value="Original">';
    const field = document.querySelector('input')!;
    field.focus();
    field.setSelectionRange(1, 4);
    legacyCopy(() => {
      document.querySelector('textarea')?.focus();
      if (failure === 'throws') throw new Error('Copy unavailable');
      return false;
    });
    expect(await copyText(UUID)).toBe(false);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 4]);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('returns failure without changing focus when neither copy mechanism is available', async () => {
    document.body.innerHTML = '<button>Copy</button>';
    const button = document.querySelector('button')!;
    button.focus();
    expect(await copyText(UUID)).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
