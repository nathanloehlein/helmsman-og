const REPO_KEY = 'runner.repoScope';
const CONFIG_COLLAPSED_KEY = 'runner.configCollapsed';

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
