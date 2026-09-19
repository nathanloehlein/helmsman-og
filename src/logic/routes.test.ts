import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, type AppRoute, type PageView } from './routes';

const parse = (href: string) => parseRoute(new URL(href, 'https://helmsman.example'));

describe('routes', () => {
  it.each([
    ['/', 'dashboard'], ['/helm', 'dashboard'], ['/triage', 'triage'],
    ['/terminal', 'cmux'], ['/terminal/', 'cmux'], ['/cmux', 'cmux'], ['/bugs', 'bugs'], ['/prs', 'prs'], ['/pr', 'prs'],
    ['/config', 'config'], ['/runs', 'runs'], ['/runs/', 'runs'], ['/unknown', 'dashboard'],
    ['/todos', 'todos'], ['/todos/', 'todos'],
  ])('resolves %s to %s', (path, view) => {
    expect(parse(path).view).toBe(view);
  });

  it('returns explicit nulls for absent parameters', () => {
    expect(parse('/')).toEqual({
      view: 'dashboard', repo: null, prRepo: null, pane: null, pr: null, run: null,
      mode: null, ticket: null, surface: null,
    });
  });

  it('loads a review form route without requiring a tracked repo', () => {
    expect(parse('/runs?repo=another-org%2Fsome.repo&pane=newrun&pr=10280&mode=review')).toMatchObject({
      view: 'runs', repo: 'another-org/some.repo', pane: 'newrun', pr: 10280, mode: 'review',
    });
  });

  it.each(['/prs', '/runs'])('keeps header scope separate from an explicit PR panel repository at %s', path => {
    const route = parse(`${path}?repo=owner/header&prRepo=other/panel&pr=42`);
    expect(route).toMatchObject({ repo: 'owner/header', prRepo: 'other/panel', pr: 42 });
    expect(parse(routeHref(route))).toEqual(route);
  });

  it('preserves All galleons while opening an explicit repository PR', () => {
    const route = parse('/runs?prRepo=other/panel&pr=42&pane=newrun&mode=review');
    expect(route).toMatchObject({ repo: null, prRepo: 'other/panel', pr: 42, pane: 'newrun', mode: 'review' });
    expect(routeHref(route)).toBe('/runs?prRepo=other%2Fpanel&pane=newrun&pr=42&mode=review');
  });

  it('retains legacy PR links without adding an implicit override', () => {
    const route = parse('/pr?repo=owner/legacy&pr=42');
    expect(route).toMatchObject({ repo: 'owner/legacy', prRepo: null, pr: 42 });
    expect(routeHref(route)).toBe('/prs?repo=owner%2Flegacy&pr=42');
  });

  it.each(['', 'bad repo', 'owner/..', 'owner/repo/extra'])('does not reinterpret an invalid explicit PR override as the header repository: %j', prRepo => {
    const route = parse(`/prs?repo=owner/header&prRepo=${encodeURIComponent(prRepo)}&pr=42`);
    expect(route).toMatchObject({ repo: 'owner/header', prRepo: null, pr: null });
    expect(routeHref(route)).toBe('/prs?repo=owner%2Fheader');
  });

  it('validates header scope independently of an explicit PR target', () => {
    expect(parse('/prs?repo=bad&prRepo=other/panel&pr=42'))
      .toMatchObject({ repo: null, prRepo: 'other/panel', pr: 42 });
  });

  it.each(['/helm', '/todos', '/terminal', '/config'])('ignores PR panel overrides outside PR pages: %s', path => {
    const route = parse(`${path}?prRepo=other/panel&pr=42`);
    expect(route.prRepo).toBeNull();
    expect(route.pr).toBeNull();
    expect(routeHref(route)).toBe(path);
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

  it('accepts only positive cmux surface references on the terminal page', () => {
    expect(parse('/terminal?surface=surface%3A15').surface).toBe('surface:15');
    expect(parse('/runs?surface=surface%3A15').surface).toBeNull();
    expect(parse('/terminal?surface=surface%3A0').surface).toBeNull();
    expect(parse('/terminal?surface=workspace%3A15').surface).toBeNull();
    expect(parse('/terminal?surface=surface%3A9007199254740992').surface).toBeNull();
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
    expect(routeHref({ view: 'cmux', surface: 'surface:15' })).toBe('/terminal?surface=surface%3A15');
    expect(routeHref(parse('/cmux?repo=owner/repo&pane=screen&surface=surface:15')))
      .toBe('/terminal?repo=owner%2Frepo&pane=screen&surface=surface%3A15');
    expect(routeHref(parse('/pr?repo=owner/repo&pr=42'))).toBe('/prs?repo=owner%2Frepo&pr=42');
  });

  it('omits invalid, null, and unspecified parameters when serializing', () => {
    expect(routeHref({ view: 'prs', repo: 'bad repo', pr: 42, pane: 'recent', run: null }))
      .toBe('/prs');
    expect(routeHref({ view: 'runs', pr: -1, ticket: 'foo-42' })).toBe('/runs?ticket=FOO-42');
  });

  it('round-trips a complete route while discarding unrelated query and fragment values', () => {
    const route: AppRoute = {
      view: 'runs', repo: 'owner/repo', prRepo: 'other/repo', pane: 'newrun', pr: 123,
      run: 'run_42', mode: 'rerun', ticket: 'AIRO-42', surface: null,
    };
    expect(parse(`${routeHref(route)}&unused=1#other`)).toEqual(route);
    expect(routeHref(parse(`${routeHref(route)}&unused=1#other`))).toBe(routeHref(route));
  });
});
