const CMUX_SPECIAL_KEYS: string[] = [
  'up',
  'down',
  'left',
  'right',
  'tab',
  'escape',
  'backspace',
  'enter',
  'home',
  'end',
  'pageup',
  'pagedown',
];

function cmuxCtrlKeys(): string[] {
  const keys: string[] = [];
  for (let code = 97; code <= 122; code++) {
    keys.push(`ctrl+${String.fromCharCode(code)}`);
  }
  return keys;
}

export const CMUX_KEY_ALLOWLIST: Set<string> = new Set([...CMUX_SPECIAL_KEYS, ...cmuxCtrlKeys()]);

export function isAllowedKey(key: string): boolean {
  return CMUX_KEY_ALLOWLIST.has(key);
}
