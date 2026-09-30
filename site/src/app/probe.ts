/**
 * Probe job (worker): the facts a tool needs as soon as a file is chosen, before running
 * anything heavier: page count, current rotations, and whether the file is encrypted and needs a
 * password. Only the cross-reference index and the page tree are read.
 */
import { checkPassword, getInfo, getPages, openPdf } from '../../../src/index.ts';
import { defineJob } from './protocol.ts';

export interface Probe {
  pageCount: number;
  /** Each page's rotation (0, 90, 180, 270). */
  rotations: number[];
  encrypted: boolean;
  /** Encrypted and the empty password does not open it. */
  needsPassword: boolean;
  /** Encrypted with a scheme leanpdf can't decrypt: the reason. */
  unsupported?: string;
}

export const probeJob = defineJob(async (input: { file: File }, ctx): Promise<Probe> => {
  const doc = await openPdf(input.file, { signal: ctx.signal });
  const info = await getInfo(doc);
  const pages = await getPages(doc);
  const probe: Probe = { pageCount: info.pageCount, rotations: pages.map((p) => p.rotate), encrypted: info.encrypted, needsPassword: false };
  if (info.encrypted) {
    try {
      probe.needsPassword = (await checkPassword(doc, '')) === null;
    } catch (e) {
      probe.unsupported = e instanceof Error ? e.message : String(e);
    }
  }
  return probe;
});
