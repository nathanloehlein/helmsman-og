import { describe, expect, it, vi } from 'vitest';
import { createSlackBrowserTransportSelector, DEFAULT_FIREFOX_WEBDRIVER_URL, parseFirefoxWebDriverUrl, publicSlackSettings, slackSettings } from './config';

const valid = { SLACK_WATCH_ENABLED: 'true', SLACK_CLIENT_ID: 'ET0BMD4E7', SLACK_CHANNEL_ID: 'C0B1S3BF524', SLACK_CHANNEL_NAME: 'airo-editing' };

describe('Slack configuration', () => {
  it('defaults to disabled and exposes no credentials', () => {
    expect(slackSettings({})).toEqual({ enabled: false, clientId: '', channelId: '', channelName: '', surface: undefined,
      browser: 'cmux', firefoxWebDriverUrl: DEFAULT_FIREFOX_WEBDRIVER_URL, error: null });
    expect(publicSlackSettings({})).toEqual({ SLACK_ENABLED: 'true', SLACK_WATCH_ENABLED: 'false', SLACK_CLIENT_ID: '', SLACK_CHANNEL_ID: '', SLACK_CHANNEL_NAME: '', SLACK_BROWSER_SURFACE: '',
      SLACK_BROWSER: 'cmux', SLACK_FIREFOX_WEBDRIVER_URL: DEFAULT_FIREFOX_WEBDRIVER_URL });
    expect(publicSlackSettings({ ...valid, GITHUB_TOKEN: 'secret' })).toEqual({ ...valid, SLACK_ENABLED: 'true', SLACK_BROWSER_SURFACE: '',
      SLACK_BROWSER: 'cmux', SLACK_FIREFOX_WEBDRIVER_URL: DEFAULT_FIREFOX_WEBDRIVER_URL });
  });

  it('supports Firefox tab references while ignoring saved cmux references', () => {
    expect(slackSettings({ ...valid, SLACK_BROWSER: 'firefox', SLACK_BROWSER_SURFACE: 'surface:8' }))
      .toMatchObject({ browser: 'firefox', surface: undefined, error: null });
    expect(slackSettings({ ...valid, SLACK_BROWSER: 'firefox', SLACK_BROWSER_SURFACE: 'firefox:tab%2Fone' }))
      .toMatchObject({ surface: 'firefox:tab%2Fone', error: null });
    expect(slackSettings({ SLACK_BROWSER: 'firefox', SLACK_BROWSER_SURFACE: 'firefox:%00' }).error).toBeTruthy();
    expect(slackSettings({ SLACK_BROWSER: 'firefox', SLACK_BROWSER_SURFACE: 'firefox:%broken' }).error).toBeTruthy();
  });

  it.each(['https://127.0.0.1:4444', 'http://example.com:4444', 'http://127.0.0.1:4444/session',
    'http://user:secret@127.0.0.1:4444', 'http://localhost:4444?token=secret', 'http://localhost:4444/#secret', 'invalid'])('rejects unsafe Firefox endpoints even with watching disabled: %s', endpoint => {
    expect(() => parseFirefoxWebDriverUrl(endpoint)).toThrow();
    expect(slackSettings({ SLACK_BROWSER: 'firefox', SLACK_FIREFOX_WEBDRIVER_URL: endpoint }).error).toBeTruthy();
  });

  it('validates browser selection independently of watcher enablement', () => {
    expect(slackSettings({ SLACK_BROWSER: 'safari' }).error).toContain('cmux or firefox');
    expect(slackSettings({ SLACK_BROWSER_SURFACE: '--help' }).error).toBeTruthy();
    for (const endpoint of ['', 'http://127.0.0.1:4444/', 'http://localhost:4444', 'http://[::1]:4444']) {
      expect(slackSettings({ SLACK_BROWSER: 'firefox', SLACK_FIREFOX_WEBDRIVER_URL: endpoint }).error).toBeNull();
    }
  });

  it('shares one cached Firefox transport across readers and senders and keeps cmux independent', () => {
    const cmux = vi.fn(async () => 'cmux');
    const firefox = vi.fn(() => vi.fn(async () => 'firefox'));
    const select = createSlackBrowserTransportSelector(firefox, cmux);
    expect(select(slackSettings({}))).toBe(cmux);
    expect(firefox).not.toHaveBeenCalled();
    const reader = select(slackSettings({ SLACK_BROWSER: 'firefox' }));
    const sender = select(slackSettings({ SLACK_BROWSER: 'firefox', SLACK_FIREFOX_WEBDRIVER_URL: `${DEFAULT_FIREFOX_WEBDRIVER_URL}/` }));
    expect(sender).toBe(reader);
    expect(firefox).toHaveBeenCalledExactlyOnceWith(DEFAULT_FIREFOX_WEBDRIVER_URL);
    expect(select(slackSettings({ SLACK_BROWSER: 'firefox', SLACK_FIREFOX_WEBDRIVER_URL: 'http://localhost:5555' }))).not.toBe(reader);
    expect(select(slackSettings({ SLACK_BROWSER: 'firefox' }))).toBe(reader);
    expect(firefox).toHaveBeenCalledTimes(2);
    expect(reader).not.toHaveBeenCalled();
  });

  it('discards cached Firefox sessions after bridge startup without changing cmux', () => {
    const cmux = vi.fn(async () => 'cmux');
    const firefox = vi.fn(() => vi.fn(async () => 'firefox'));
    const select = createSlackBrowserTransportSelector(firefox, cmux);
    const settings = slackSettings({ SLACK_BROWSER: 'firefox' });
    const before = select(settings);
    select.reset();
    expect(select(settings)).not.toBe(before);
    expect(select(slackSettings({}))).toBe(cmux);
    expect(before).not.toHaveBeenCalled();
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
