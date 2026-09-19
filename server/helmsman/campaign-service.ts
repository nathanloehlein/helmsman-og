import { CampaignConflictError, CampaignValidationError, type CampaignStore, type PhaseAction } from './campaigns';
import type { Campaign, CampaignWorkflow } from '../../src/data/campaigns';

export interface CampaignRouteResult { status: number; json: unknown }
export interface CampaignService {
  handle(path: string, method: string, query: URLSearchParams, body: unknown): Promise<CampaignRouteResult | null>;
}

export function createCampaignService(deps: {
  store: CampaignStore;
  configuredRepos(): string[];
  workflows(): CampaignWorkflow[];
  dispatch(): Promise<void>;
}): CampaignService {
  const { store } = deps;
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CampaignValidationError('Provide an object');
    return value as Record<string, unknown>;
  };
  const configured = (repo: string): boolean => deps.configuredRepos().some(value => value.toLowerCase() === repo.toLowerCase());
  function scoped(campaign: Campaign | null, scope: string | null): Campaign {
    if (!campaign) throw new CampaignValidationError('Campaign not found');
    if (!configured(campaign.repo)) throw new CampaignConflictError('Campaign galleon is no longer configured');
    if (scope && campaign.repo.toLowerCase() !== scope.toLowerCase()) throw new CampaignConflictError('Campaign belongs to another galleon');
    return campaign;
  }
  return {
    async handle(path, method, query, body) {
      if (!path.startsWith('/api/campaigns')) return null;
      try {
        const scope = query.get('repo');
        if (scope !== null && !configured(scope)) throw new CampaignValidationError('Select a configured galleon');
        if (path === '/api/campaigns' && method === 'GET') return { status: 200, json: { campaigns: store.list(scope).filter(campaign => configured(campaign.repo)), workflows: deps.workflows() } };
        if (path === '/api/campaigns' && method === 'POST') {
          if (!scope) throw new CampaignValidationError('Select a galleon before creating a campaign');
          const input = object(body);
          if ('repo' in input && input.repo !== scope) throw new CampaignValidationError('Campaign must use the selected galleon');
          if (!deps.workflows().some(workflow => workflow.ref === input.workflowRef)) throw new CampaignValidationError('Select a saved workflow');
          return { status: 201, json: { campaign: store.create({ ...input, repo: scope }) } };
        }
        const campaignMatch = path.match(/^\/api\/campaigns\/([a-z\d_-]+)(\/phases)?$/i);
        if (campaignMatch) {
          const campaign = scoped(store.get(campaignMatch[1]!), scope);
          if (method === 'GET' && !campaignMatch[2]) return { status: 200, json: { campaign, phases: store.phases(campaign.id).map(phase => ({ phase, tasks: store.tasks(phase.id) })) } };
          if (method === 'POST' && campaignMatch[2]) return { status: 201, json: { phase: store.createPhase(campaign.id, body) } };
        }
        const phaseMatch = path.match(/^\/api\/campaigns\/phases\/([a-z\d_-]+)\/(actions|preview)$/i);
        if (phaseMatch && method === 'POST') {
          const phase = store.phase(phaseMatch[1]!);
          if (!phase) throw new CampaignValidationError('Phase not found');
          const campaign = scoped(store.get(phase.campaignId), scope);
          const input = object(body);
          if (phaseMatch[2] === 'preview') {
            if (Object.keys(input).some(key => !['format', 'content'].includes(key))) throw new CampaignValidationError('Unsupported import option');
            return { status: 200, json: { preview: store.previewImport({ ...input, phaseId: phase.id, repo: campaign.repo, allowedRepos: deps.configuredRepos() }) } };
          }
          if (Object.keys(input).some(key => key !== 'action') || typeof input.action !== 'string' || !['start', 'pause', 'resume', 'finish', 'stop'].includes(input.action)) throw new CampaignValidationError('Invalid phase action');
          if (input.action === 'start' || input.action === 'resume') {
            if (!deps.workflows().some(workflow => workflow.ref === campaign.workflowRef)) throw new CampaignConflictError('Campaign workflow is unavailable');
            if (store.tasks(phase.id).some(task => !configured(task.record.repo))) throw new CampaignConflictError('A task galleon is no longer configured');
          }
          const updated = store.setPhaseState(phase.id, input.action as PhaseAction);
          await deps.dispatch();
          return { status: 200, json: { phase: updated } };
        }
        const confirm = path.match(/^\/api\/campaigns\/previews\/([a-z\d_-]+)\/confirm$/i);
        if (confirm && method === 'POST') {
          const preview = store.preview(confirm[1]!);
          if (!preview) throw new CampaignValidationError('Preview not found');
          scoped(store.get(preview.campaignId), scope);
          if (preview.records.some(record => !configured(record.repo))) throw new CampaignConflictError('An imported galleon is no longer configured; create a new preview');
          return { status: 200, json: { tasks: store.confirmImport(preview.id) } };
        }
        const retry = path.match(/^\/api\/campaigns\/tasks\/([a-z\d_-]+)\/retry$/i);
        if (retry && method === 'POST') {
          const task = store.task(retry[1]!);
          if (!task) throw new CampaignValidationError('Task not found');
          scoped(store.get(task.campaignId), scope);
          if (!configured(task.record.repo)) throw new CampaignConflictError('Task galleon is no longer configured');
          const next = store.retryTask(task.id);
          await deps.dispatch();
          return { status: 200, json: { task: next } };
        }
        return { status: 404, json: { error: 'Campaign route not found' } };
      } catch (error) {
        if (error instanceof CampaignValidationError || error instanceof CampaignConflictError) return { status: error instanceof CampaignConflictError ? 409 : 400, json: { error: error.message } };
        throw error;
      }
    },
  };
}

export function handleCampaignRoute(service: CampaignService, path: string, method: string, query: URLSearchParams, body: unknown): Promise<CampaignRouteResult | null> {
  return service.handle(path, method, query, body);
}
