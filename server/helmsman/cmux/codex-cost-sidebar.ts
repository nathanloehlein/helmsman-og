import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { COST_ESTIMATE_DATE } from '../cost-estimates.ts';
import { CodexCostUsageTracker, type CodexCostCheckpoint } from './codex-cost-usage.ts';

export const CODEX_COST_STATUS_PREFIX = 'helmsman-codex-cost-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE_BYTES = 1_048_576;
const MAX_READ_BYTES = 64 * 1_048_576;
const CACHE_VERSION = 1;

export interface CodexCostSidebarStatus {
  workspaceId: string;
  surfaceId: string;
  key: string;
  label: string;
}

export interface CodexCostSidebarReport {
  statuses: CodexCostSidebarStatus[];
  warnings: string[];
}

export interface CodexCostSidebarOptions {
  cmuxPath: string;
  stateDir: string;
  dryRun?: boolean;
  clear?: boolean;
  waitForLockMs?: number;
  runCmux?: (args: string[]) => Promise<string>;
}

interface Surface {
  workspaceId: string;
  surfaceId: string;
  ref: string;
}

interface Session extends Surface {
  sessionId: string;
  transcriptPath: string;
  updatedAt: number;
  running: boolean;
}

interface TranscriptCache {
  identity: string;
  offset: number;
  anchor: string;
  discardingLine: boolean;
  checkpoint: CodexCostCheckpoint;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runCommand(cmuxPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmuxPath, args, { timeout: 5_000, maxBuffer: 16 * 1_048_576, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error('cmux command failed'));
      else resolve(stdout);
    });
  });
}

function liveSurfaces(tree: unknown): { workspaces: string[]; surfaces: Map<string, Surface> } {
  const windows = object(tree)?.windows;
  if (!Array.isArray(windows)) throw new Error('Invalid workspace response');
  const workspaces = new Set<string>();
  const surfaces = new Map<string, Surface>();
  for (const window of windows) {
    const entries = object(window)?.workspaces;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const workspace = object(entry);
      const workspaceId = id(workspace?.id);
      if (!workspaceId) continue;
      workspaces.add(workspaceId);
      for (const pane of Array.isArray(workspace?.panes) ? workspace.panes : []) {
        const paneSurfaces = object(pane)?.surfaces;
        for (const raw of Array.isArray(paneSurfaces) ? paneSurfaces : []) {
          const surface = object(raw);
          const surfaceId = id(surface?.id);
          if (!surfaceId || surface?.type !== 'terminal') continue;
          const ref = typeof surface.ref === 'string' && /^surface:\d+$/.test(surface.ref) ? surface.ref : surfaceId.slice(0, 8);
          surfaces.set(surfaceId, { workspaceId, surfaceId, ref });
        }
      }
    }
  }
  return { workspaces: [...workspaces], surfaces };
}

function currentSessions(value: unknown, surfaces: Map<string, Surface>): Session[] {
  const rows = object(value)?.sessions;
  if (!Array.isArray(rows)) throw new Error('Invalid session response');
  const latest = new Map<string, Session>();
  for (const row of rows) {
    const record = object(row);
    const surfaceId = id(record?.surface_id);
    const surface = surfaceId ? surfaces.get(surfaceId) : undefined;
    const sessionId = id(record?.session_id);
    if (!surface || !sessionId || record?.agent !== 'codex') continue;
    const updatedAt = typeof record.updated_at === 'string' ? Date.parse(record.updated_at) : NaN;
    const transcriptPath = typeof record.transcript_path === 'string' ? record.transcript_path : '';
    const entry: Session = {
      ...surface, sessionId, transcriptPath,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      running: record.stored_pid_exists === true,
    };
    const previous = latest.get(surface.surfaceId);
    if (!previous || previous.updatedAt < entry.updatedAt) latest.set(surface.surfaceId, entry);
  }
  return [...latest.values()].filter(session => session.running);
}

async function anchorAt(file: FileHandle, offset: number): Promise<string> {
  const size = Math.min(offset, 128);
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await file.read(buffer, 0, size, offset - size);
  if (bytesRead !== size) throw new Error('Transcript changed');
  return digest(buffer);
}

function restoredCache(value: unknown): TranscriptCache | null {
  const cache = object(value);
  if (!cache || typeof cache.identity !== 'string' || !/^[a-f0-9]{64}$/.test(cache.identity)
    || typeof cache.anchor !== 'string' || !/^[a-f0-9]{64}$/.test(cache.anchor)
    || typeof cache.offset !== 'number' || !Number.isSafeInteger(cache.offset) || cache.offset < 0
    || typeof cache.discardingLine !== 'boolean') return null;
  const tracker = CodexCostUsageTracker.restore(cache.checkpoint);
  return tracker ? { identity: cache.identity, anchor: cache.anchor, offset: cache.offset,
    discardingLine: cache.discardingLine, checkpoint: tracker.checkpoint() } : null;
}

async function readTranscript(session: Session, cached: unknown): Promise<{ cache: TranscriptCache; label: string }> {
  if (!isAbsolute(session.transcriptPath) || !basename(session.transcriptPath).toLowerCase().endsWith(`-${session.sessionId}.jsonl`)) {
    throw new Error('Transcript unavailable');
  }
  const file = await open(session.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Transcript unavailable');
    const identity = digest(`${session.transcriptPath}\0${info.dev}\0${info.ino}\0${info.birthtimeMs}`);
    let previous = restoredCache(cached);
    if (previous && (previous.identity !== identity || previous.offset > info.size
      || await anchorAt(file, previous.offset) !== previous.anchor)) previous = null;
    const tracker = (previous ? CodexCostUsageTracker.restore(previous.checkpoint) : null) ?? new CodexCostUsageTracker();
    let offset = previous?.offset ?? 0;
    let position = offset;
    let discardingLine = previous?.discardingLine ?? false;
    let pending = Buffer.alloc(0);
    const buffer = Buffer.alloc(65_536);
    const end = Math.min(info.size, position + MAX_READ_BYTES);
    while (position < end) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position);
      if (!bytesRead) throw new Error('Transcript changed');
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.subarray(0, bytesRead).indexOf(10, start);
        const stop = newline < 0 ? bytesRead : newline;
        const segment = buffer.subarray(start, stop);
        if (!discardingLine && pending.length + segment.length > MAX_LINE_BYTES) {
          tracker.markIncomplete();
          discardingLine = true;
          pending = Buffer.alloc(0);
        }
        if (!discardingLine) pending = Buffer.concat([pending, segment]);
        if (newline >= 0) {
          if (!discardingLine) tracker.consumeLine(pending.toString('utf8'));
          pending = Buffer.alloc(0);
          discardingLine = false;
          offset = position + newline + 1;
          start = newline + 1;
        } else {
          if (discardingLine) offset = position + bytesRead;
          break;
        }
      }
      position += bytesRead;
    }
    const after = await file.stat();
    if (after.size < info.size) throw new Error('Transcript changed');
    const summary = tracker.summary();
    const label = end < info.size ? `Codex ${session.ref} · estimating…`
      : summary.estimatedCostUsd === null ? `Codex ${session.ref} · cost unavailable`
      : `Codex ${session.ref} · ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(summary.estimatedCostUsd)} est${summary.coverage === 'partial' ? ' (partial)' : ''}`;
    return { cache: { identity, offset, discardingLine, anchor: await anchorAt(file, offset), checkpoint: tracker.checkpoint() }, label };
  } finally {
    await file.close();
  }
}

async function readCache(path: string): Promise<Record<string, unknown>> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 4 * 1_048_576) return {};
    const cache = object(JSON.parse(await readFile(path, 'utf8')));
    return cache?.version === CACHE_VERSION && cache.ratesAsOf === COST_ESTIMATE_DATE ? object(cache.sessions) ?? {} : {};
  } catch {
    return {};
  }
}

async function acquireLock(path: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8').catch(() => ''));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        const info = await stat(path).catch(() => null);
        if (!info || Date.now() - info.mtimeMs < 60_000) return null;
      } else {
        try { process.kill(pid, 0); return null; } catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code !== 'ESRCH') return null;
        }
      }
      await rm(path, { force: true });
    }
  }
  return null;
}

export async function refreshCodexCostSidebar(options: CodexCostSidebarOptions): Promise<CodexCostSidebarReport> {
  const report: CodexCostSidebarReport = { statuses: [], warnings: [] };
  const run = options.runCmux ?? ((args: string[]) => runCommand(options.cmuxPath, args));
  let release: (() => Promise<void>) | null = null;
  try {
    if (!options.dryRun) {
      await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
      const requestedWait = options.waitForLockMs ?? (options.clear ? 30_000 : 0);
      const waitMs = Number.isFinite(requestedWait) ? Math.min(30_000, Math.max(0, requestedWait)) : 0;
      const deadline = performance.now() + waitMs;
      do {
        release = await acquireLock(join(options.stateDir, 'refresh.lock'));
        if (release) break;
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await delay(Math.min(100, remaining));
      } while (true);
      if (!release) return { statuses: [], warnings: [waitMs > 0
        ? 'Timed out waiting for the active cost refresh; requested refresh was not completed.'
        : 'A cost refresh is already running.'] };
    }
    const [treeResult, sessionResult] = await Promise.allSettled([
      run(['--json', '--id-format', 'both', 'tree', '--all']).then(output => JSON.parse(output) as unknown),
      run(['--json', 'sessions', 'list', '--agent', 'codex', '--all']).then(output => JSON.parse(output) as unknown),
    ]);
    if (treeResult.status === 'rejected') return { statuses: [], warnings: ['cmux workspaces unavailable; estimates were not refreshed.'] };
    const { workspaces, surfaces } = liveSurfaces(treeResult.value);
    let sessions: Session[] = [];
    try {
      if (sessionResult.status !== 'fulfilled') throw new Error('Sessions unavailable');
      sessions = options.clear ? [] : currentSessions(sessionResult.value, surfaces);
    } catch {
      report.warnings.push('Codex sessions unavailable; previous cost statuses will be cleared.');
    }
    const cachePath = join(options.stateDir, 'usage-cache.json');
    const cache = await readCache(cachePath);
    const updatedCache: Record<string, TranscriptCache> = {};
    for (const session of sessions) {
      const key = `${CODEX_COST_STATUS_PREFIX}${session.surfaceId}`;
      const cacheKey = `${session.surfaceId}:${session.sessionId}`;
      let label = `Codex ${session.ref} · cost unavailable`;
      try {
        const result = await readTranscript(session, cache[cacheKey]);
        updatedCache[cacheKey] = result.cache;
        label = result.label;
      } catch {
        report.warnings.push(`Codex ${session.ref} transcript unavailable; no cost inferred.`);
      }
      const status = { workspaceId: session.workspaceId, surfaceId: session.surfaceId, key, label };
      if (!options.dryRun) {
        try {
          await run(['set-status', key, label, '--workspace', session.workspaceId, '--icon', 'dollarsign.circle', '--priority', '20']);
        } catch {
          report.warnings.push(`Codex ${session.ref} status could not be updated.`);
          continue;
        }
      }
      report.statuses.push(status);
    }
    if (!options.dryRun) {
      for (const workspaceId of workspaces) {
        try {
          const output = await run(['list-status', '--workspace', workspaceId]);
          for (const line of output.split('\n')) {
            const key = line.split('=', 1)[0] ?? '';
            if (!key.startsWith(CODEX_COST_STATUS_PREFIX) || !UUID.test(key.slice(CODEX_COST_STATUS_PREFIX.length))) continue;
            if (report.statuses.some(status => status.workspaceId === workspaceId && status.key === key)) continue;
            await run(['clear-status', key, '--workspace', workspaceId]);
          }
        } catch {
          report.warnings.push('Some previous cost statuses could not be cleared.');
        }
      }
      const temporary = `${cachePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, ratesAsOf: COST_ESTIMATE_DATE, sessions: updatedCache }), { mode: 0o600, flag: 'wx' });
        await rename(temporary, cachePath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  } catch {
    report.warnings.push('Cost refresh unavailable; no billing amount was inferred.');
  } finally {
    await release?.().catch(() => {});
  }
  return report;
}
