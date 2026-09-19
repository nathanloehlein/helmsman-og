#!/usr/bin/env node
const repo = process.env.HELMSMAN_REPO;
const base = process.env.HELMSMAN_GATEWAY_BASE_URL ?? process.env.HELMSMAN_GATEWAY_URL;
const token = process.env.HELMSMAN_CAPABILITY;
const fail = message => { process.stderr.write(`${message}\n`); process.exit(64); };
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !base || !token) fail('Scoped GitHub access is not configured');
const [command, verb, ...rest] = process.argv.slice(2);
async function get(path) {
  if (!path.startsWith(`/repos/${repo}/`) || /%|\\|\.\.|#/.test(path)) fail('GitHub read is outside this run');
  const response = await fetch(`${base}/github${path}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Scoped GitHub read failed (${response.status})`);
  return response.json();
}
try {
  if (command === 'api') {
    if (!verb || rest.length) fail('Only gh api <scoped-path> GET requests are supported');
    process.stdout.write(JSON.stringify(await get(verb.startsWith('/') ? verb : `/${verb}`)) + '\n');
  } else if (command === 'pr' && ['view', 'list'].includes(verb)) {
    let number;
    let fields;
    let comments = false;
    const args = [...rest];
    while (args.length) {
      const arg = args.shift();
      if (arg === '--repo' || arg === '-R') { if (args.shift()?.toLowerCase() !== repo.toLowerCase()) fail('Cannot change this run scope'); }
      else if (arg === '--json') { fields = args.shift()?.split(','); if (!fields?.length) fail('Missing JSON fields'); }
      else if (arg === '--comments') comments = true;
      else if (/^\d+$/.test(arg ?? '') && number === undefined) number = Number(arg);
      else fail('Unsupported read option');
    }
    if (verb === 'view' && (!number || !Number.isSafeInteger(number))) fail('Provide a pull request number');
    const result = await get(`/repos/${repo}/pulls${verb === 'view' ? `/${number}` : ''}`);
    const project = item => {
      if (!item || typeof item !== 'object') throw new Error('Invalid GitHub response');
      const value = { number: item.number, title: item.title, body: item.body, url: item.html_url,
        headRefName: item.head?.ref, headRefOid: item.head?.sha, baseRefName: item.base?.ref, state: item.state,
        author: item.user, isDraft: item.draft, mergedAt: item.merged_at };
      if (!fields) return item;
      if (fields.some(field => !(field in value))) fail('Requested JSON field is not available through the scoped bridge');
      return Object.fromEntries(fields.map(field => [field, value[field]]));
    };
    const output = Array.isArray(result) ? result.map(project) : project(result);
    if (comments && !Array.isArray(output)) {
      output.comments = await get(`/repos/${repo}/issues/${number}/comments`);
      output.reviews = await get(`/repos/${repo}/pulls/${number}/reviews`);
    }
    process.stdout.write(JSON.stringify(output) + '\n');
  } else fail('Container GitHub access is read-only; Helmsman publishes on the host');
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'GitHub read failed'}\n`); process.exit(1); }
