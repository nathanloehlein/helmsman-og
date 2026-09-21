import { describe, expect, it } from 'vitest';
import { jiraDescription } from './jira-description';

describe('jiraDescription', () => {
  it.each([null, undefined, {}, 42, { content: [null, false] }])('handles missing or malformed descriptions: %j', value => {
    expect(jiraDescription(value)).toBe('');
  });
  it('preserves paragraph, list, code and line boundaries from Jira rich text', () => {
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    expect(jiraDescription({ type: 'doc', content: [paragraph('Steps'), { type: 'bulletList', content: [
      { type: 'listItem', content: [paragraph('Open settings')] },
      { type: 'listItem', content: [paragraph('Save')] },
    ] }, { type: 'codeBlock', content: [{ type: 'text', text: 'a < b' }] }] })).toBe('Steps\n• Open settings\n• Save\na < b');
  });
  it('preserves plain text', () => expect(jiraDescription('  Hello\nworld ')).toBe('Hello\nworld'));
});
