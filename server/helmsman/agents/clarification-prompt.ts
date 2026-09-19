import type { AgentTask } from './adapter';

export function clarificationPrompt(task: AgentTask): string {
  if (!task.clarification) return '';
  return `If a required human decision prevents safe progress, append one JSON object and a newline to ${JSON.stringify(task.clarification.questionsPath)}: {"kind":"question","id":"<unique UUID>","required":true,"prompt":"<concise question>","owner":"local","timeoutAt":"<UTC deadline>"}. Wait for a matching answered record in ${JSON.stringify(task.clarification.answersPath)} before dependent work. Continue independent work while waiting. Never infer an answer from a timeout, missing record, cancellation or null answer. Exit unsuccessfully if a required question expires. Optional questions use required:false and do not block. Do not send messages to external contacts. Waiting retains this voyage's concurrency slot.`;
}
