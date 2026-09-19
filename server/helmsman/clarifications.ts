import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Clarification, ClarificationOwner, ClarificationState, TrustedContact } from '../../src/data/clarifications';
import { selectTrustedContact } from './contact-policy';

export const MAX_CLARIFICATION_PROTOCOL_LINE_BYTES = 16 * 1024;
export const MAX_CLARIFICATIONS_PER_RUN = 32;

const clarificationOwners = new Set<ClarificationOwner>(['local', 'trusted-contact']);

export class ClarificationValidationError extends Error {}

export interface ClarificationQuestionRecord {
  kind: 'question';
  id: string;
  required: boolean;
  prompt: string;
  owner: ClarificationOwner;
  timeoutAt?: string;
}

export interface ClarificationAnswerRecord {
  kind: 'answer';
  id: string;
  answer: string;
  answeredAt: string;
}

interface RunReference {
  repo: string;
  status: string;
  taskJson?: string | null;
}

interface ClarificationRow extends Omit<Clarification, 'required'> {
  required: number;
}

interface TrustedContactRow extends Omit<TrustedContact, 'enabled'> {
  enabled: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(value)) {
    throw new ClarificationValidationError(`Invalid ${label}`);
  }
  return value;
}

function requiredText(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string') throw new ClarificationValidationError(`Invalid ${label}`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new ClarificationValidationError(`Invalid ${label}`);
  return trimmed;
}

function optionalTime(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ClarificationValidationError('Invalid timeout');
  }
  return new Date(value).toISOString();
}

function toClarification(row: ClarificationRow): Clarification {
  return { ...row, required: row.required === 1 };
}

function toTrustedContact(row: TrustedContactRow): TrustedContact {
  return { ...row, enabled: row.enabled === 1 };
}

export function parseClarificationQuestionLine(line: string): ClarificationQuestionRecord {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_CLARIFICATION_PROTOCOL_LINE_BYTES) {
    throw new ClarificationValidationError('Clarification protocol line is too large');
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ClarificationValidationError('Invalid clarification protocol JSON');
  }
  if (!isRecord(value) || value.kind !== 'question') {
    throw new ClarificationValidationError('Invalid question record');
  }
  if (typeof value.required !== 'boolean') {
    throw new ClarificationValidationError('Invalid required flag');
  }

  const owner = value.owner ?? 'local';
  if (!clarificationOwners.has(owner as ClarificationOwner)) {
    throw new ClarificationValidationError('Invalid owner');
  }

  const timeoutAt = optionalTime(value.timeoutAt);
  return {
    kind: 'question',
    id: validId(value.id, 'question ID'),
    prompt: requiredText(value.prompt, 'question'),
    required: value.required,
    owner: owner as ClarificationOwner,
    ...(timeoutAt ? { timeoutAt } : {}),
  };
}

export interface ClarificationStore {
  list(repo?: string | null): Clarification[];
  listForRun(runId: string): Clarification[];
  ingestQuestion(runId: string, record: unknown): Clarification;
  answer(id: string, input: unknown): Clarification;
  hasRequiredPending(runId: string): boolean;
  hasRequiredTimedOut(runId: string): boolean;
  hasRequiredUnanswered(runId: string): boolean;
  timeoutDue(now?: string): number;
  cancelForRun(runId: string): number;
  cleanupOrphans(runIds?: Iterable<string>): number;
  contacts(): TrustedContact[];
  defaultContact(): TrustedContact | null;
  saveContact(input: unknown): TrustedContact;
  close(): void;
}

export function openClarificationStore(
  path: string,
  deps: { getRun(runId: string): RunReference | null },
  now: () => string = () => new Date().toISOString(),
): ClarificationStore {
  const sql = new Database(path);
  sql.pragma('journal_mode = WAL');
  sql.exec(`
    CREATE TABLE IF NOT EXISTS clarifications (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL, repo TEXT NOT NULL, question TEXT NOT NULL,
      required INTEGER NOT NULL, owner TEXT NOT NULL, contactId TEXT, state TEXT NOT NULL,
      answer TEXT, createdAt TEXT NOT NULL, timeoutAt TEXT, answeredAt TEXT
    );
    CREATE TABLE IF NOT EXISTS trusted_contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL,
      enabled INTEGER NOT NULL, createdAt TEXT NOT NULL
    );
  `);

  const readQuestion = sql.prepare('SELECT * FROM clarifications WHERE id = ?');
  const getQuestion = (id: string): Clarification | null => {
    const row = readQuestion.get(id) as ClarificationRow | undefined;
    return row ? toClarification(row) : null;
  };
  const hasRequiredWithState = (id: string, state: ClarificationState): boolean => Boolean(
    sql.prepare('SELECT 1 FROM clarifications WHERE runId = ? AND required = 1 AND state = ?').get(validId(id, 'run ID'), state),
  );
  const getDefaultContact = (): TrustedContact | null => {
    const row = sql.prepare('SELECT * FROM trusted_contacts WHERE enabled = 1 ORDER BY name, id LIMIT 1').get() as TrustedContactRow | undefined;
    return row ? toTrustedContact(row) : null;
  };

  return {
    list(repo = null) {
      const rows = repo
        ? sql.prepare('SELECT * FROM clarifications WHERE repo = ? COLLATE NOCASE ORDER BY createdAt DESC').all(repo)
        : sql.prepare('SELECT * FROM clarifications ORDER BY createdAt DESC').all();
      return (rows as ClarificationRow[]).map(toClarification);
    },
    listForRun(run) {
      const rows = sql.prepare('SELECT * FROM clarifications WHERE runId = ? ORDER BY createdAt DESC').all(validId(run, 'run ID')) as ClarificationRow[];
      return rows.map(toClarification);
    },
    ingestQuestion(run, record) {
      const id = validId(run, 'run ID');
      const boundRun = deps.getRun(id);
      if (!boundRun || boundRun.status !== 'running') {
        throw new ClarificationValidationError('Run is not active');
      }
      if (!isRecord(record) || record.kind !== 'question') {
        throw new ClarificationValidationError('Invalid question record');
      }
      const question = parseClarificationQuestionLine(JSON.stringify(record));
      const existing = getQuestion(question.id);
      if (existing) {
        if (existing.runId !== id) throw new ClarificationValidationError('Question ID belongs to another run');
        if (existing.question !== question.prompt
          || existing.required !== question.required
          || existing.timeoutAt !== (question.timeoutAt ?? null)) {
          throw new ClarificationValidationError('Question ID conflicts with existing clarification');
        }
        return existing;
      }

      const questionCount = sql.prepare('SELECT COUNT(*) AS count FROM clarifications WHERE runId = ?').get(id) as { count: number };
      if (questionCount.count >= MAX_CLARIFICATIONS_PER_RUN) {
        throw new ClarificationValidationError('Too many clarifications for run');
      }

      let hints: Record<string, unknown> = {};
      try { const task = boundRun.taskJson ? JSON.parse(boundRun.taskJson) : null; hints = isRecord(task) && isRecord(task.contactHints) ? task.contactHints : {}; } catch {}
      const contacts = (sql.prepare('SELECT * FROM trusted_contacts').all() as TrustedContactRow[]).map(toTrustedContact);
      const selectedId = question.owner === 'trusted-contact' ? selectTrustedContact(contacts.map(contact => ({ ...contact, identifiers: [contact.id, contact.address] })), {
        explicitContactId: typeof hints.explicitContactId === 'string' ? hints.explicitContactId : undefined,
        assigneeId: typeof hints.assigneeId === 'string' ? hints.assigneeId : undefined,
        reporterId: typeof hints.reporterId === 'string' ? hints.reporterId : undefined,
        defaultContactId: getDefaultContact()?.id,
      }) : null;
      const contact = selectedId ? contacts.find(item => item.id === selectedId) ?? null : null;
      const owner: ClarificationOwner = contact ? 'trusted-contact' : 'local';
      sql.prepare(`INSERT INTO clarifications
        (id, runId, repo, question, required, owner, contactId, state, answer, createdAt, timeoutAt, answeredAt)
        VALUES (@id, @runId, @repo, @question, @required, @owner, @contactId, 'pending', NULL, @createdAt, @timeoutAt, NULL)`)
        .run({
          id: question.id,
          runId: id,
          repo: boundRun.repo,
          question: question.prompt,
          required: question.required ? 1 : 0,
          owner,
          contactId: contact?.id ?? null,
          createdAt: now(),
          timeoutAt: question.timeoutAt ?? null,
        });
      return getQuestion(question.id)!;
    },
    answer(id, input) {
      const clarificationId = validId(id, 'clarification ID');
      const answer = requiredText(isRecord(input) ? input.answer : undefined, 'answer');
      const current = getQuestion(clarificationId);
      if (!current) throw new ClarificationValidationError('Clarification not found');
      if (current.state !== 'pending') throw new ClarificationValidationError('Clarification is no longer pending');
      const run = deps.getRun(current.runId);
      if (!run || run.status !== 'running') {
        sql.prepare("UPDATE clarifications SET state = 'cancelled' WHERE id = ? AND state = 'pending'").run(clarificationId);
        throw new ClarificationValidationError('Run is not active');
      }
      const answeredAt = optionalTime(now())!;
      if (current.timeoutAt && current.timeoutAt <= answeredAt) {
        sql.prepare("UPDATE clarifications SET state = 'timed-out' WHERE id = ? AND state = 'pending'").run(clarificationId);
        throw new ClarificationValidationError('Clarification has timed out');
      }
      const update = sql.prepare("UPDATE clarifications SET state = 'answered', answer = ?, answeredAt = ? WHERE id = ? AND state = 'pending'")
        .run(answer, answeredAt, clarificationId);
      if (update.changes !== 1) throw new ClarificationValidationError('Clarification is no longer pending');
      return getQuestion(clarificationId)!;
    },
    hasRequiredPending(run) { return hasRequiredWithState(run, 'pending'); },
    hasRequiredTimedOut(run) { return hasRequiredWithState(run, 'timed-out'); },
    hasRequiredUnanswered(run) {
      return hasRequiredWithState(run, 'pending')
        || hasRequiredWithState(run, 'timed-out')
        || hasRequiredWithState(run, 'cancelled');
    },
    timeoutDue(at = now()) {
      return sql.prepare("UPDATE clarifications SET state = 'timed-out' WHERE state = 'pending' AND timeoutAt IS NOT NULL AND timeoutAt <= ?")
        .run(optionalTime(at) ?? at).changes;
    },
    cancelForRun(run) {
      return sql.prepare("UPDATE clarifications SET state = 'cancelled' WHERE runId = ? AND state = 'pending'")
        .run(validId(run, 'run ID')).changes;
    },
    cleanupOrphans(runIds) {
      const known = runIds ? new Set(runIds) : null;
      const pending = sql.prepare("SELECT id, runId FROM clarifications WHERE state = 'pending'").all() as Array<{ id: string; runId: string }>;
      const cancel = sql.prepare("UPDATE clarifications SET state = 'cancelled' WHERE id = ? AND state = 'pending'");
      let count = 0;
      for (const clarification of pending) {
        const run = deps.getRun(clarification.runId);
        if ((known && !known.has(clarification.runId)) || !run || run.status !== 'running') {
          count += cancel.run(clarification.id).changes;
        }
      }
      return count;
    },
    contacts() {
      return (sql.prepare('SELECT * FROM trusted_contacts ORDER BY name, id').all() as TrustedContactRow[]).map(toTrustedContact);
    },
    defaultContact: getDefaultContact,
    saveContact(input) {
      if (!isRecord(input)) throw new ClarificationValidationError('Contact must be an object');
      const id = typeof input.id === 'string' ? validId(input.id, 'contact ID') : randomUUID();
      const value = {
        id,
        name: requiredText(input.name, 'contact name', 160),
        address: requiredText(input.address, 'contact address', 320),
        enabled: input.enabled !== false ? 1 : 0,
        createdAt: now(),
      };
      sql.prepare(`INSERT INTO trusted_contacts (id, name, address, enabled, createdAt)
        VALUES (@id, @name, @address, @enabled, @createdAt)
        ON CONFLICT(id) DO UPDATE SET name = @name, address = @address, enabled = @enabled`)
        .run(value);
      const row = sql.prepare('SELECT * FROM trusted_contacts WHERE id = ?').get(id) as TrustedContactRow;
      return toTrustedContact(row);
    },
    close() { sql.close(); },
  };
}
