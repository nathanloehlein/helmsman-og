import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function buildMeta(): { version: string; date: string } {
  const pkg = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  let date: string;
  try {
    date = execSync('git log -1 --format=%cs').toString().trim();
  } catch {
    date = new Date().toISOString().slice(0, 10);
  }
  return { version: pkg.version, date };
}
