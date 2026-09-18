import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTodo, deleteTodo, fetchTodos, updateTodo } from './todoClient';

const todo = {
  id: 'TODO-1', title: 'Search', repo: 'owner/repo', description: '', acceptanceCriteria: '', priority: 'P2', state: 'todo',
  createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z', runId: null, completedAt: null,
};
const reply = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('todo client', () => {
  it('loads validated todos together with the current source configuration', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ todos: [todo], jiraEnabled: false })));
    expect(await fetchTodos()).toEqual({ todos: [todo], jiraEnabled: false });
  });

  it.each([null, { todos: [null], jiraEnabled: false }, { todos: [{ ...todo, state: 'unexpected' }], jiraEnabled: false }, { todos: [todo] }])('rejects malformed external data without pretending the backlog is empty', async data => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(data)));
    await expect(fetchTodos()).rejects.toThrow();
  });

  it('reports server validation and conflict errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'This todo has an active voyage.' }, 409)));
    await expect(updateTodo('TODO-1', { title: 'Changed', repo: 'owner/repo' })).rejects.toThrow('This todo has an active voyage.');
  });

  it('creates and updates using the complete form input with encoded IDs', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply({ todo })));
    vi.stubGlobal('fetch', fetcher);
    const input = { title: 'Search', repo: 'owner/repo', acceptanceCriteria: 'Match descriptions' };
    await createTodo(input);
    await updateTodo('TODO/1', input);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/todos');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/todos/TODO%2F1');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
  });

  it('does not report a mutation as successful without a valid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ todo: null })));
    await expect(createTodo({ title: 'Search', repo: 'owner/repo' })).rejects.toThrow('Refresh before retrying');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ok: false })));
    await expect(deleteTodo('TODO-1')).rejects.toThrow('Refresh before retrying');
  });

  it('deletes only the requested todo', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await deleteTodo('TODO-1');
    expect(fetcher).toHaveBeenCalledWith('/api/todos/TODO-1', expect.objectContaining({ method: 'DELETE' }));
  });
});
