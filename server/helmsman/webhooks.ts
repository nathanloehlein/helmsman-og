import Database from 'better-sqlite3';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookRoute { repo: string; event: string; action: string; workflowRef: 'coding@1' | 'review@1' }
export interface WebhookLaunch { repo: string; workflowRef: string; runId: string; mode: 'freeform' | 'review'; title: string; task?: string; prNumber?: number }
export class WebhookError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function parseWebhookRoutes(value: string | undefined): WebhookRoute[] {
  if (!value) return [];
  const routes: unknown = JSON.parse(value);
  if (!Array.isArray(routes) || routes.length > 100) throw new Error('Invalid webhook routes');
  return routes.map(value => {
    const route = record(value);
    if (!route || typeof route.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(route.repo)
      || !['issues', 'pull_request'].includes(String(route.event)) || typeof route.action !== 'string'
      || !['opened', 'labeled', 'synchronize', 'review_requested', 'reopened'].includes(route.action)
      || (route.event === 'issues' ? route.workflowRef !== 'coding@1' : route.workflowRef !== 'review@1')) throw new Error('Invalid webhook workflow mapping');
    return route as unknown as WebhookRoute;
  });
}
export function openWebhookIntake(path: string, deps: {
  secret(): string | undefined;
  routes(): WebhookRoute[];
  allowedRepos(): string[];
  canStart(repo: string): boolean;
  getRun(id: string): { status: string } | null;
  isRunActive(id: string): boolean;
  launch(input: WebhookLaunch): string;
  now?: () => number;
}) {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery TEXT PRIMARY KEY, digest TEXT NOT NULL, runId TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL, state TEXT NOT NULL, claimedAt INTEGER, error TEXT
  )`);
  const now = deps.now ?? Date.now;
  let polling: Promise<void> | null = null;
  async function scan(): Promise<void> {
    const pending = sql.prepare("SELECT * FROM webhook_deliveries WHERE state IN ('pending','dispatching') ORDER BY rowid LIMIT 100").all() as Array<{ delivery: string; payload: string; runId: string; claimedAt: number | null; state: string }>;
    for (const item of pending) {
      if (deps.getRun(item.runId)) {
        sql.prepare("UPDATE webhook_deliveries SET state = 'launched' WHERE delivery = ?").run(item.delivery); continue;
      }
      if (deps.isRunActive(item.runId)) continue;
      const input = JSON.parse(item.payload) as WebhookLaunch;
      if (item.state === 'dispatching' && now() - (item.claimedAt ?? 0) < 60000) continue;
      if (!deps.allowedRepos().some(repo => repo.toLowerCase() === input.repo.toLowerCase())) {
        sql.prepare("UPDATE webhook_deliveries SET state = 'rejected', error = 'Galleon no longer configured' WHERE delivery = ?").run(item.delivery); continue;
      }
      if (!deps.canStart(input.repo)) continue;
      const claimed = sql.prepare("UPDATE webhook_deliveries SET state = 'dispatching', claimedAt = ? WHERE delivery = ? AND (state = 'pending' OR (state = 'dispatching' AND claimedAt <= ?))").run(now(), item.delivery, now() - 60000);
      if (!claimed.changes) continue;
      try {
        if (deps.launch(input) !== item.runId) throw new Error('Webhook launcher returned a different run ID');
        if (deps.getRun(item.runId)) sql.prepare("UPDATE webhook_deliveries SET state = 'launched', error = NULL WHERE delivery = ?").run(item.delivery);
      } catch (error) {
        sql.prepare('UPDATE webhook_deliveries SET error = ? WHERE delivery = ?').run(String(error).slice(0, 2000), item.delivery);
      }
    }
  }
  return {
    receive(raw: Buffer, headers: { signature?: string; delivery?: string; event?: string }) {
      const secret = deps.secret();
      if (!secret || !deps.routes().length) throw new WebhookError('Webhook intake is disabled', 503);
      if (raw.length > 1_000_000) throw new WebhookError('Webhook payload too large', 413);
      const signature = headers.signature;
      if (!signature || !/^sha256=[a-f\d]{64}$/i.test(signature)) throw new WebhookError('Invalid webhook signature', 401);
      const expected = createHmac('sha256', secret).update(raw).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) throw new WebhookError('Invalid webhook signature', 401);
      if (!headers.delivery || !/^[a-z\d_-]{1,128}$/i.test(headers.delivery)) throw new WebhookError('Invalid delivery ID');
      const digest = createHash('sha256').update(raw).digest('hex');
      const prior = sql.prepare('SELECT digest, runId FROM webhook_deliveries WHERE delivery = ?').get(headers.delivery) as { digest: string; runId: string } | undefined;
      if (prior) {
        if (prior.digest !== digest) throw new WebhookError('Delivery ID reused for a different payload', 409);
        return { runId: prior.runId, duplicate: true };
      }
      let body: Record<string, unknown> | null;
      try { body = record(JSON.parse(raw.toString('utf8'))); } catch { throw new WebhookError('Invalid webhook JSON'); }
      const repo = record(body?.repository)?.full_name;
      const route = deps.routes().find(route => route.repo.toLowerCase() === String(repo).toLowerCase() && route.event === headers.event && route.action === body?.action);
      if (!route || !deps.allowedRepos().some(repo => repo.toLowerCase() === route.repo.toLowerCase())) throw new WebhookError('No configured workflow for this event', 422);
      const entity = record(route.event === 'issues' ? body?.issue : body?.pull_request);
      if (!entity || typeof entity.title !== 'string' || entity.title.length > 1000 || !Number.isSafeInteger(entity.number) || Number(entity.number) < 1) throw new WebhookError('Invalid webhook task');
      const runId = `wh-${createHash('sha256').update(headers.delivery).digest('hex')}`;
      const input: WebhookLaunch = { repo: route.repo, workflowRef: route.workflowRef, runId, title: entity.title,
        ...(route.workflowRef === 'review@1' ? { mode: 'review', prNumber: Number(entity.number) }
          : { mode: 'freeform', task: `${entity.title}\n\n${typeof entity.body === 'string' ? entity.body.slice(0, 100000) : ''}` }) };
      sql.prepare("INSERT INTO webhook_deliveries (delivery,digest,runId,payload,state) VALUES (?,?,?,?,'pending')")
        .run(headers.delivery, digest, runId, JSON.stringify(input));
      return { runId, duplicate: false };
    },
    poll(): Promise<void> { polling ??= scan().finally(() => { polling = null; }); return polling; },
    status() { return sql.prepare('SELECT delivery, runId, state, error FROM webhook_deliveries ORDER BY rowid DESC LIMIT 100').all(); },
    close() { sql.close(); },
  };
}
