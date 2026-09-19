import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { openWebhookIntake, parseWebhookRoutes } from './webhooks';
const raw = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'o/r' }, issue: { number: 1, title: 'Fix input', body: 'Validate it' } }));
const signature = createHmac('sha256', 'secret').update(raw).digest('hex');
function setup() {
  const launch = vi.fn(input => input.runId);
  const intake = openWebhookIntake(':memory:', { secret: () => 'secret', routes: () => [{ repo: 'o/r', event: 'issues', action: 'opened', workflowRef: 'coding@1' }],
    allowedRepos: () => ['o/r'], canStart: () => true, getRun: () => null, isRunActive: () => false, launch });
  return { intake, launch };
}
describe('authenticated webhook intake', () => {
  it('rejects unsigned or modified payloads before storing/launching', () => {
    const { intake, launch } = setup();
    expect(() => intake.receive(raw, { delivery: 'd1', event: 'issues' })).toThrow('signature');
    expect(() => intake.receive(Buffer.from('{}'), { delivery: 'd1', event: 'issues', signature: `sha256=${signature}` })).toThrow('signature');
    expect(intake.status()).toEqual([]); expect(launch).not.toHaveBeenCalled(); intake.close();
  });
  it('deduplicates deliveries and dispatches a deterministic run bound to the configured workflow', async () => {
    const { intake, launch } = setup();
    const headers = { delivery: 'd1', event: 'issues', signature: `sha256=${signature}` };
    const first = intake.receive(raw, headers);
    expect(intake.receive(raw, headers)).toEqual({ ...first, duplicate: true });
    await Promise.all([intake.poll(), intake.poll()]);
    await intake.poll();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ runId: first.runId, repo: 'o/r', mode: 'freeform', workflowRef: 'coding@1' });
    intake.close();
  });
  it('rejects unmapped actions and unsupported workflow versions', () => {
    const { intake } = setup();
    expect(() => intake.receive(raw, { delivery: 'd1', event: 'push', signature: `sha256=${signature}` })).toThrow('configured workflow');
    expect(() => parseWebhookRoutes('[{"repo":"o/r","event":"issues","action":"opened","workflowRef":"coding@2"}]')).toThrow('mapping');
    intake.close();
  });
});
