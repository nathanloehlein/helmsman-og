import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentTask } from './agents/adapter';

export const GOCAAS_URL = 'https://caas-gocode-prod.caas-prod.prod.onkatana.net';
type Env = Record<string, string | undefined>;
export type ModelProvider = 'codex' | 'claude-code';
const exec = promisify(execFile);

export function requiresGoCaas(env: Env, goCodeInstalled: boolean): boolean {
  return env.HELMSMAN_ORGANIZATION?.trim().toLowerCase() === 'godaddy'
    || goCodeInstalled
    || /@(?:[a-z0-9-]+\.)*godaddy\.com$/i.test(env.JIRA_EMAIL?.trim() ?? '')
    || /-godaddy$/i.test(env.GITHUB_PR_AUTHOR?.trim() ?? '')
    || /^https:\/\/godaddy(?:-corp)?\.atlassian\.net(?:\/|$)/i.test(env.JIRA_BASE_URL?.trim() ?? '');
}

export function goCodePath(home = homedir()): string {
  const path = join(home, '.gocode', 'bin', 'gocode');
  if (!existsSync(path)) throw new Error('GoCaaS routing requires GoCode. Install GoCode and authenticate before starting a run.');
  return path;
}

export async function goCaasKey(): Promise<string> {
  try {
    const { stdout } = await exec(goCodePath(), ['api-key-helper'], { timeout: 15_000, maxBuffer: 16_384, encoding: 'utf8' });
    const key = stdout.trim();
    if (!key || /\s/.test(key) || key.startsWith('{') || key.startsWith('[')) throw new Error('Invalid credential');
    return key;
  } catch {
    throw new Error('GoCaaS authentication is unavailable. Authenticate GoCode before starting a run; direct-provider fallback is disabled.');
  }
}

export function pinModelRouting(task: AgentTask, required: boolean): AgentTask {
  return required || task.modelRouting === 'gocaas' ? { ...task, modelRouting: 'gocaas' } : task;
}

export function routeAgentCommand(task: AgentTask, provider: ModelProvider, command: { cmd: string; args: string[] }): { cmd: string; args: string[] } {
  if (task.modelRouting !== 'gocaas' || task.dockerExecution) return command;
  return { cmd: process.execPath, args: ['--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('./gocaas-cli.ts', import.meta.url)), provider, JSON.stringify(command.args)] };
}

export function goCaasLaunch(provider: ModelProvider, args: string[], env: Env, helper: string): { cmd: string; args: string[]; env: Env } {
  const clean = { ...env };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CODEX_API_KEY']) delete clean[key];
  clean.ANTHROPIC_BASE_URL = GOCAAS_URL;
  clean.CLAUDE_CODE_USE_BEDROCK = '0';
  clean.CLAUDE_CODE_USE_VERTEX = '0';
  clean.CLAUDE_CODE_USE_FOUNDRY = '0';
  if (provider === 'codex') {
    const config = `{name="GoCaaS",base_url=${JSON.stringify(`${GOCAAS_URL}/v1`)},wire_api="responses",requires_openai_auth=false,auth={command=${JSON.stringify(helper)},args=["api-key-helper"],refresh_interval_ms=300000}}`;
    return { cmd: 'codex', args: ['-c', 'model_provider="helmsman_gocaas"', '-c', `model_providers.helmsman_gocaas=${config}`, ...args], env: clean };
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const settings = { apiKeyHelper: `${quote(helper)} api-key-helper`, env: {
    ANTHROPIC_BASE_URL: GOCAAS_URL, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
  } };
  return { cmd: 'claude', args: ['--settings', JSON.stringify(settings), ...args], env: clean };
}
