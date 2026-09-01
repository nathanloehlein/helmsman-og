export type CmuxKeyIntent = { kind: 'key'; token: string } | { kind: 'text'; text: string } | { kind: 'ignore' };

export interface CmuxKeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const NAMED_CMUX_KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Enter: 'enter',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

export function mapKeyEvent(e: CmuxKeyEventLike): CmuxKeyIntent {
  if (e.metaKey) return { kind: 'ignore' };
  if (e.ctrlKey && e.key.length === 1 && /^[a-zA-Z]$/.test(e.key)) {
    return { kind: 'key', token: `ctrl+${e.key.toLowerCase()}` };
  }
  const named: string | undefined = NAMED_CMUX_KEYS[e.key];
  if (named) return { kind: 'key', token: named };
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) return { kind: 'text', text: e.key };
  return { kind: 'ignore' };
}
