import { describe, expect, it } from 'vitest';
import { appendHighlightedLog } from './logHighlight';

function render(text: string, kind = 'log'): HTMLDivElement {
  const target = document.createElement('div');
  appendHighlightedLog(target, text, kind);
  expect(target.textContent).toBe(text);
  return target;
}

describe('voyage log highlighting', () => {
  it('preserves untrusted markup, escapes, tabs and whitespace without creating active HTML', () => {
    const text = '\t{"html": "<img src=x onerror=alert(1)>", "quote": "a\\"b", "count": 42, "ok": true}\n  ';
    const target = render(text);
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelector('.log-token-key')?.textContent).toBe('"html"');
    expect(target.querySelector('.log-token-string')?.textContent).toContain('<img');
    expect(target.querySelector('.log-token-number')?.textContent).toBe('42');
    expect(target.querySelector('.log-token-keyword')?.textContent).toBe('true');
    expect([...target.children].every(child => child.tagName === 'SPAN')).toBe(true);
  });

  it('recognizes actual Claude tool lines and Codex shell commands', () => {
    for (const text of ['  npm test --run src/main.test.ts', 'Bash: npm test --run src/main.test.ts', '/bin/zsh -lc \'git diff --stat\'', '$ git diff -- src/main.ts']) {
      const target = render(text, text.startsWith('Bash') ? 'tool' : 'log');
      expect(target.querySelector('.log-token-command')).not.toBeNull();
    }
    const tool = render('Read: /tmp/review.json', 'tool');
    expect(tool.querySelector('.log-token-command')?.textContent).toBe('Read:');
    expect(tool.querySelector('.log-token-path')?.textContent).toBe('/tmp/review.json');
  });

  it('highlights fenced code and diff, while keeping surrounding prose plain', () => {
    const target = render('Please return to the first class.\n```ts\nconst label = "boat";\nreturn 2; // count\n```\nThat is the result.\n```diff\n@@ -1 +1 @@\n- old value\n+ new value\n```');
    expect(target.querySelector('.log-token-keyword')?.textContent).toBe('const');
    expect(target.querySelector('.log-token-deletion')?.textContent).toBe('- old value\n');
    expect(target.querySelector('.log-token-addition')?.textContent).toBe('+ new value\n');
    expect(target.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(render('return to the first class and try again').children).toHaveLength(0);
  });

  it('keeps error output plain for severity coloring', () => {
    for (const kind of ['error', 'stderr']) {
      expect(render('{"error": "invalid input", "code": 403}', kind).children).toHaveLength(0);
    }
  });

  it('bounds token nodes for dense and oversized events without losing any text', () => {
    for (const text of ['{"a":1,'.repeat(1200), '```ts\n' + 'true '.repeat(800) + '\n```']) {
      const target = render(text);
      expect(target.children.length).toBeLessThanOrEqual(128);
      expect(target.childNodes.length).toBeLessThanOrEqual(257);
    }
  });

  it('leaves unsupported fenced languages uncolored and tolerates incomplete strings', () => {
    expect(render('```unknown\nconst x = 2\n```').querySelector('.log-token-keyword')).toBeNull();
    render('{"value": "unterminated \\');
    render('');
  });
});
