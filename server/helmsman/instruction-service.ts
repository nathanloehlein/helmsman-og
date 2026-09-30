import type { RunRow } from './db';
import { instructionDirectory, readInstructions, sendInstruction, InstructionError } from './instruction-channel';

export function createInstructionService(runsDir: string) {
  return {
    async get(run: RunRow) {
      let task: { instructionsDir?: unknown; dockerExecution?: unknown } | null = null;
      try { task = JSON.parse(run.taskJson ?? 'null'); } catch {}
      const reason = run.status !== 'running' ? 'This voyage is no longer running.'
        : task?.dockerExecution ? 'Live instructions are not available for Docker voyages.'
        : !task?.instructionsDir ? 'Started before live instructions were enabled. Start a new voyage to send instructions.' : undefined;
      return readInstructions(instructionDirectory(runsDir, run.id), run.status === 'running', reason);
    },
    async send(run: RunRow, input: unknown) {
      if (run.status !== 'running') throw new InstructionError('This voyage is no longer running.');
      return sendInstruction(instructionDirectory(runsDir, run.id), input);
    },
  };
}
