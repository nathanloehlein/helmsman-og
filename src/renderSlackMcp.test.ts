import { describe, expect, it } from 'vitest';
import { renderConfigView } from './render';
import { renderSlackMcp } from './renderSlackMcp';
import { DEFAULT_THEME_ID } from './data/themes';

const opts = { repos: [], selectedRepo: null, themeId: DEFAULT_THEME_ID };
const connected = { status: 'connected' as const, configured: true, connected: true, teamId: 'T123', userId: 'U123', redirectUri: 'https://example.com/callback', message: 'Connected' };
function render(html: string) { const root = document.createElement('div'); root.innerHTML = html; return root; }

describe('Slack connection configuration', () => {
  it('keeps browser transport as default and hides OAuth-only inputs', () => {
    const root = render(renderConfigView({ config: { SLACK_BROWSER: 'firefox' }, overridden: [] }, opts));
    expect(root.querySelector<HTMLSelectElement>('#config-SLACK_TRANSPORT')?.value).toBe('browser');
    expect(root.querySelector('[data-firefox-bridge]')).not.toBeNull();
    expect(root.querySelector('#config-SLACK_OAUTH_CLIENT_ID')).toBeNull();
  });

  it('shows MCP controls and a write-only secret without browser settings', () => {
    const root = render(renderConfigView({ config: { SLACK_TRANSPORT: 'mcp', SLACK_BROWSER: 'firefox', SLACK_OAUTH_CLIENT_SECRET: 'must-not-echo' }, overridden: [], slackOAuthClientSecretSet: true }, { ...opts, slackMcp: { status: connected } }));
    expect(root.querySelector('[data-firefox-bridge]')).toBeNull();
    expect(root.querySelector('#config-SLACK_BROWSER')).toBeNull();
    expect(root.querySelector('#config-SLACK_CLIENT_ID')).toBeNull();
    expect(root.querySelector('#config-SLACK_OAUTH_CLIENT_ID')).not.toBeNull();
    expect(root.querySelector('#config-SLACK_REVIEW_GROUP_ID')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('#config-SLACK_OAUTH_CLIENT_SECRET')?.type).toBe('password');
    expect(root.innerHTML).not.toContain('must-not-echo');
    expect(root.textContent).toContain('Set');
  });

  it('disables repeated actions while pending and retains useful error feedback', () => {
    const root = render(renderSlackMcp({ status: connected, pending: 'disconnect', error: '<try again>' }));
    expect([...root.querySelectorAll('button')].every(button => button.disabled)).toBe(true);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('<try again>');
  });

  it('allows disconnecting saved credentials even when connection verification failed', () => {
    const root = render(renderSlackMcp({ status: { ...connected, status: 'error', connected: false } }));
    expect(root.querySelector<HTMLButtonElement>('[data-slack-mcp-action="disconnect"]')?.disabled).toBe(false);
  });
});
