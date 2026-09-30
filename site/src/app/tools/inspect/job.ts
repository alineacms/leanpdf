/**
 * Inspect jobs (worker): everything the read functions report about a document, and extracting
 * one image or attachment from it. Each section is read on its own, so a problem in one (or an
 * encrypted file, where only the document facts are readable) doesn't hide the others.
 */
import {
  attachmentStream, extractImage, getFormFields, getInfo, getLinks, getOutline, getPages, listAttachments, listImages, openPdf,
  type Attachment, type DocumentInfo, type FormField, type ImageInfo, type OutlineItem,
} from '../../../../../src/index.ts';
import { defineJob } from '../../protocol.ts';

/** A section's value, or why it could not be read. */
export type Section<T> = { value: T } | { error: { name: string; message: string } };

export interface PageSize {
  width: number;
  height: number;
  rotate: number;
  count: number;
  /** 1-based number of the first page with this size. */
  first: number;
}

export interface Links {
  count: number;
  /** Distinct web addresses, in order of first appearance (at most MAX_URLS). */
  urls: string[];
  internal: number;
}

export interface InspectOutput {
  info: DocumentInfo;
  /** Distinct page sizes, most common first. */
  sizes: Section<PageSize[]>;
  outline: Section<{ items: OutlineItem[]; total: number }>;
  attachments: Section<Attachment[]>;
  images: Section<{ items: ImageInfo[]; total: number; encodedBytes: number }>;
  fields: Section<{ items: FormField[]; total: number }>;
  links: Section<Links>;
  ms: number;
}

const MAX_OUTLINE = 2000;
const MAX_ROWS = 500;
const MAX_URLS = 200;

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { value: await read() };
  } catch (e) {
    return { error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) } };
  }
}

/** The first `max` items of an outline, depth first; `left` counts down across the tree. */
function trimOutline(items: OutlineItem[], left: { n: number }): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const it of items) {
    if (left.n <= 0) break;
    left.n--;
    out.push({ ...it, children: trimOutline(it.children, left) });
  }
  return out;
}

const countOutline = (items: OutlineItem[]): number => items.reduce((n, it) => n + 1 + countOutline(it.children), 0);

export const inspectJob = defineJob(async (input: { file: File }, ctx): Promise<InspectOutput> => {
  const t0 = performance.now();
  const doc = await openPdf(input.file, { signal: ctx.signal });
  const info = await getInfo(doc);
  const sizes = await section(async () => {
    const groups = new Map<string, PageSize>();
    (await getPages(doc)).forEach((p, i) => {
      const w = Math.round(p.width * 10) / 10;
      const h = Math.round(p.height * 10) / 10;
      const key = `${w}x${h}@${p.rotate}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { width: w, height: h, rotate: p.rotate, count: 1, first: i + 1 });
    });
    return [...groups.values()].sort((a, b) => b.count - a.count || a.first - b.first);
  });
  const outline = await section(async () => {
    const items = await getOutline(doc);
    return { items: trimOutline(items, { n: MAX_OUTLINE }), total: countOutline(items) };
  });
  const attachments = await section(() => listAttachments(doc));
  const images = await section(async () => {
    const all = await listImages(doc);
    return { items: all.slice(0, MAX_ROWS), total: all.length, encodedBytes: all.reduce((n, i) => n + i.encodedBytes, 0) };
  });
  const fields = await section(async () => {
    const all = await getFormFields(doc);
    return { items: all.slice(0, MAX_ROWS), total: all.length };
  });
  const links = await section(async () => {
    const all = await getLinks(doc);
    const urls = [...new Set(all.flatMap((l) => (l.url ? [l.url] : [])))];
    return { count: all.length, urls: urls.slice(0, MAX_URLS), internal: all.filter((l) => l.targetPageIndex !== undefined).length };
  });
  return { info, sizes, outline, attachments, images, fields, links, ms: performance.now() - t0 };
});

export interface ExtractedFile {
  blob: Blob;
  /** File extension for the download, without the dot. */
  ext: string;
}

/** Pixels as a PNG, drawn on an OffscreenCanvas. */
async function png(data: Uint8Array, width: number, height: number, components: 1 | 3): Promise<Blob> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const g1 = components === 1 ? 0 : 1;
  const b1 = components === 1 ? 0 : 2;
  for (let i = 0, j = 0; j < rgba.length; i += components, j += 4) {
    rgba[j] = data[i];
    rgba[j + 1] = data[i + g1];
    rgba[j + 2] = data[i + b1];
    rgba[j + 3] = 255;
  }
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('No 2D canvas in this browser');
  g.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

export const imageJob = defineJob(async (input: { file: File; num: number }, ctx): Promise<ExtractedFile> => {
  const doc = await openPdf(input.file, { signal: ctx.signal });
  const img = await extractImage(doc, input.num);
  if (!img) throw new Error('This image uses an encoding that cannot be extracted.');
  if (img.kind === 'jpeg') return { blob: new Blob([img.data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), ext: 'jpg' };
  if (img.kind === 'jpx') return { blob: new Blob([img.data as Uint8Array<ArrayBuffer>], { type: 'image/jp2' }), ext: 'jp2' };
  return { blob: await png(img.data, img.width, img.height, img.components), ext: 'png' };
});

export const attachmentJob = defineJob(async (input: { file: File; stream: number; type?: string }, ctx): Promise<ExtractedFile> => {
  const doc = await openPdf(input.file, { signal: ctx.signal });
  const blob = await new Response(attachmentStream(doc, { stream: input.stream })).blob();
  return { blob: input.type ? new Blob([blob], { type: input.type }) : blob, ext: '' };
});
