/**
 * Which agent CLI a pane is running, guessed from its title.
 *
 * cmux types its surfaces, so it knows; wezterm does not, and on Windows the
 * pane title is the process image name (`claude.exe`). Shared by the panel,
 * which derives the action buttons, and by the wezterm bridge, whose change
 * fingerprint has to notice a pane becoming (or ceasing to be) an agent.
 */

const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode']);

/** Extensions Windows appends to the same command. */
const EXECUTABLE_SUFFIX = /\.(exe|cmd|bat|ps1)$/i;

/**
 * A title is a command line, not a path. Tokens containing a path separator are
 * skipped entirely: a shell whose title is its cwd (`/work/claude/config`,
 * `C:\Users\alice\codex`, `/Users/alice/.codex`) must not be taken for an agent,
 * because the panel would then offer Approve, which types `y` and Enter into it.
 *
 * The cost is that a command written as an absolute path (`/usr/bin/claude`)
 * goes undetected. That is the safe direction to be wrong in.
 */
export function providerFromTitle(title: string): string | null {
  for (const token of title.split(/\s+/)) {
    if (token.includes('/') || token.includes('\\')) continue;
    const name = token.replace(EXECUTABLE_SUFFIX, '').toLowerCase();
    if (PROVIDERS.has(name)) return name;
  }
  return null;
}
