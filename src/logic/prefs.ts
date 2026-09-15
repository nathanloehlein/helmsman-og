const REPO_KEY = 'runner.repoScope';
const CONFIG_COLLAPSED_KEY = 'runner.configCollapsed';
const RACK_LAYOUT_KEY = 'gomaestro.rackLayout';
const COLLAPSED_KEY = 'gomaestro.collapsed';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
}

export function loadRepoScope(): string | null {
  const value: string | null = safeGet(REPO_KEY);
  return value && value.length > 0 ? value : null;
}

export function saveRepoScope(repo: string | null): void {
  if (repo) safeSet(REPO_KEY, repo);
  else safeRemove(REPO_KEY);
}

export function loadConfigCollapsed(): boolean {
  return safeGet(CONFIG_COLLAPSED_KEY) === '1';
}

export function saveConfigCollapsed(collapsed: boolean): void {
  safeSet(CONFIG_COLLAPSED_KEY, collapsed ? '1' : '0');
}

export function loadRackLayoutRaw(): string | null {
  return safeGet(RACK_LAYOUT_KEY);
}

export function saveRackLayoutRaw(raw: string): void {
  safeSet(RACK_LAYOUT_KEY, raw);
}

export function loadCollapsed(): Set<string> {
  const raw: string | null = safeGet(COLLAPSED_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function saveCollapsed(ids: Set<string>): void {
  safeSet(COLLAPSED_KEY, JSON.stringify([...ids]));
}
