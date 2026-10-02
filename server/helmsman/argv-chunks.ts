/** Long individual script arguments can be killed before Node starts on macOS. */
export function chunkArgument(value: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (chunk.length + character.length > 256) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function joinArgumentChunks(argv: string[]): string {
  return argv.join('');
}
