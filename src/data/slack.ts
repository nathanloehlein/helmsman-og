export interface SlackHealth {
  enabled: boolean;
  status: 'disabled' | 'healthy' | 'scanning' | 'partial' | 'unavailable';
  channelName: string;
  intervalMs: number;
  lastSuccessAt: string | null;
  error: string | null;
}

export interface SlackNotification {
  id: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  sourceUrl: string;
  author: string;
  channelName: string;
  status: 'queued' | 'launched' | 'failed' | 'blocked';
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  error: string | null;
  model?: string | null;
  effort?: string | null;
  complexity?: 'low' | 'medium' | 'high' | null;
}

export interface SlackState {
  health: SlackHealth;
  githubHealth?: SlackHealth;
  notifications: SlackNotification[];
}

export const unavailableSlack = (): SlackState => ({
  health: { enabled: false, status: 'unavailable', channelName: '', intervalMs: 300_000, lastSuccessAt: null, error: 'Slack reader unavailable.' },
  notifications: [],
});

const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalTimestamp = (value: unknown): boolean => value === null || timestamp(value);
const optionalString = (value: unknown): boolean => value == null || typeof value === 'string';

function validHealth(value: unknown): value is SlackHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<SlackHealth>;
  return typeof health.enabled === 'boolean'
    && ['disabled', 'healthy', 'scanning', 'partial', 'unavailable'].includes(health.status ?? '')
    && typeof health.channelName === 'string' && typeof health.intervalMs === 'number'
    && Number.isFinite(health.intervalMs) && health.intervalMs > 0 && optionalTimestamp(health.lastSuccessAt)
    && (health.error === null || typeof health.error === 'string');
}

export function safeSlackUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.hostname.endsWith('.slack.com') && /^\/archives\/[A-Z0-9]+\/p\d+/.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

export function safePrUrl(value: unknown, repo: string, number: number): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port
      && url.pathname === `/${repo}/pull/${number}` ? url.href : null;
  } catch { return null; }
}

function notification(value: unknown): SlackNotification | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SlackNotification>;
  if (typeof item.id !== 'string' || !item.id || typeof item.repo !== 'string'
    || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(item.repo) || ['.', '..'].includes(item.repo.split('/')[1] ?? '')
    || typeof item.prNumber !== 'number' || !Number.isSafeInteger(item.prNumber) || item.prNumber < 1
    || !safePrUrl(item.prUrl, item.repo, item.prNumber) || typeof item.sourceUrl !== 'string'
    || typeof item.author !== 'string' || typeof item.channelName !== 'string'
    || !['queued', 'launched', 'failed', 'blocked'].includes(item.status ?? '')
    || !(item.runId === null || typeof item.runId === 'string' && /^[a-z\d_-]{1,128}$/i.test(item.runId))
    || !timestamp(item.createdAt) || !timestamp(item.updatedAt) || !optionalTimestamp(item.readAt)
    || !(item.error === null || typeof item.error === 'string')
    || !optionalString(item.model) || !optionalString(item.effort)
    || !(item.complexity == null || ['low', 'medium', 'high'].includes(item.complexity))) return null;
  return item as SlackNotification;
}

export async function fetchSlack(): Promise<SlackState | null> {
  try {
    const response = await fetch('/api/slack', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') return null;
    const data = payload as Partial<SlackState>;
    const health = data.health;
    if (!validHealth(health) || data.githubHealth !== undefined && !validHealth(data.githubHealth)
      || !Array.isArray(data.notifications)) return null;
    const notifications = data.notifications.map(notification).filter((item): item is SlackNotification => item !== null);
    return {
      health: notifications.length === data.notifications.length ? health : { ...health, status: 'partial', error: 'Some notifications could not be loaded.' },
      ...(data.githubHealth ? { githubHealth: data.githubHealth } : {}),
      notifications,
    };
  } catch { return null; }
}

export async function markSlackNotificationRead(id: string): Promise<boolean> {
  if (!id) return false;
  try {
    const response = await fetch(`/api/slack/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    return Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === true);
  } catch { return false; }
}
