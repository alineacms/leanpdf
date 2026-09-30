/**
 * The Unlock tool: write an unencrypted copy of an encrypted PDF (./job.ts), with the password
 * that opens it or the owner password.
 */
import { unlock } from '../../../pages/icons.ts';
import { fmtBytes, refs } from '../../format.ts';
import { actionsHtml, Drop, dropHtml, outputName, Result, resultHtml, Runner, sizeFacts, statusHtml, warningsFact, wireActions } from '../../kit.ts';
import type { Probe } from '../../probe.ts';
import { pagesText } from '../../ranges.ts';
import type { Tool, ToolContext } from '../../tool.ts';

const TEMPLATE = `
<div class="tool-layout">
  <form class="card" data-ref="form" novalidate aria-label="Unlock a PDF">
    ${dropHtml('unlock')}
    <p class="status-line" id="unlock-state" data-ref="state" aria-live="polite"></p>
    <fieldset class="options">
      <legend>Password</legend>
      <div class="field">
        <label for="unlock-password">Password</label>
        <input type="password" class="input" id="unlock-password" data-ref="password" autocomplete="off" spellcheck="false" aria-describedby="unlock-password-hint">
      </div>
      <p class="hint" id="unlock-password-hint">The password that opens the document, or its owner password. Leave it empty for a PDF that opens without one and only restricts printing, copying or editing.</p>
    </fieldset>
    ${actionsHtml('unlock', 'Unlock', unlock)}
  </form>
  <div class="stack">
    ${statusHtml('unlock')}
    ${resultHtml('unlock')}
  </div>
</div>`;

function describe(err: unknown): string | undefined {
  const name = err instanceof Error ? err.name : '';
  if (name === 'PdfPasswordError') return 'That password is not correct: it is neither the password that opens the document nor its owner password.';
  if (name === 'PdfEncryptedError') return `This PDF uses an encryption leanpdf can’t remove. (${(err as Error).message})`;
  return undefined;
}

function mount(panel: HTMLElement, ctx: ToolContext): void {
  panel.insertAdjacentHTML('beforeend', TEMPLATE);
  const r = refs(panel, ['form', 'state', 'password'] as const);
  const password = r.password as HTMLInputElement;

  let file: File | null = null;
  let probe: Probe | null = null;
  const result = new Result(panel);
  const runner = new Runner(panel, ctx, () => refresh());
  const drop = new Drop(panel, (files) => void choose(files[0]));

  const refresh = (): void => {
    const ready = !!file && !!probe && probe.encrypted && !probe.unsupported && !runner.busy;
    actions.start.disabled = !ready;
    actions.save.disabled = !ready;
    drop.disabled = runner.busy;
  };

  const choose = async (f: File): Promise<void> => {
    if (runner.busy) return;
    file = f;
    probe = null;
    result.hide();
    runner.hideProgress();
    r.state.textContent = '';
    drop.show(f, `${fmtBytes(f.size)} · reading…`);
    const p = await runner.run('Reading the document…', (signal) => ctx.worker.run('probe', { file: f }, { signal }), { quiet: true });
    if (file !== f) return;
    probe = p ?? null;
    drop.show(f, p ? `${fmtBytes(f.size)} · ${pagesText(p.pageCount)} · choose or drop another file to replace it` : undefined);
    if (p) {
      r.state.textContent = !p.encrypted
        ? 'This PDF is not encrypted: there is nothing to unlock.'
        : p.unsupported
          ? `This PDF is encrypted in a way leanpdf can’t remove (${p.unsupported}).`
          : p.needsPassword
            ? 'Encrypted. It needs a password to open: enter it below.'
            : 'Encrypted, but it opens without a password: it only restricts what you can do with it. Unlock it as it is.';
      if (p.encrypted && p.needsPassword) password.focus();
    }
    refresh();
  };

  const run = async (handle?: FileSystemFileHandle): Promise<void> => {
    if (!file || !probe || runner.busy) return;
    const f = file;
    result.hide();
    const out = await runner.run(
      'Decrypting…',
      (signal) =>
        ctx.worker.run('unlock', { file: f, password: password.value, ...(handle ? { handle } : {}) }, {
          signal,
          onProgress: (p) => runner.progress(p.processedObjects, p.totalObjects, `${p.totalObjects ? Math.floor((p.processedObjects / p.totalObjects) * 100) : 0}% of objects`),
        }),
      { describe },
    );
    if (!out) return;
    const rep = out.report;
    const facts = sizeFacts(rep.inputBytes, rep.outputBytes, out.ms);
    facts.unshift(['Encryption', rep.method ?? 'none', 'method'], ['Opened with', rep.password === 'owner' ? 'the owner password' : rep.password === 'user' ? (password.value ? 'the user password' : 'no password') : '–', 'password']);
    const w = warningsFact(rep.warnings, rep.signaturesInvalidated, rep.xrefRepaired);
    if (w) facts.push(w);
    runner.done('Done.');
    ctx.announce('Done. The copy is not encrypted.');
    result.show(facts, out, outputName(f, 'unlocked'));
  };

  const actions = wireActions(panel, r.form as HTMLFormElement, ctx, run, () => (file ? outputName(file, 'unlocked') : null), (m) => runner.error(m));
  refresh();
}

export const unlockTool: Tool = {
  id: 'unlock',
  label: 'Unlock',
  icon: unlock,
  summary: 'Remove the encryption from a PDF you have the password for, or lift printing and copying restrictions, so other tools can work with it.',
  mount,
};
