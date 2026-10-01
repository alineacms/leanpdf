/**
 * The document the page works on. Opening a file probes it in the worker; an encrypted file that
 * opens without a password is decrypted right away, and one that needs a password waits for it.
 * The viewer and the tools follow the state through subscribe().
 */
import type { DecryptReport } from '../../../src/index.ts';
import type { WorkerClient } from './client.ts';
import { describeError } from './format.ts';
import type { Probe } from './probe.ts';

export interface OpenDocument {
  /** What the tools work on: the chosen file, or the decrypted copy of it. */
  file: File;
  /** The file as chosen. */
  original: File;
  probe: Probe;
  /** When the chosen file was encrypted: how, and the decrypted copy (`file`). */
  unlocked?: { method?: string; password?: DecryptReport['password'] };
  /** Changes on every open, so a tool can tell a new document from the same one. */
  id: number;
}

export type DocState =
  | { kind: 'empty' }
  | { kind: 'opening'; file: File }
  | { kind: 'locked'; file: File; probe: Probe; error?: string }
  | { kind: 'failed'; file: File; message: string }
  | { kind: 'open'; doc: OpenDocument };

export class DocStore {
  state: DocState = { kind: 'empty' };
  private readonly listeners = new Set<(s: DocState) => void>();
  private readonly worker: WorkerClient;
  private seq = 0;

  constructor(worker: WorkerClient) {
    this.worker = worker;
  }

  /** The open document, if any. */
  get doc(): OpenDocument | null {
    return this.state.kind === 'open' ? this.state.doc : null;
  }

  subscribe(fn: (s: DocState) => void): void {
    this.listeners.add(fn);
  }

  private set(s: DocState): void {
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Open `file`, replacing the current document. */
  async open(file: File): Promise<void> {
    const seq = ++this.seq;
    this.set({ kind: 'opening', file });
    let probe: Probe;
    try {
      probe = await this.worker.run('probe', { file });
    } catch (err) {
      if (seq === this.seq) this.set({ kind: 'failed', file, message: describeError(err) });
      return;
    }
    if (seq !== this.seq) return;
    if (!probe.encrypted) this.set({ kind: 'open', doc: { file, original: file, probe, id: seq } });
    else if (probe.unsupported) this.set({ kind: 'failed', file, message: `This PDF is encrypted in a way leanpdf can’t remove (${probe.unsupported}).` });
    else if (probe.needsPassword) this.set({ kind: 'locked', file, probe });
    else await this.unlock('', file, probe, seq);
  }

  /** Decrypt the locked document with `password`. */
  async submitPassword(password: string): Promise<void> {
    if (this.state.kind !== 'locked') return;
    const { file, probe } = this.state;
    await this.unlock(password, file, probe, this.seq);
  }

  private async unlock(password: string, file: File, probe: Probe, seq: number): Promise<void> {
    this.set({ kind: 'opening', file });
    try {
      const out = await this.worker.run('unlock', { file, password });
      if (seq !== this.seq) return;
      const copy = new File([out.blob!], file.name, { type: 'application/pdf' });
      this.set({ kind: 'open', doc: { file: copy, original: file, probe: { ...probe, encrypted: false, needsPassword: false }, unlocked: { method: out.report.method, password: out.report.password }, id: seq } });
    } catch (err) {
      if (seq !== this.seq) return;
      const name = err instanceof Error ? err.name : '';
      if (name === 'PdfPasswordError') this.set({ kind: 'locked', file, probe, error: 'That password is not correct.' });
      else this.set({ kind: 'failed', file, message: describeError(err) });
    }
  }

  close(): void {
    this.seq++;
    this.set({ kind: 'empty' });
  }
}
