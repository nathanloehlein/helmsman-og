import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, type AppRoute, type PageView } from './routes';

const parse = (href: string) => parseRoute(new URL(href, 'https://helmsman.example'));

describe('routes', () => {
  it.each([
    ['/', 'dashboard'], ['/helm', 'dashboard'], ['/triage', 'triage'],
    ['/cmux', 'cmux'], ['/bugs', 'bugs'], ['/prs', 'prs'], ['/pr', 'prs'],
    ['/config', 'config'], ['/runs', 'runs'], ['/runs/', 'runs'], ['/unknown', 'dashboard'],
  ])('resolves %s to %s', (path, view) => {
    expect(parse(path).view).toBe(view);
  });

  it('returns explicit nulls for absent parameters', () => {
    expect(parse('/')).toEqual({
      view: 'dashboard', repo: null, pane: null, pr: null, run: null,
      mode: null, ticket: null, surface: null,
    });
  });

  it('loads a review form route without requiring a tracked repo', () => {
    expect(parse('/runs?repo=another-org%2Fsome.repo&pane=newrun&pr=10280&mode=review')).toMatchObject({
      view: 'runs', repo: 'another-org/some.repo', pane: 'newrun', pr: 10280, mode: 'review',
    });
  });

  it('retains an existing run identifier independently of a repo', () => {
    expect(parse('/runs?run=99723f3e-ff89-433a-8621-f30a48b96fd4').run)
      .toBe('99723f3e-ff89-433a-8621-f30a48b96fd4');
  });

  it.each(['0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '9007199254740992', ' 12', '12x'])('ignores malformed PR number %s', (pr) => {
    expect(parse(`/prs?repo=owner/repo&pr=${encodeURIComponent(pr)}`).pr).toBeNull();
  });

  it.each(['owner', '/repo', 'owner/', 'owner/repo/extra', '-owner/repo', 'owner/..', 'owner/a b', 'owner/r?evil'])('ignores malformed repo %s and its PR', (repo) => {
    const route = parse(`/prs?repo=${encodeURIComponent(repo)}&pr=123`);
    expect(route.repo).toBeNull();
    expect(route.pr).toBeNull();
  });

  it('requires a repo to interpret a PR number', () => {
    expect(parse('/prs?pr=123').pr).toBeNull();
  });

  it.each([
    ['dashboard', 'repoprs'], ['triage', 'mine'], ['cmux', 'screen'],
    ['prs', 'review-requests'], ['runs', 'tasks'],
  ] as [PageView, string][])('accepts a pane belonging to %s', (view, pane) => {
    expect(parse(routeHref({ view, pane })).pane).toBe(pane);
  });

  it.each(['/bugs?pane=recent', '/config?pane=newrun', '/triage?pane=diff', '/prs?pane=mine'])('ignores panes outside their page: %s', (href) => {
    expect(parse(href).pane).toBeNull();
  });

  it.each(['/runs?mode=review', '/runs?mode=rerun', '/prs?mode=review', '/prs?mode=rerun'])('accepts PR actions at %s', (href) => {
    expect(parse(href).mode).toBe(href.split('=')[1]);
  });

  it.each(['/helm?mode=review', '/triage?mode=rerun', '/runs?mode=launch'])('ignores invalid action scopes: %s', (href) => {
    expect(parse(href).mode).toBeNull();
  });

  it.each(['../run', 'with space', 'a'.repeat(129), '<script>'])('ignores invalid run IDs: %s', (run) => {
    expect(parse(`/runs?run=${encodeURIComponent(run)}`).run).toBeNull();
  });

  it('normalizes Jira keys and ignores invalid ticket values', () => {
    expect(parse('/runs?ticket=airo_2-123').ticket).toBe('AIRO_2-123');
    expect(parse('/runs?ticket=123').ticket).toBeNull();
    expect(parse('/runs?ticket=AIRO-0').ticket).toBeNull();
  });

  it('accepts only positive cmux surface references on the cmux page', () => {
    expect(parse('/cmux?surface=surface%3A15').surface).toBe('surface:15');
    expect(parse('/runs?surface=surface%3A15').surface).toBeNull();
    expect(parse('/cmux?surface=surface%3A0').surface).toBeNull();
    expect(parse('/cmux?surface=workspace%3A15').surface).toBeNull();
    expect(parse('/cmux?surface=surface%3A9007199254740992').surface).toBeNull();
  });

  it('accepts bare wezterm pane ids, which are 0-based', () => {
    expect(parse('/cmux?surface=0').surface).toBe('0');
    expect(parse('/cmux?surface=7').surface).toBe('7');
    expect(parse('/runs?surface=7').surface).toBeNull();
    expect(parse('/cmux?surface=9007199254740992').surface).toBeNull();
    expect(parse('/cmux?surface=-1').surface).toBeNull();
    expect(parse('/cmux?surface=1;rm').surface).toBeNull();
  });

  it('serializes canonical paths and encoded parameters', () => {
    expect(routeHref({ view: 'dashboard' })).toBe('/helm');
    expect(routeHref({ view: 'prs', repo: 'owner/my.repo', pane: 'diff', pr: 42 }))
      .toBe('/prs?repo=owner%2Fmy.repo&pane=diff&pr=42');
    expect(routeHref({ view: 'cmux', surface: 'surface:15' })).toBe('/cmux?surface=surface%3A15');
    expect(routeHref(parse('/pr?repo=owner/repo&pr=42'))).toBe('/prs?repo=owner%2Frepo&pr=42');
  });

  it('omits invalid, null, and unspecified parameters when serializing', () => {
    expect(routeHref({ view: 'prs', repo: 'bad repo', pr: 42, pane: 'recent', run: null }))
      .toBe('/prs');
    expect(routeHref({ view: 'runs', pr: -1, ticket: 'foo-42' })).toBe('/runs?ticket=FOO-42');
  });

  it('round-trips a complete route while discarding unrelated query and fragment values', () => {
    const route: AppRoute = {
      view: 'runs', repo: 'owner/repo', pane: 'newrun', pr: 123,
      run: 'run_42', mode: 'rerun', ticket: 'AIRO-42', surface: null,
    };
    expect(parse(`${routeHref(route)}&unused=1#other`)).toEqual(route);
    expect(routeHref(parse(`${routeHref(route)}&unused=1#other`))).toBe(routeHref(route));
  });
});
