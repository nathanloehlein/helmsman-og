import { homedir } from 'node:os';
import { join } from 'node:path';
import { refreshCodexCostSidebar } from '../server/helmsman/cmux/codex-cost-sidebar.ts';

const options = { cmuxPath: 'cmux', stateDir: join(homedir(), '.local', 'state', 'helmsman', 'cmux-costs'), dryRun: false, clear: false };
try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--clear') options.clear = true;
    else if (arg === '--cmux' || arg === '--state-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg === '--cmux' ? 'cmuxPath' : 'stateDir'] = value;
    } else if (arg === '--help') {
      process.stdout.write('Refresh native cmux sidebar Codex API estimates.\nOptions: --dry-run --clear --cmux <executable> --state-dir <directory>\n');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  const result = await refreshCodexCostSidebar(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Codex cost refresh failed. Check cmux access and local session files.\n');
  process.exitCode = 1;
}
