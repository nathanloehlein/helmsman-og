import { RUN_LOG_LINE_LIMIT } from './runLog';

const MAX_TOKENS = 128;
const STRINGS_AND_VALUES = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\b(?:const|let|var|function|return|if|else|throw|new|await|async|import|export|from|class|interface|type|extends|implements|try|catch|finally|switch|case|break|default|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b/g;
const SHELL_TOKENS = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:--?[a-zA-Z][\w-]*)(?:=[^\s]+)?|(?:\.{0,2}\/|~\/)[^\s"'`]+|\b[\w@.-]+(?:\/[\w@.-]+)+|\b\d+\b/g;
const CODE_START = /^\s*(?:(?:export\s+(?:default\s+)?)?(?:const|let|var|function|class|interface|type|import)\s|(?:if|for|while|switch|catch)\s*\(|(?:async\s+)?[\w$]+\s*\([^)]*\)\s*(?:=>|\{)|\/\/)/;
const COMMAND_START = /^(\s*(?:\$\s+|(?:Bash|Shell|exec|command):\s*)?)((?:\/bin\/(?:ba|z)?sh|git|gh|npm|npx|pnpm|yarn|node|tsx|tsc|rg|cat|sed|ls|cd|pwd|curl|python3?|pytest|cargo|go|cmux)\b)/;

type TokenKind = 'key' | 'string' | 'number' | 'keyword' | 'command' | 'path' | 'comment' | 'addition' | 'deletion' | 'heading';

export function appendHighlightedLog(target: HTMLElement, text: string, kind: string): void {
  if (kind === 'error' || kind === 'stderr') {
    target.appendChild(document.createTextNode(text));
    return;
  }
  let tokens = 0;
  const append = (value: string, token?: TokenKind): void => {
    if (!value) return;
    if (!token || tokens >= MAX_TOKENS) {
      const last = target.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) last.textContent = (last.textContent ?? '') + value;
      else target.appendChild(document.createTextNode(value));
      return;
    }
    const span = document.createElement('span');
    span.className = `log-token-${token}`;
    span.textContent = value;
    target.appendChild(span);
    tokens++;
  };
  const tokenize = (line: string, mode: 'code' | 'json' | 'shell'): void => {
    const pattern = mode === 'shell' ? SHELL_TOKENS : STRINGS_AND_VALUES;
    pattern.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while (tokens < MAX_TOKENS && (match = pattern.exec(line))) {
      const value = match[0];
      append(line.slice(cursor, match.index));
      const quoted = /^["'`]/.test(value);
      const token: TokenKind = quoted
        ? (/^\s*:/.test(line.slice(match.index + value.length)) ? 'key' : 'string')
        : /^\d/.test(value) ? 'number'
          : mode === 'shell' ? (value.startsWith('-') ? 'keyword' : 'path')
            : value.startsWith('//') ? 'comment' : 'keyword';
      append(value, token);
      cursor = match.index + value.length;
    }
    append(line.slice(cursor));
  };

  let diff = false;
  let fence: 'code' | 'json' | 'shell' | 'diff' | 'plain' | null = null;
  const preview = text.slice(0, RUN_LOG_LINE_LIMIT);
  for (const line of preview.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (tokens >= MAX_TOKENS) { append(line); continue; }
    const marker = line.match(/^\s*```([\w+-]*)[^\S\n]*(?:\n)?$/);
    if (marker) {
      const language = marker[1]?.toLowerCase() ?? '';
      fence = fence ? null
        : /^(?:js|jsx|ts|tsx|javascript|typescript)$/.test(language) ? 'code'
          : language === 'json' ? 'json'
            : /^(?:sh|bash|shell|zsh)$/.test(language) ? 'shell'
              : /^(?:diff|patch)$/.test(language) ? 'diff' : 'plain';
      append(line, 'comment');
    } else if (fence === 'plain') {
      append(line);
    } else if (/^\s*(?:diff --git\b|@@|\+\+\+ |--- )/.test(line)) {
      diff = true;
      append(line, 'heading');
    } else if (/^\+[^+]/.test(line)) {
      append(line, 'addition');
    } else if (/^-[^-\s]/.test(line) || ((fence === 'diff' || diff) && line.startsWith('-'))) {
      append(line, 'deletion');
    } else if (fence && fence !== 'diff') {
      tokenize(line, fence);
    } else if (/^\s*(?:\{\s*"|\[\s*\{|"(?:\\.|[^"\\])*"\s*:)/.test(line)) {
      tokenize(line, 'json');
    } else if (kind === 'tool' || COMMAND_START.test(line)) {
      const command = line.match(COMMAND_START) ?? line.match(/^(\s*)([\w.:-]+)/);
      if (command) {
        append(command[1] ?? '');
        append(command[2] ?? '', 'command');
        tokenize(line.slice(command[0].length), 'shell');
      } else tokenize(line, 'shell');
    } else if (CODE_START.test(line)) {
      tokenize(line, 'code');
    } else if (/^\s*#{1,6}\s+\S/.test(line)) {
      append(line, 'heading');
    } else {
      append(line);
    }
  }
  append(text.slice(RUN_LOG_LINE_LIMIT));
}
