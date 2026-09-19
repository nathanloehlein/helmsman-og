import { findSlackBrowserSurface, runSlackBrowserCommand, slackBrowserEvaluation, surfaceSelection, withSlackBrowserLock, type SlackBrowserConfig, type SlackBrowserTransport } from './browser';
import { SlackReviewError } from './review-request';
import { sendPreparedSlackReview } from './browser-review-send';

interface ReviewInput { repo: string; prNumber: number; requestId: string; channel: string; mention: string }
interface ReviewResult { channel: string; mention: string; permalink: string | null }

export function inspectSlackReviewPage(doc: Document) {
  const clean = (text: string | null | undefined) => (text ?? '').replace(/[\s\u200b]+/g, ' ').trim();
  const editors = Array.from(doc.querySelectorAll<HTMLElement>('[contenteditable="true"]:not([aria-hidden="true"])')).filter(element => !element.closest('[data-qa="thread_view"], .p-threads_view, .p-thread_view')
    && (element.matches('[data-qa="message_input"], .ql-editor') || !!element.closest('[data-qa="message_input"]')));
  const editor = editors.length === 1 ? editors[0] : undefined;
  const name = clean(doc.querySelector('[data-qa="channel_name"], [data-qa="channel_header_name"]')?.textContent).replace(/^#/, '');
  const groups = (parent: Element) => Array.from(parent.querySelectorAll('ts-mention[data-id], [data-user-group-id], [data-usergroup-id], [data-mention-id], [data-group-id], [data-stringify-id]')).flatMap(element => {
    const id = element.getAttribute('data-id') ?? element.getAttribute('data-user-group-id') ?? element.getAttribute('data-usergroup-id') ?? element.getAttribute('data-mention-id') ?? element.getAttribute('data-group-id') ?? element.getAttribute('data-stringify-id');
    return id && /^S[A-Z\d]{2,31}$/.test(id) ? [{ id, text: clean(element.textContent).replace(/^@/, '') }] : [];
  });
  const rows = Array.from(doc.querySelectorAll('[data-qa="message_container"]')).flatMap(row => {
    const identity = row.querySelector('a[data-ts]');
    const body = row.querySelector('[data-qa="message-text"]');
    const channel = row.querySelector('[data-message-channel]')?.getAttribute('data-message-channel') ?? row.getAttribute('data-message-channel') ?? row.getAttribute('data-msg-channel-id');
    const ts = identity?.getAttribute('data-ts');
    if (!body || !ts || !/^\d+\.\d+$/.test(ts) || row.querySelector('[data-qa="message_send_error"], [data-qa="message_sending"], .c-message_kit__message--error')) return [];
    return [{ channel, ts, text: clean(body.textContent), groups: groups(body), href: identity?.getAttribute('href') ?? null }];
  });
  return {
    href: doc.location.href, name, channelId: editor?.closest('[data-channel-id]')?.getAttribute('data-channel-id') ?? null, editors: editors.length, draft: editor ? clean(editor.textContent) : null,
    groups: editor ? groups(editor) : [],
    attachments: !!doc.querySelector('[data-qa="composer_file_upload"], [data-qa="file_upload_preview"], .p-composer__attachments > *'),
    otherDraft: Array.from(doc.querySelectorAll('[contenteditable="true"]:not([aria-hidden="true"])')).some(element => element !== editor && (element.matches('.ql-editor, [data-qa="texty_input"]') || !!element.closest('[data-qa="message_input"]')) && !!clean(element.textContent)),
    rows,
  };
}

export function markSlackReviewChannel(doc: Document, target: string): { id: string; name: string } | null {
  const matches = Array.from(doc.querySelectorAll('[data-channel-id]')).flatMap(element => {
    const id = element.getAttribute('data-channel-id');
    const name = (element.querySelector('[data-qa="inline_channel_entity__name"], [data-qa="channel_name"]')?.textContent ?? element.textContent ?? '').trim().replace(/^#/, '');
    return id && /^[CG][A-Z\d]{2,31}$/.test(id) && (id === target || name === target) && /^[a-z\d_-]{1,80}$/.test(name) ? [{ element, id, name }] : [];
  });
  const identities = new Set(matches.map(match => match.id));
  if (identities.size !== 1) return null;
  const match = matches[0];
  if (!match) return null;
  doc.querySelectorAll('[data-helmsman-review-channel]').forEach(element => element.removeAttribute('data-helmsman-review-channel'));
  match.element.setAttribute('data-helmsman-review-channel', 'true');
  return { id: match.id, name: match.name };
}

export function markSlackReviewGroup(doc: Document, handle: string): { id: string; handle: string } | null {
  const options = Array.from(doc.querySelectorAll('[role="option"]')).flatMap(option => {
    const entity = option.matches('[data-usergroup-id], [data-group-id], [data-entity-id]') ? option : option.querySelector('[data-usergroup-id], [data-group-id], [data-entity-id]');
    const id = entity?.getAttribute('data-usergroup-id') ?? entity?.getAttribute('data-group-id') ?? entity?.getAttribute('data-entity-id');
    const names = Array.from(option.querySelectorAll('*')).concat(option).map(element => element.textContent?.trim().replace(/^@/, ''));
    return id && /^S[A-Z\d]{2,31}$/.test(id) && names.includes(handle) ? [{ option, id }] : [];
  });
  if (options.length !== 1 || !options[0]) return null;
  doc.querySelectorAll('[data-helmsman-review-group]').forEach(element => element.removeAttribute('data-helmsman-review-group'));
  options[0].option.setAttribute('data-helmsman-review-group', 'true');
  return { id: options[0].id, handle };
}

export function createSlackBrowserReviewSender(config: SlackBrowserConfig, transport: SlackBrowserTransport = runSlackBrowserCommand): { send(input: ReviewInput): Promise<ReviewResult> } {
  return { send: input => withSlackBrowserLock(async () => {
    let attempted = false;
    let restore: (() => Promise<void>) | undefined;
    try {
      if (!/^[A-Z\d]{3,32}$/.test(config.clientId) || !/^[CG][A-Z\d]{2,31}$/.test(config.channelId)
        || !/^[a-z\d_-]{1,80}$/.test(config.channelName)) throw new SlackReviewError('Configure the authenticated Slack browser workspace and channel.', 503);
      if (!input || typeof input.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(input.repo) || !Number.isSafeInteger(input.prNumber) || input.prNumber < 1
        || !/^[a-f\d-]{36}$/i.test(input.requestId) || !/^(?:[CG][A-Z\d]{2,31}|[a-z\d_-]{1,80})$/.test(input.channel)
        || !/^[a-z\d_-]{1,80}$/.test(input.mention)) throw new SlackReviewError('Use a valid PR, channel name or ID, and Slack user group handle.', 400);
      const tree = JSON.parse(await transport(['--id-format', 'both', 'tree', '--all', '--json'])) as unknown;
      const surface = config.surface ?? findSlackBrowserSurface(tree, config);
      const selection = surfaceSelection(tree, surface);
      if (!selection) throw new SlackReviewError('Authenticated Slack browser surface is unavailable.', 503);
      const deadline = Date.now() + 60_000;
      const evaluate = async <T>(script: string): Promise<T> => {
        if (Date.now() > deadline) throw new Error('Slack browser request timed out');
        return JSON.parse(await transport(['browser', surface, 'eval', slackBrowserEvaluation(script)])) as T;
      };
      const state = () => evaluate<ReturnType<typeof inspectSlackReviewPage>>(`(${inspectSlackReviewPage.toString()})(document)`);
      const workspace = (view: Awaited<ReturnType<typeof state>>) => {
        const url = new URL(view.href);
        if (url.origin !== 'https://app.slack.com' || !url.pathname.startsWith(`/client/${config.clientId}/`)) throw new SlackReviewError('Slack browser is outside the configured workspace.', 409);
        return url;
      };
      const focus = (target: string) => transport(['rpc', 'surface.focus', JSON.stringify({ surface_id: target })]);
      if (selection.selected !== selection.surface) {
        await focus(selection.surface);
        restore = async () => {
          const current = surfaceSelection(JSON.parse(await transport(['--id-format', 'both', 'tree', '--all', '--json'])), selection.surface);
          if (current?.selected !== selection.surface || ![selection.surface, selection.active].includes(current.active)) return;
          await focus(selection.selected);
          if (selection.active !== selection.selected) await focus(selection.active);
        };
      }
      let view = await state();
      workspace(view);
      if (view.draft || view.otherDraft || view.attachments) throw new SlackReviewError('Slack has an existing draft or attachment. Finish or clear it before requesting a review.', 409);
      const click = (selector: string) => transport(['browser', surface, 'click', selector]);
      const poll = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const value = await read();
          if (ready(value)) return value;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw new Error('Slack did not reach the required view');
      };
      const currentChannel = () => {
        const id = workspace(view).pathname.split('/')[3];
        return id && /^[CG][A-Z\d]{2,31}$/.test(id) && (input.channel === id || input.channel === view.name) && view.editors === 1 && view.channelId === id
          ? { id, name: view.name } : null;
      };
      let channel = currentChannel();
      if (!channel && workspace(view).pathname.endsWith('/search') && [config.channelId, config.channelName].includes(input.channel)) {
        await click('[data-qa="tab_rail_home_button"]');
        view = await poll(state, value => !workspace(value).pathname.endsWith('/search') && value.editors === 1 && !!value.channelId);
        channel = currentChannel();
      }
      if (!channel) {
        await click('[data-qa="top_nav_search"]');
        await transport(['browser', surface, 'wait', '--selector', '[role="combobox"][aria-label="Query"]', '--timeout-ms', '10000']);
        await transport(['browser', surface, 'fill', '[role="combobox"][aria-label="Query"]', input.channel]);
        channel = await poll(() => evaluate<ReturnType<typeof markSlackReviewChannel>>(`(${markSlackReviewChannel.toString()})(document, ${JSON.stringify(input.channel)})`), value => !!value);
        if (!channel) throw new SlackReviewError('Slack channel could not be resolved through the browser.', 409);
        await click('[data-helmsman-review-channel="true"]');
        view = await poll(state, value => workspace(value).pathname === `/client/${config.clientId}/${channel?.id}` && value.name === channel?.name && value.channelId === channel?.id && value.editors === 1);
      }
      if (view.draft || view.otherDraft || view.attachments) throw new SlackReviewError('The Slack channel has an existing draft or attachment. Finish or clear it before requesting a review.', 409);
      const editor = '[data-helmsman-review-editor="true"]';
      const marked = await evaluate<boolean>(`(() => { const editors = Array.from(document.querySelectorAll('[contenteditable="true"]:not([aria-hidden="true"])')).filter(e => !e.closest('[data-qa="thread_view"], .p-threads_view, .p-thread_view') && (e.matches('[data-qa="message_input"], .ql-editor') || e.closest('[data-qa="message_input"]'))); if (editors.length !== 1 || editors[0].textContent.trim()) return false; editors[0].setAttribute('data-helmsman-review-editor', 'true'); return true; })()`);
      if (!marked) throw new SlackReviewError('Slack channel composer is unavailable or contains a draft.', 409);
      const body = `Could you review this PR? https://github.com/${input.repo}/pull/${input.prNumber}`;
      const expected = `@${input.mention} ${body}`;
      await transport(['browser', surface, 'fill', editor, expected]);
      const resolved = await poll(async () => {
        const current = await state();
        workspace(current);
        const chip = current.groups.length === 1 && current.groups[0]?.text === input.mention ? current.groups[0] : null;
        if (chip) return { id: chip.id, handle: input.mention, selected: true };
        const option = await evaluate<ReturnType<typeof markSlackReviewGroup>>(`(${markSlackReviewGroup.toString()})(document, ${JSON.stringify(input.mention)})`);
        return option ? { ...option, selected: false } : null;
      }, value => !!value);
      if (!resolved) throw new SlackReviewError('Slack user group could not be resolved.', 409);
      const group = resolved;
      if (!group.selected) await click('[data-helmsman-review-group="true"]');
      view = await state();
      if (workspace(view).pathname !== `/client/${config.clientId}/${channel.id}` || view.name !== channel.name || view.channelId !== channel.id || view.editors !== 1 || view.attachments || view.otherDraft
        || view.draft !== expected || view.groups.length !== 1 || view.groups[0]?.id !== group.id) throw new SlackReviewError('Slack draft or destination changed. Nothing was sent; inspect the draft before retrying.', 409);
      const prior = new Set(view.rows.map(row => row.ts));
      attempted = true;
      const send = await evaluate<boolean>(`(${sendPreparedSlackReview.toString()})(document, ${JSON.stringify({ clientId: config.clientId, channelId: channel.id, channelName: channel.name, groupId: group.id, text: expected })}, ${inspectSlackReviewPage.toString()})`);
      if (!send) {
        attempted = false;
        throw new SlackReviewError('Slack draft or destination changed. Nothing was sent; inspect the draft before retrying.', 409);
      }
      const receipt = await poll(state, value => {
        if (workspace(value).pathname !== `/client/${config.clientId}/${channel?.id}`) return false;
        return !value.draft && value.rows.some(row => !prior.has(row.ts) && row.channel === channel?.id && row.text === expected && row.groups.some(mention => mention.id === group.id));
      });
      const sent = receipt.rows.find(row => !prior.has(row.ts) && row.channel === channel?.id && row.text === expected && row.groups.some(mention => mention.id === group.id));
      let permalink: string | null = null;
      if (sent?.href) {
        try {
          const url = new URL(sent.href, 'https://app.slack.com');
          if (url.protocol === 'https:' && url.hostname.endsWith('.slack.com') && !url.username && !url.password && url.pathname === `/archives/${channel.id}/p${sent.ts.replace('.', '')}`) permalink = url.href;
        } catch {}
      }
      return { channel: channel.name, mention: group.handle, permalink };
    } catch (error) {
      if (attempted) throw new SlackReviewError('Slack delivery could not be confirmed. Check the channel before requesting again.', 502, true);
      if (error instanceof SlackReviewError) throw error;
      throw new SlackReviewError('Slack browser request could not be prepared. Check the signed-in browser and any draft before retrying.', 503, false);
    } finally {
      try { await restore?.(); } catch {}
    }
  }) };
}
