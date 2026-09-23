import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PrePrSettings } from '../../src/logic/prePrSettings';
import type { AgentTask } from './agents/adapter';
import { codexSettings } from './agent-attribution';
import { hashSkillDirectory, installVerifiedSkills, preflightSkills, type VerifiedSkill } from './skills-preflight';
import { openWorkflowStore, type FixedWorkflowId, type SkillDeclaration, type WorkflowStore } from './workflow-snapshots';

export interface PrepareExecutionInput {
  runId: string;
  runsDir: string;
  workflowDbPath: string;
  task: AgentTask;
  workflow: FixedWorkflowId;
  reviewSettings: PrePrSettings;
  model?: string;
  effort?: string;
  provider?: 'codex' | 'claude-code';
  skills?: readonly string[];
  skillsRoots?: readonly string[];
  store?: WorkflowStore;
  allowPromptUpgrade?: boolean;
}

export interface PreparedExecution {
  task: AgentTask & { workflowSnapshotId: string; skillsPath: string; promptRevision: string };
  snapshotId: string;
  skills: VerifiedSkill[];
  reviewSettings: PrePrSettings;
  model?: string;
  effort?: string;
}

const HASH = /^[a-f\d]{64}$/i;

async function existing(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

export function defaultSkillsRoots(cwd = process.cwd()): string[] {
  return [join(cwd, '.codex', 'skills'), join(cwd, '.claude', 'skills'), join(cwd, '.agents', 'skills'),
    join(homedir(), '.codex', 'skills'), join(homedir(), '.codex', 'skills', '.system'), join(homedir(), '.claude', 'skills'), join(homedir(), '.agents', 'skills')];
}

async function promptCodeHash(): Promise<string> {
  const hash = createHash('sha256');
  for (const path of ['server/helmsman/agent-attribution.ts', 'server/helmsman/gocaas.ts', 'server/helmsman/gocaas-cli.ts', 'server/helmsman/agents/prompt.ts', 'server/helmsman/agents/review-calibration.ts', 'server/helmsman/agents/clarification-prompt.ts', 'server/helmsman/agents/pre-pr-prompt.ts', 'server/helmsman/agents/pre-pr.ts', 'server/helmsman/pre-pr-workflow.ts', 'server/helmsman/pre-pr-runtime.ts', 'server/helmsman/docker-stage.ts', 'server/helmsman/docker-review-cli.ts', 'server/helmsman/docker-gateway-relay.mjs', 'server/helmsman/agents/docker-review.ts']) {
    hash.update(path).update('\0').update(await readFile(resolve(process.cwd(), path))).update('\0');
  }
  return hash.digest('hex');
}

async function declarations(names: readonly string[], roots: readonly string[]): Promise<{ declarations: SkillDeclaration[]; roots: Map<string, string> }> {
  const resolved = new Map<string, string>();
  const result: SkillDeclaration[] = [];
  for (const name of names) {
    if (resolved.has(name)) continue;
    const root = (await Promise.all(roots.map(async candidate => await existing(join(candidate, name)) ? candidate : null))).find(Boolean);
    if (!root) throw new Error(`Required skill ${name} is unavailable; install it in a trusted local skills directory before launching.`);
    const source = join(root, name);
    resolved.set(name, root);
    result.push({ name, contentHash: await hashSkillDirectory(source) });
  }
  return { declarations: result, roots: resolved };
}

export async function prepareExecution(input: PrepareExecutionInput): Promise<PreparedExecution> {
  if (!/^[a-z\d_-]{1,128}$/i.test(input.runId)) throw new Error('Run ID is invalid for execution preparation');
  const existingId = input.task.workflowSnapshotId;
  if (existingId !== undefined && !HASH.test(existingId)) throw new Error('Saved workflow snapshot ID is invalid');
  const ownsStore = !input.store;
  const store = input.store ?? openWorkflowStore(input.workflowDbPath);
  try {
    const existingSnapshot = existingId ? store.resolveSnapshot(existingId) : null;
    if (existingId && !existingSnapshot) throw new Error('Saved workflow snapshot is unavailable');
    const requiredReviewSkill = input.workflow === 'coding' || input.workflow === 'review' || input.task.review || input.task.prePr?.stage === 'review';
    const requestedSkills = existingSnapshot ? existingSnapshot.skills.map(skill => skill.name) : [...new Set([...(input.skills ?? []), ...(requiredReviewSkill ? ['review-agent'] : [])])];
    const roots = input.skillsRoots ?? defaultSkillsRoots();
    const found = await declarations(requestedSkills, roots);
    const verified: VerifiedSkill[] = [];
    for (const [name, root] of found.roots) verified.push(...await preflightSkills({ declarations: found.declarations.filter(item => item.name === name), trustedNames: new Set(requestedSkills), skillsRoot: root }));
    if (existingSnapshot && JSON.stringify(existingSnapshot.skills) !== JSON.stringify(found.declarations.sort((a, b) => a.name.localeCompare(b.name)))) {
      throw new Error('Required skills do not match the saved workflow snapshot');
    }
    const currentPromptHash = await promptCodeHash();
    const promptChanged = existingSnapshot && existingSnapshot.promptCodeHash !== currentPromptHash;
    if (promptChanged && !input.allowPromptUpgrade) throw new Error('Prompt implementation does not match the saved workflow snapshot; explicit continuation is required to upgrade it.');
    const skillsPath = join(input.runsDir, `${input.runId}.runtime`);
    const installRoot = join(skillsPath, 'skills');
    if (await existing(installRoot)) {
      for (const skill of verified) {
        if (await hashSkillDirectory(join(installRoot, skill.name)) !== skill.contentHash) throw new Error(`Provisioned skill ${skill.name} no longer matches the saved workflow snapshot`);
      }
    } else await installVerifiedSkills(verified, installRoot);
    const defaults = input.provider === 'codex' ? codexSettings({ model: input.model ?? input.task.model, effort: input.effort ?? input.task.effort }) : { model: input.model ?? input.task.model, effort: input.effort ?? input.task.effort };
    const snapshot = existingSnapshot
      ? promptChanged ? store.createSnapshot({ workflowId: existingSnapshot.workflowId, version: existingSnapshot.version ?? existingSnapshot.definition.version,
        model: existingSnapshot.model, effort: existingSnapshot.effort, promptCodeHash: currentPromptHash,
        reviewSettings: existingSnapshot.reviewSettings, skills: existingSnapshot.skills }) : existingSnapshot
      : store.createSnapshot({ workflowId: input.workflow, model: defaults.model ?? input.model, effort: defaults.effort ?? input.effort,
        promptCodeHash: currentPromptHash, reviewSettings: input.reviewSettings as unknown as Record<string, unknown>, skills: found.declarations });
    const reviewSettings = (existingSnapshot?.reviewSettings ?? input.reviewSettings) as PrePrSettings;
    const model = snapshot.model;
    const effort = snapshot.effort;
    return { snapshotId: snapshot.id, skills: verified, reviewSettings, model, effort,
      task: { ...input.task, model, effort, workflowSnapshotId: snapshot.id, skillsPath, promptRevision: snapshot.definition.promptRevision } };
  } finally { if (ownsStore) store.close(); }
}
