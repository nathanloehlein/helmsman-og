import { describe, expect, it } from 'vitest';
import { implementationGuidance, reviewGuidance } from './review-calibration';

describe('role-specific prompt guidance', () => {
  it('keeps a safety baseline for ordinary tasks without detailed parser instructions', () => {
    for (const render of [implementationGuidance, reviewGuidance]) {
      const value = render({ title: 'Correct button alignment' }).join('\n');
      expect(value).toContain('verify effective time/memory bounds');
      expect(value).not.toContain('Parser containment:');
      expect(value).toContain('honor required repository checks');
      expect(value).toContain('Repeat only after relevant code/environment changes');
      expect(value).toContain('Prior approval never replaces required review');
    }
  });
  it.each([
    [{ title: 'Sanitize uploads' }, undefined],
    [{ title: 'Fix import', jiraContext: 'Parse attacker-controlled XML' }, undefined],
    [{ task: 'Contain resource exhaustion' }, undefined],
    [{ title: 'Fix regression' }, 'The SVG parser is unbounded'],
  ])('includes parser containment when relevant task evidence is supplied', (task, feedback) => {
    for (const render of [implementationGuidance, reviewGuidance]) {
      const value = render(task, feedback).join('\n');
      expect(value).toContain('Parser containment:');
      expect(value).toContain('Same-thread timers cannot interrupt synchronous parsing');
      expect(value).toContain('worker heap limits may exclude native/external allocations');
      expect(value).toContain('reject input and clean up on breach');
    }
  });
  it('assigns defect falsification to reviewers and implementation planning to authors', () => {
    const author = implementationGuidance({}).join('\n');
    const reviewer = reviewGuidance({}).join('\n');
    expect(author).toContain('Before changing code');
    expect(author).not.toContain('Before reporting a defect');
    expect(reviewer).not.toContain('Before changing code');
    expect(reviewer).toContain('test the strongest counterargument');
    expect(reviewer).toContain('existing guards, caller constraints, configuration and runtime behavior');
    expect(reviewer).toContain('specific error in prior reasoning');
    expect(reviewer).toContain('Missing/truncated history proves nothing was settled');
  });
});
