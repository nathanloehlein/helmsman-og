import type { Clarification } from './data/clarifications';

export interface QuestionChime {
  readonly ready: boolean;
  unlock(): Promise<void>;
  play(): boolean;
  cancel(): void;
  dispose(): void;
}

export function createQuestionChime(): QuestionChime {
  let context: AudioContext | null = null;
  let disposed = false;
  const tones = new Map<OscillatorNode, GainNode>();
  const cancel = () => {
    for (const [oscillator, gain] of tones) {
      try { oscillator.stop(); } catch {}
      oscillator.disconnect(); gain.disconnect();
    }
    tones.clear();
  };
  return {
    get ready() { return !disposed && context?.state === 'running'; },
    async unlock() {
      if (disposed) return;
      try {
        const Audio = globalThis.AudioContext;
        if (!Audio) return;
        context ??= new Audio();
        if (context.state === 'suspended') await context.resume();
      } catch {}
    },
    play() {
      if (disposed || context?.state !== 'running') return false;
      try {
        cancel();
        for (const [index, frequency] of [660, 880].entries()) {
          const oscillator = context.createOscillator(); const gain = context.createGain();
          const start = context.currentTime + index * 0.14;
          oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.025, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.13);
          oscillator.connect(gain); gain.connect(context.destination); tones.set(oscillator, gain);
          oscillator.onended = () => { tones.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
          oscillator.start(start); oscillator.stop(start + 0.14);
        }
        return true;
      } catch { cancel(); return false; }
    },
    cancel,
    dispose() { disposed = true; cancel(); void context?.close().catch(() => {}); context = null; },
  };
}

export class QuestionAlerts {
  private repo: string | null | undefined = undefined;
  private questionsOpen = false;
  private disposed = false;
  private sequence = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<string>();
  private readonly heard = new Set<string>();
  private unlocking = false;
  private readonly read: (repo: string | null, signal: AbortSignal) => Promise<Clarification[]>;
  private readonly changed: (count: number) => void;
  private readonly chime: QuestionChime;

  constructor(options: { read(repo: string | null, signal: AbortSignal): Promise<Clarification[]>; changed(count: number): void; chime?: QuestionChime }) {
    this.read = options.read; this.changed = options.changed; this.chime = options.chime ?? createQuestionChime();
  }
  get count(): number { return this.questionsOpen ? 0 : this.pending.size; }
  update(repo: string | null, questionsOpen: boolean): void {
    if (this.disposed || this.repo === repo && this.questionsOpen === questionsOpen) return;
    if (questionsOpen) for (const id of this.pending) this.heard.add(id);
    this.repo = repo; this.questionsOpen = questionsOpen; this.pending.clear(); this.chime.cancel(); this.changed(0);
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.repo === undefined) return;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort(); const controller = new AbortController(); this.controller = controller;
    const sequence = ++this.sequence; const repo = this.repo;
    try {
      const items = await this.read(repo, controller.signal);
      if (this.disposed || controller.signal.aborted || sequence !== this.sequence) return;
      const now = Date.now();
      const pending = new Set((Array.isArray(items) ? items : []).flatMap(item => {
        if (!item || item.state !== 'pending' || item.answer !== null || typeof item.id !== 'string' || !item.id || typeof item.runId !== 'string' || !item.runId
          || typeof item.repo !== 'string' || !item.repo || repo !== null && item.repo.toLowerCase() !== repo.toLowerCase()
          || item.timeoutAt !== null && (typeof item.timeoutAt !== 'string' || !Number.isFinite(Date.parse(item.timeoutAt)) || Date.parse(item.timeoutAt) <= now)) return [];
        return [JSON.stringify([item.repo.toLowerCase(), item.runId, item.id])];
      }));
      this.pending = pending;
      if (this.questionsOpen) for (const id of pending) this.heard.add(id);
      else if (this.chime.ready && [...pending].some(id => !this.heard.has(id)) && this.chime.play()) for (const id of pending) this.heard.add(id);
      if (!pending.size || this.questionsOpen) this.chime.cancel();
      this.changed(this.count);
    } catch {
      if (!this.disposed && !controller.signal.aborted && sequence === this.sequence) { this.pending.clear(); this.chime.cancel(); this.changed(0); }
    } finally {
      if (!this.disposed && sequence === this.sequence) this.timer = setTimeout(() => { void this.refresh(); }, 5000);
    }
  }
  async unlockAudio(): Promise<void> {
    if (this.disposed || this.unlocking || this.chime.ready) return;
    this.unlocking = true;
    try { await this.chime.unlock(); if (!this.disposed) await this.refresh(); }
    catch {}
    finally { this.unlocking = false; }
  }
  dispose(): void {
    this.disposed = true; ++this.sequence; this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear(); this.chime.dispose();
  }
}
