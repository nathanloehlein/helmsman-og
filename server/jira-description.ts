function nodeText(value: unknown, depth: number): string {
  if (depth > 40 || !value || typeof value !== 'object' || Array.isArray(value)) return '';
  const node = value as Record<string, unknown>;
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak') return '\n';
  const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs as Record<string, unknown> : {};
  if (node.type === 'mention') return typeof attrs.text === 'string' ? attrs.text : '';
  if (node.type === 'emoji') return typeof attrs.text === 'string' ? attrs.text : typeof attrs.shortName === 'string' ? attrs.shortName : '';
  if (node.type === 'inlineCard') return typeof attrs.url === 'string' ? attrs.url : '';
  const content = Array.isArray(node.content) ? node.content.map(child => nodeText(child, depth + 1)).join('') : '';
  if (node.type === 'listItem') return `• ${content.trim()}\n`;
  if (node.type === 'tableCell' || node.type === 'tableHeader') return `${content.trim()}\t`;
  return ['paragraph', 'heading', 'codeBlock', 'blockquote', 'tableRow'].includes(String(node.type)) ? `${content}\n` : content;
}

export function jiraDescription(value: unknown): string {
  return (typeof value === 'string' ? value : nodeText(value, 0)).trim();
}
