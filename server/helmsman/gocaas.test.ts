// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from './agents/adapter';
import { claudeCodeAdapter } from './agents/claude-code';
import { codexAdapter } from './agents/codex';
import { commandAdapter } from './agents/command';
import { prePrAdapter } from './agents/pre-pr';
import { buildPrompt } from './agents/prompt';
import { restoreRunAdapter } from './agents/restore';
import { GOCAAS_URL, goCaasKey, goCaasLaunch, pinModelRouting, requiresGoCaas, routeAgentCommand } from './gocaas';

const mocks = vi.hoisted(() => ({ existsSync: vi.fn(), execFile: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: mocks.existsSync }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: mocks.execFile }));

const task: AgentTask = { ticketId: 'T-1', title: 'Customer fix', repo: 'org/repo', jiraBaseUrl: '' };
const corporateTask: AgentTask = { ...task, modelRouting: 'gocaas' };
const providers = [codexAdapter, claudeCodeAdapter];

beforeEach(() => {
  mocks.existsSync.mockReset().mockReturnValue(true);
  mocks.execFile.mockReset();
});

describe('GoDaddy routing detection', () => {
  it.each([
    [{ HELMSMAN_ORGANIZATION: ' GoDaddy ' }, false],
    [{ JIRA_EMAIL: 'person@godaddy.com' }, false],
    [{ JIRA_EMAIL: ' person@team.GoDaddy.com ' }, false],
    [{ GITHUB_PR_AUTHOR: 'person-godaddy' }, false],
    [{ JIRA_BASE_URL: 'https://godaddy.atlassian.net/' }, false],
    [{ JIRA_BASE_URL: 'https://godaddy-corp.atlassian.net/' }, false],
    [{}, true],
    [{ HELMSMAN_ORGANIZATION: 'other' }, true],
    [{ HELMSMAN_ORGANIZATION: 'other', JIRA_EMAIL: 'person@godaddy.com' }, false],
  ])('requires GoCaaS for corporate evidence %j', (env, installed) => {
    expect(requiresGoCaas(env, installed)).toBe(true);
  });

  it.each([
    {},
    { HELMSMAN_ORGANIZATION: 'other', JIRA_EMAIL: 'person@example.com' },
    { JIRA_EMAIL: 'person@notgodaddy.com', JIRA_BASE_URL: 'https://godaddy.atlassian.net.example.com' },
  ])('leaves noncorporate configuration unchanged %j', env => {
    expect(requiresGoCaas(env, false)).toBe(false);
  });

  it('cannot downgrade persisted routing when corporate detection is no longer available', () => {
    expect(pinModelRouting(corporateTask, false)).toEqual(corporateTask);
    expect(pinModelRouting(task, true)).toEqual(corporateTask);
    expect(pinModelRouting(task, false)).toBe(task);
    expect(task.modelRouting).toBeUndefined();
  });
});

describe('agent command routing', () => {
  it.each(providers)('wraps author and review commands for $id while preserving flags and corporate prompts', adapter => {
    for (const extra of [{}, { review: true }, { prePr: { stage: 'review' as const, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), reportPath: '/tmp/report.json' } }]) {
      const direct = adapter.buildCommand({ ...task, ...extra });
      const routed = adapter.buildCommand({ ...corporateTask, ...extra });
      expect(routed.cmd).toBe(process.execPath);
      expect(routed.args[0]).toBe('--import');
      expect(routed.args[2]).toMatch(/\/gocaas-cli\.ts$/);
      expect(routed.args[3]).toBe(adapter.id);
      const provider = adapter.id === 'codex' ? 'codex' : undefined;
      const directPrompt = buildPrompt({ ...task, ...extra }, provider);
      const corporatePrompt = buildPrompt({ ...corporateTask, ...extra }, provider);
      expect(JSON.parse(routed.args[4] ?? 'null')).toEqual(direct.args.map(arg => arg === directPrompt ? corporatePrompt : arg));
    }
  });

  it.each(providers)('preserves routing through pre-PR and restored $id adapters', adapter => {
    const prePr = prePrAdapter(adapter, '/runs').buildCommand(corporateTask);
    expect(JSON.parse(prePr.args[3] ?? 'null')?.task?.modelRouting).toBe('gocaas');
    for (const id of [adapter.id, `pre-pr:${adapter.id}`]) {
      const restored = restoreRunAdapter({ adapter: id, taskJson: JSON.stringify(corporateTask) }, { runsDir: '/runs' });
      const command = restored.buildCommand(corporateTask);
      if (id.startsWith('pre-pr:')) {
        expect(JSON.parse(command.args[3] ?? 'null')?.task?.modelRouting).toBe('gocaas');
      } else {
        expect(command.args[2]).toMatch(/\/gocaas-cli\.ts$/);
        expect(command.args[3]).toBe(adapter.id);
      }
    }
  });

  it('preserves direct noncorporate commands and refuses custom corporate commands', () => {
    const command = { cmd: 'codex', args: ['exec', 'prompt'] };
    expect(routeAgentCommand(task, 'codex', command)).toBe(command);
    expect(codexAdapter.buildCommand(task).cmd).toBe('codex');
    expect(claudeCodeAdapter.buildCommand(task).cmd).toBe('claude');
    expect(commandAdapter('echo {ticket}').buildCommand(task)).toEqual({ cmd: 'echo', args: ['T-1'] });
    expect(() => commandAdapter('echo {ticket}').buildCommand(corporateTask)).toThrow(/cannot enforce GoCaaS/);
  });
});

describe('GoCaaS reviewer publication instructions', () => {
  it.each([undefined, 'implement', 'fix'] as const)('prohibits external AI reviewer requests in the %s prompt', stage => {
    const input: AgentTask = { ...task, ...(stage ? { prePr: { stage, baseSha: 'a'.repeat(40), reportPath: '/tmp/report.json' } } : {}) };
    const corporate = buildPrompt({ ...input, modelRouting: 'gocaas' });
    expect(corporate).toContain('Do not request Copilot or any other external AI reviewer.');
    expect(corporate).toContain('through GoCaaS');
    expect(corporate).not.toContain('requests only Copilot');
    expect(buildPrompt(input)).toContain('requests only Copilot');
  });
});

describe('GoCaaS launch isolation', () => {
  const helper = "/home/person's directory/.gocode/bin/gocode";
  const credentials = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CODEX_API_KEY'];
  const environment = { ...Object.fromEntries(credentials.map(key => [key, `secret-${key}`])), PATH: '/usr/bin',
    OPENAI_BASE_URL: 'https://external.example', ANTHROPIC_BASE_URL: 'https://external.example',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1' };

  it.each(['codex', 'claude-code'] as const)('removes external credentials and alternate backends for %s', provider => {
    const launch = goCaasLaunch(provider, ['test-prompt'], environment, helper);
    expect(launch.env.PATH).toBe('/usr/bin');
    expect(launch.env.OPENAI_BASE_URL).toBeUndefined();
    expect(launch.env.ANTHROPIC_BASE_URL).toBe(GOCAAS_URL);
    for (const key of credentials) expect(launch.env[key]).toBeUndefined();
    for (const backend of ['BEDROCK', 'VERTEX', 'FOUNDRY']) expect(launch.env[`CLAUDE_CODE_USE_${backend}`]).toBe('0');
    expect(JSON.stringify(launch.args)).not.toContain('secret-');
    expect(environment.OPENAI_BASE_URL).toBe('https://external.example');
    expect(launch.args.at(-1)).toBe('test-prompt');
  });

  it('pins Codex to GoCaaS responses with the GoCode credential helper', () => {
    const launch = goCaasLaunch('codex', ['exec', 'prompt'], {}, helper);
    expect(launch.cmd).toBe('codex');
    expect(launch.args.slice(0, 3)).toEqual(['-c', 'model_provider="helmsman_gocaas"', '-c']);
    expect(launch.args[3]).toContain(`base_url="${GOCAAS_URL}/v1"`);
    expect(launch.args[3]).toContain('wire_api="responses"');
    expect(launch.args[3]).toContain('requires_openai_auth=false');
    expect(launch.args[3]).toContain(`command=${JSON.stringify(helper)}`);
    expect(launch.args[3]).toContain('args=["api-key-helper"]');
  });

  it('pins Claude settings and safely quotes the GoCode helper path', () => {
    const launch = goCaasLaunch('claude-code', ['-p', 'prompt'], {}, helper);
    expect(launch.cmd).toBe('claude');
    expect(launch.args[0]).toBe('--settings');
    const settings = JSON.parse(launch.args[1] ?? 'null');
    expect(settings?.apiKeyHelper).toBe("'/home/person'\\''s directory/.gocode/bin/gocode' api-key-helper");
    expect(settings?.env).toEqual({ ANTHROPIC_BASE_URL: GOCAAS_URL, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' });
  });
});

describe('GoCode authentication failures', () => {
  it('fails closed without invoking auth when GoCode is absent', async () => {
    mocks.existsSync.mockReturnValue(false);
    await expect(goCaasKey()).rejects.toThrow(/direct-provider fallback is disabled/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('does not expose credential helper errors', async () => {
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(new Error('secret credential value')));
    await expect(goCaasKey()).rejects.toThrow('GoCaaS authentication is unavailable. Authenticate GoCode before starting a run; direct-provider fallback is disabled.');
  });

  it.each(['', 'two tokens', '{"key":"secret"}', '["secret"]'])('rejects invalid helper output %j', async stdout => {
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(null, { stdout }));
    await expect(goCaasKey()).rejects.toThrow(/direct-provider fallback is disabled/);
  });

  it('accepts a trimmed helper credential without exposing it in argv', async () => {
    mocks.execFile.mockImplementation((_cmd, _args, _options, callback) => callback(null, { stdout: '  test-key\n' }));
    await expect(goCaasKey()).resolves.toBe('test-key');
    expect(mocks.execFile.mock.calls[0]?.[1]).toEqual(['api-key-helper']);
    expect(mocks.execFile.mock.calls[0]?.[2]).toMatchObject({ timeout: 15_000, maxBuffer: 16_384 });
  });
});
