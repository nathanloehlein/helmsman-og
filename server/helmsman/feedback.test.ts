import { describe, expect, it, vi } from 'vitest';
import { createFeedback } from './feedback';

const github = { token: 'test-token', repo: 'other/repo', author: 'test' };

describe('Helmsman feedback', () => {
  it('creates only in the Helmsman tracker and builds a trusted issue link', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ number: 42, html_url: 'https://untrusted.invalid' }), { status: 201 }));
    await expect(createFeedback(github, { title: ' Bug ', body: ' Steps\n\nExpected ', repo: 'other/repo' }, request)).resolves.toEqual({ url: 'https://github.com/nloehlein-godaddy/helmsman/issues/42' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/nloehlein-godaddy/helmsman/issues');
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body)).toEqual({ title: 'Bug', body: 'Steps\n\nExpected' });
  });
  it.each([null, {}, { title: 'x', body: '' }, { title: 'x'.repeat(257), body: 'x' }, { title: 'x', body: 'x'.repeat(10001) }])('rejects invalid feedback without publishing: %j', async input => {
    const request = vi.fn();
    await expect(createFeedback(github, input, request)).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });
  it('offers browser fallback when GitHub is not configured', async () => {
    await expect(createFeedback(null, { title: 'x', body: 'x' })).rejects.toMatchObject({ status: 503 });
  });
  it('does not retry an uncertain submission', async () => {
    const request = vi.fn().mockRejectedValue(new Error('network failed'));
    await expect(createFeedback(github, { title: 'x', body: 'x' }, request)).rejects.toThrow('Check Helmsman');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('handles permissions and malformed successful responses', async () => {
    await expect(createFeedback(github, { title: 'x', body: 'x' }, vi.fn().mockResolvedValue(new Response('', { status: 403 })))).rejects.toThrow('(403)');
    await expect(createFeedback(github, { title: 'x', body: 'x' }, vi.fn().mockResolvedValue(new Response('null', { status: 201 })))).rejects.toThrow('may have been created');
  });
});
