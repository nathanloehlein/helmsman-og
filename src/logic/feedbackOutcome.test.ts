import { describe, expect, it } from 'vitest';
import { normalizeFeedbackOutcomeForStatus, parseFeedbackOutcome } from './feedbackOutcome';

const base = { state: 'completed' as const, headSha: 'a'.repeat(40), summary: 'Feedback addressed.' };

describe('feedback outcome', () => {
  it.each(['completed', 'changes_remaining', 'awaiting_decision'] as const)('accepts %s from JSON and API objects', state => {
    const outcome = { ...base, state };
    expect(parseFeedbackOutcome(outcome)).toEqual(outcome);
    expect(parseFeedbackOutcome(JSON.stringify(outcome))).toEqual(outcome);
  });

  it.each([null, undefined, [], {}, 'invalid JSON', { ...base, state: 'constructor' },
    { ...base, headSha: 'abc' }, { ...base, headSha: 'z'.repeat(40) },
    { ...base, summary: ' ' }, { ...base, summary: 'x'.repeat(4001) }, { ...base, summary: 42 }, 'x'.repeat(16_385),
  ])('ignores malformed outcome %j', value => expect(parseFeedbackOutcome(value)).toBeNull());

  it('retains only validated fields', () => {
    expect(parseFeedbackOutcome({ ...base, summary: '  Done  ', ignored: 'private' })).toEqual({ ...base, summary: 'Done' });
  });

  it.each(['failed', 'stopped', 'succeeded'])('does not leave a %s run awaiting an answer', status => {
    expect(normalizeFeedbackOutcomeForStatus({ ...base, state: 'awaiting_decision' }, status))
      .toMatchObject({ state: 'changes_remaining', summary: expect.stringContaining('not answered before the run ended') });
  });

  it('preserves live decisions and absent legacy metadata', () => {
    const outcome = { ...base, state: 'awaiting_decision' as const };
    expect(normalizeFeedbackOutcomeForStatus(outcome, 'running')).toEqual(outcome);
    expect(normalizeFeedbackOutcomeForStatus(null, 'succeeded')).toBeNull();
    expect(normalizeFeedbackOutcomeForStatus(base, 'succeeded')).toEqual(base);
  });

  it.each(['failed', 'stopped'])('does not expose feedback completion after execution %s', status => {
    expect(normalizeFeedbackOutcomeForStatus(base, status)).toMatchObject({ state: 'changes_remaining',
      summary: expect.stringContaining(`Run ${status} before feedback completion was confirmed.`) });
  });
});
