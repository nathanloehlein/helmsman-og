/**
 * WezTerm has no `send-key` subcommand — `wezterm cli send-text` is the only
 * input path. So every key the UI can emit has to be translated to the bytes a
 * terminal would have produced, and written as literal text.
 *
 * Two vocabularies arrive here:
 *   - lowercase tokens from the browser (`src/logic/cmuxKeys.ts`): `enter`,
 *     `escape`, `ctrl+c`, …
 *   - cmux CLI key names from `cmux/actions.ts`: `Enter`, `Escape`, `C-c`, `y`
 * Both are accepted so the wezterm bridge is a drop-in for the cmux one.
 */

const NAMED_BYTES: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
};

/** `ctrl+a` / `C-a` → 0x01 … `ctrl+z` / `C-z` → 0x1a */
function ctrlByte(letter: string): string {
  return String.fromCharCode(letter.toLowerCase().charCodeAt(0) - 96);
}

const CTRL_FORMS = [/^ctrl\+([a-z])$/i, /^c-([a-z])$/i];

/**
 * Translate a key token to the bytes to send, or null if it isn't a key we
 * recognise. Returning null (rather than throwing or passing the token through)
 * keeps an unknown token from being typed into the pane as literal text.
 */
export function keyToBytes(key: string): string | null {
  const named = NAMED_BYTES[key.toLowerCase()];
  if (named !== undefined) return named;

  for (const form of CTRL_FORMS) {
    const m = form.exec(key);
    if (m) return ctrlByte(m[1]);
  }

  // Actions expand to literal characters too, e.g. `approve` is ['y', 'Enter'].
  if (key.length === 1 && key >= ' ' && key <= '~') return key;

  return null;
}
