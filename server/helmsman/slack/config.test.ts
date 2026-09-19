import { describe, expect, it } from 'vitest';
import { publicSlackSettings, slackSettings } from './config';

const valid = { SLACK_WATCH_ENABLED: 'true', SLACK_CLIENT_ID: 'ET0BMD4E7', SLACK_CHANNEL_ID: 'C0B1S3BF524', SLACK_CHANNEL_NAME: 'airo-editing' };

describe('Slack configuration', () => {
  it('defaults to disabled and exposes no credentials', () => {
    expect(slackSettings({})).toEqual({ enabled: false, clientId: '', channelId: '', channelName: '', surface: undefined, error: null });
    expect(publicSlackSettings({})).toEqual({ SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'false', SLACK_CLIENT_ID: '', SLACK_CHANNEL_ID: '', SLACK_CHANNEL_NAME: '', SLACK_BROWSER_SURFACE: '' });
    expect(publicSlackSettings({ ...valid, GITHUB_TOKEN: 'secret' })).toEqual({ ...valid, SLACK_ENABLED: 'true', SLACK_BROWSER_SURFACE: '' });
  });

  it('validates channel identity and optional surface before enabling', () => {
    expect(slackSettings(valid).error).toBeNull();
    expect(slackSettings({ SLACK_WATCH_ENABLED: 'true' }).error).toBeTruthy();
    expect(slackSettings({ ...valid, SLACK_CHANNEL_NAME: undefined }).error).toBeTruthy();
    expect(slackSettings({ ...valid, SLACK_CHANNEL_NAME: 'airo-editing in:another' }).error).toBeTruthy();
    expect(slackSettings({ ...valid, SLACK_CHANNEL_ID: '' }).error).toBeTruthy();
    expect(slackSettings({ ...valid, SLACK_BROWSER_SURFACE: '--help' }).error).toBeTruthy();
  });
});

it('master switch disables watching without clearing watcher preference', () => {
  const env = { ...valid, SLACK_ENABLED: 'false' };
  expect(slackSettings(env).enabled).toBe(false);
  expect(publicSlackSettings(env)).toMatchObject({ SLACK_ENABLED: 'false', SLACK_WATCH_ENABLED: 'true' });
});
