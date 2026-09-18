import { execFile } from 'node:child_process';

export interface SlackBrowserConfig {
  clientId: string;
  channelId: string;
  channelName: string;
  surface?: string;
}

export interface SlackBrowserMessage {
  channelId: string;
  ts: string;
  permalink: string;
  author: string;
  prUrls: string[];
}

export type SlackBrowserTransport = (args: string[]) => Promise<string>;

export const runSlackBrowserCommand: SlackBrowserTransport = (args) => new Promise((resolve, reject) => {
  execFile('cmux', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' } }, (error, stdout) => {
    if (error) reject(new Error(`Slack browser command failed: ${error.message}`));
    else resolve(stdout);
  });
});

export function extractSlackMessages(doc: Document, channelId: string): { messages: SlackBrowserMessage[]; unexpanded: number } {
  const messages: SlackBrowserMessage[] = [];
  let unexpanded = 0;
  for (const row of Array.from(doc.querySelectorAll('[data-qa="search_result"]'))) {
    const channel = row.querySelector('[data-message-channel]')?.getAttribute('data-message-channel') ?? row.querySelector('[data-qa="search_result_channel_name"] [data-channel-id]')?.getAttribute('data-channel-id');
    if (channel !== channelId) throw new Error('Slack search returned an unexpected channel');
    const identity = row.querySelector('a[data-ts]');
    const ts = identity?.getAttribute('data-ts');
    const href = identity?.getAttribute('href');
    const body = row.querySelector('[data-qa="message-text"]');
    const sender = row.querySelector('[data-qa="message_sender_name"]');
    const author = sender?.textContent?.trim() || sender?.getAttribute('data-message-sender');
    const attachmentOnly = !body && !!row.querySelector('[data-qa="message_attachment_v2"], [data-qa="message_attachment"]');
    if (!ts || !/^\d+\.\d+$/.test(ts) || !href || (!body && !attachmentOnly) || !author) throw new Error('Slack search message is missing required fields');
    const permalink = new URL(href, 'https://app.slack.com');
    if (permalink.protocol !== 'https:' || !permalink.hostname.endsWith('.slack.com') || permalink.pathname !== `/archives/${channelId}/p${ts.replace('.', '')}`) {
      throw new Error('Slack message permalink does not match its identity');
    }
    if (row.querySelector('[data-qa="search_expand"]')) unexpanded++;
    const prUrls = new Set<string>();
    for (const anchor of Array.from(body?.querySelectorAll('a[href]') ?? [])) {
      if (anchor.closest('blockquote, [data-qa="message_attachment"], [data-qa="message_unfurl"], .c-message_kit__attachments, .c-message_attachment')) continue;
      const raw = anchor.getAttribute('href');
      if (!raw || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i.test(raw)) continue;
      const url = new URL(raw);
      const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
      if (url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port || !match) continue;
      prUrls.add(`https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`);
    }
    messages.push({ channelId, ts, permalink: permalink.href, author, prUrls: [...prUrls] });
  }
  return { messages, unexpanded };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function surfaceSelection(tree: unknown, target: string): { surface: string; selected: string; active: string } | null {
  const root = object(tree);
  const active = object(root?.active)?.surface_ref;
  for (const window of Array.isArray(root?.windows) ? root.windows : []) {
    const w = object(window);
    for (const workspace of Array.isArray(w?.workspaces) ? w.workspaces : []) {
      const ws = object(workspace);
      for (const pane of Array.isArray(ws?.panes) ? ws.panes : []) {
        const p = object(pane);
        const surface = (Array.isArray(p?.surfaces) ? p.surfaces : []).map(object).find(value => value?.ref === target || value?.id === target);
        if (surface && typeof surface.ref === 'string' && typeof p?.selected_surface_ref === 'string' && typeof active === 'string') {
          return { surface: surface.ref, selected: p.selected_surface_ref, active };
        }
      }
    }
  }
  return null;
}

export function findSlackBrowserSurface(tree: unknown, config: SlackBrowserConfig): string {
  const candidates = new Set<string>();
  const root = object(tree);
  for (const window of Array.isArray(root?.windows) ? root.windows : []) {
    const w = object(window);
    for (const workspace of Array.isArray(w?.workspaces) ? w.workspaces : []) {
      const ws = object(workspace);
      for (const pane of Array.isArray(ws?.panes) ? ws.panes : []) {
        const p = object(pane);
        for (const value of Array.isArray(p?.surfaces) ? p.surfaces : []) {
          const surface = object(value);
          if (surface?.type !== 'browser' || typeof surface.ref !== 'string' || typeof surface.url !== 'string') continue;
          try {
            const url = new URL(surface.url);
            if (url.origin === 'https://app.slack.com' && [`/client/${config.clientId}/${config.channelId}`, `/client/${config.clientId}/search`].includes(url.pathname)) candidates.add(surface.ref);
          } catch { continue; }
        }
      }
    }
  }
  if (candidates.size !== 1) throw new Error(candidates.size ? 'Multiple Slack browser surfaces match; configure one explicitly' : 'Authenticated Slack channel browser surface unavailable');
  return [...candidates][0]!;
}

interface SearchState {
  href: string;
  query: string;
  full: boolean;
  newest: boolean;
  total: number | null;
  page: string;
  hasNext: boolean;
  pagination: boolean;
  loading: boolean;
  empty: boolean;
  results: string;
}

export function inspectSlackSearch(doc: Document): SearchState {
  const sorts = Array.from(doc.querySelectorAll('[data-qa="message_sort_toggle-button"]'));
  const sort = sorts.find(element => /Sort:/.test(element.textContent ?? '')) ?? sorts[0];
  const next = doc.querySelector('[data-qa="c-pagination_forward_btn"]');
  const header = doc.querySelector('[data-qa="search_in_channel_results_header"]')?.textContent ?? '';
  const totalMatch = header.match(/([\d,]+)\s+results?\s+found/i);
  const text = doc.querySelector('[data-qa="search_view"]')?.textContent ?? '';
  return {
    href: doc.location?.href ?? '',
    query: doc.querySelector('[data-qa="top_nav_search"]')?.textContent?.trim() ?? '',
    full: /\/search$/.test(doc.location?.pathname ?? '') && /Sort:/i.test(sort?.textContent ?? ''),
    newest: /Sort:\s*Newest/i.test(sort?.textContent ?? ''),
    total: totalMatch ? Number(totalMatch[1]?.replaceAll(',', '')) : null,
    page: doc.querySelector('.c-pagination__page_btn--active')?.textContent?.trim() ?? '1',
    hasNext: !!next && next.getAttribute('aria-disabled') !== 'true' && !next.hasAttribute('disabled'),
    pagination: !!next,
    loading: !!doc.querySelector('[aria-busy="true"], [data-qa="search_results_loading"], [data-qa="loading_spinner"]'),
    empty: /(?:No results found|We couldn[’']t find any results|No messages found)/i.test(text),
    results: Array.from(doc.querySelectorAll('[data-qa="search_result"] a[data-ts]')).map(element => element.getAttribute('data-ts')).join(','),
  };
}

export function createSlackBrowserReader(config: SlackBrowserConfig, transport: SlackBrowserTransport = runSlackBrowserCommand): {
  scan: (input: { since: string | null }) => Promise<{ messages: SlackBrowserMessage[]; complete: boolean }>;
} {
  if (!/^[A-Z0-9]+$/.test(config.clientId) || !/^C[A-Z0-9]+$/.test(config.channelId) || !/^[a-z0-9_-]+$/.test(config.channelName)) {
    throw new Error('Invalid Slack browser channel configuration');
  }
  let scanning = false;
  async function scan({ since }: { since: string | null }): Promise<{ messages: SlackBrowserMessage[]; complete: boolean }> {
    if (scanning) throw new Error('Slack browser scan already in progress');
    scanning = true;
    let restore: (() => Promise<void>) | null = null;
    try {
      const sinceMs = since === null ? Date.now() : /^\d+\.\d+$/.test(since) ? Number(since) * 1000 : Date.parse(since);
      if (!Number.isFinite(sinceMs)) throw new Error('Invalid Slack scan cursor');
      const after = new Date(sinceMs - 2 * 86_400_000).toISOString().slice(0, 10);
      const query = `in:${config.channelName} after:${after}`;
      const tree = JSON.parse(await transport(['--id-format', 'both', 'tree', '--all', '--json'])) as unknown;
      const surface = config.surface ?? findSlackBrowserSurface(tree, config);
      const selection = surfaceSelection(tree, surface);
      if (!selection) throw new Error('Slack browser surface selection unavailable');
      const deadline = Date.now() + 120_000;
      const evaluate = async <T>(script: string): Promise<T> => {
        if (Date.now() > deadline) throw new Error('Slack browser scan timed out');
        return JSON.parse(await transport(['browser', surface, 'eval', `JSON.stringify(${script})`])) as T;
      };
      const state = (): Promise<SearchState> => evaluate(`(${inspectSlackSearch.toString()})(document)`);
      const validate = (view: SearchState): void => {
        const url = new URL(view.href);
        if (url.origin !== 'https://app.slack.com' || ![`/client/${config.clientId}/${config.channelId}`, `/client/${config.clientId}/search`].includes(url.pathname)) {
          throw new Error('Slack browser is signed out or outside the configured client/channel');
        }
      };
      const waitFor = async (predicate: (view: SearchState) => boolean): Promise<SearchState> => {
        for (let attempt = 0; attempt < 30; attempt++) {
          const view = await state();
          validate(view);
          if (predicate(view)) return view;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('Slack search did not reach the expected view');
      };
      const click = async (selector: string): Promise<void> => {
        await transport(['browser', surface, 'click', selector]);
      };
      validate(await state());
      const focus = (target: string): Promise<string> => transport(['rpc', 'surface.focus', JSON.stringify({ surface_id: target })]);
      if (selection.selected !== selection.surface) {
        await focus(selection.surface);
        restore = async () => {
          const currentTree = JSON.parse(await transport(['--id-format', 'both', 'tree', '--all', '--json'])) as unknown;
          const current = surfaceSelection(currentTree, selection.surface);
          if (current?.selected !== selection.surface || ![selection.active, selection.surface].includes(current.active)) return;
          await focus(selection.selected);
          if (selection.active !== selection.selected) await focus(selection.active);
        };
        if (selection.active !== selection.selected) await focus(selection.active);
      }
      const queryOpen = await evaluate<boolean>(`!!document.querySelector('[role="combobox"][aria-label="Query"]')`);
      if (!queryOpen) await click('[data-qa="top_nav_search"]');
      await transport(['browser', surface, 'wait', '--selector', '[role="combobox"][aria-label="Query"]', '--timeout-ms', '10000']);
      await transport(['browser', surface, 'fill', '[role="combobox"][aria-label="Query"]', query]);
      let submitted = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        submitted = await evaluate<boolean>(`(() => { const option = Array.from(document.querySelectorAll('[role="option"]')).find(element => { const text = (element.getAttribute('aria-label') || element.textContent || '').replaceAll('in:#', 'in:'); return text.trim() === ${JSON.stringify(`Search for: ${query}`)}; }); if (!option) return false; option.setAttribute('data-helmsman-slack-action', 'submit'); return true; })()`);
        if (submitted) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!submitted) throw new Error('Slack search submission option unavailable');
      await click('[data-helmsman-slack-action="submit"]');
      await new Promise(resolve => setTimeout(resolve, 500));
      let view = await waitFor(v => !v.loading && v.full && v.page === '1' && (!!v.results || v.empty));
      let total = view.total;
      if (!view.newest) {
        await click('[data-qa="message_sort_toggle-button"]');
        const sorted = await evaluate<boolean>(`(() => { const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')).find(element => element.textContent?.trim() === 'Newest'); if (!option) return false; option.setAttribute('data-helmsman-slack-action', 'sort'); return true; })()`);
        if (!sorted) throw new Error('Slack newest-first sorting unavailable');
        await click('[data-helmsman-slack-action="sort"]');
        view = await waitFor(v => v.full && v.newest && !v.loading);
      }
      const messages = new Map<string, SlackBrowserMessage>();
      const pages = new Set<string>();
      for (let page = 0; page < 50; page++) {
        if (!view.full || !view.newest || view.loading) throw new Error('Slack full search is not settled in newest-first order');
        if (view.query && !view.query.includes(query)) throw new Error('Slack search query does not match the configured channel/window');
        const oldPage = view.page;
        for (let expansion = 0; expansion < 100; expansion++) {
          const expanded = await evaluate<boolean>(`!!document.querySelector('[data-qa="search_expand"]')`);
          if (!expanded) break;
          await click('[data-qa="search_expand"]');
        }
        const extract = (): Promise<ReturnType<typeof extractSlackMessages>> => evaluate(`(${extractSlackMessages.toString()})(document, ${JSON.stringify(config.channelId)})`);
        const first = await extract();
        await new Promise(resolve => setTimeout(resolve, 250));
        const extracted = await extract();
        if (JSON.stringify(first) !== JSON.stringify(extracted)) return { messages: [...messages.values()], complete: false };
        if (extracted.unexpanded) return { messages: [...messages.values()], complete: false };
        for (const message of extracted.messages) messages.set(`${message.channelId}:${message.ts}`, message);
        const signature = `${view.page}:${extracted.messages.map(message => message.ts).join(',')}`;
        if (pages.has(signature)) return { messages: [...messages.values()], complete: false };
        pages.add(signature);
        const settled = await state();
        validate(settled);
        if (settled.loading || settled.page !== oldPage || !settled.newest) return { messages: [...messages.values()], complete: false };
        total ??= settled.total;
        if (!settled.hasNext) {
          const verifiedCount = total !== null && messages.size === total && (messages.size > 0 || settled.empty);
          const verifiedPagination = settled.pagination && extracted.messages.length > 0;
          const verifiedEmpty = settled.empty && messages.size === 0 && (total === null || total === 0);
          return { messages: [...messages.values()], complete: total === null ? verifiedPagination || verifiedEmpty : verifiedCount };
        }
        await click('[data-qa="c-pagination_forward_btn"]');
        const oldResults = view.results;
        view = await waitFor(v => !v.loading && v.full && v.page !== oldPage && !!v.results && v.results !== oldResults);
      }
      return { messages: [...messages.values()], complete: false };
    } finally {
      try {
        await restore?.();
      } finally {
        scanning = false;
      }
    }
  }
  return { scan };
}
