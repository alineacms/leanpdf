/**
 * The content stream interpreter behind renderPage: executes a page's operators on a Canvas 2D
 * context. The browser does the heavy lifting: paths, clipping, strokes and dashes, transforms,
 * blend modes, gradients, patterns, image decoding and scaling, and compositing. Transparency
 * groups and soft masks are drawn on offscreen layers that are then composited.
 */
import { readArray, readDict, readInlineImage, type Operand } from '../core/content.ts';
import { decodeFilters, decodeStream, readStream, type Decoded } from '../core/decode.ts';
import type { PdfDocument } from '../core/document.ts';
import { isFatal } from '../core/errors.ts';
import { Lexer, T_AOPEN, T_DOPEN, T_EOF, T_KW, T_NAME, T_NUM, T_STR } from '../core/lexer.ts';
import { intOf, nameOf, numOf, PdfDict, PdfName, PdfRef, PdfString, type PdfObj } from '../core/objects.ts';
import { stringBytes } from '../core/strings.ts';
import { loadColorSpace, type ColorSpace } from './colorspace.ts';
import { loadRenderFont, type RenderFont } from './font.ts';
import { loadFunction } from './function.ts';
import { loadImage, type ImageCache, type ImageDict } from './image.ts';
import { maskToAlpha, paintShading, setT } from './paint.ts';
import { loadShading, type ShadingPaint } from './shading.ts';
import { asMatrix, blendMode, canvas, css, IDENTITY, intersect, invert, mul, pixelBox, scaleOf, transformBox, type Box, type Canvas, type Ctx, type Matrix } from './util.ts';

type Ctx2D = Ctx | CanvasRenderingContext2D;

/** Tokens interpreted per page, Form XObjects and patterns included. */
const MAX_TOKENS = 20_000_000;
const MAX_CONTENT = 128 << 20;
const MAX_DEPTH = 12;
const MAX_STACK = 1024;
/** Largest tiling pattern cell, per side, in pixels. */
const MAX_CELL = 2048;

/** A drawing surface: the page canvas or an offscreen layer, at device offset (ox, oy). */
interface Target {
  ctx: Ctx2D;
  canvas?: Canvas;
  ox: number;
  oy: number;
  w: number;
  h: number;
}

interface Clip {
  path: Path2D;
  m: Matrix;
  rule: CanvasFillRule;
}

type Pattern =
  | { tiling: true; ref: PdfRef; dict: PdfDict; matrix: Matrix; bbox: number[]; xs: number; ys: number; colored: boolean; res?: PdfDict }
  | { tiling: false; shading?: ShadingPaint; matrix: Matrix };

interface Paint {
  cs: ColorSpace;
  c: number[];
  css: string;
  pattern?: Pattern;
}

interface SoftMask {
  group: PdfRef;
  luminosity: boolean;
  backdrop?: number[];
  transfer?: Uint8Array;
  ctm: Matrix;
}

interface GState {
  ctm: Matrix;
  /** Bounds of the clip region in device pixels. */
  clipBox: Box;
  clips: Clip[];
  fill: Paint;
  stroke: Paint;
  lw: number;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miter: number;
  dash: number[];
  phase: number;
  ca: number;
  CA: number;
  bm: GlobalCompositeOperation;
  font?: RenderFont;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  tr: number;
}

/** A soft mask being applied: drawing goes to `layer` until the state that set it ends. */
interface MaskScope {
  mask: SoftMask;
  owner: GState;
  layer: Target;
  parent: Target;
}

/** One content stream being run: its resources, and the matrix patterns are relative to. */
export interface Run {
  res?: PdfDict;
  base: Matrix;
  depth: number;
  /** Uncolored tiling pattern cells and stencil-like glyphs: color operators are ignored. */
  uncolored?: boolean;
}

export interface RenderContext {
  doc: PdfDocument;
  signal?: AbortSignal;
  warn(message: string): void;
  /** Is optional content (an OCG or OCMD reference) visible? */
  visible(oc: PdfObj | undefined): Promise<boolean>;
  fonts: Map<number, Promise<RenderFont>>;
  images: ImageCache;
}

const CAPS: CanvasLineCap[] = ['butt', 'round', 'square'];
const JOINS: CanvasLineJoin[] = ['miter', 'round', 'bevel'];

let blackPaint: Paint | undefined;

export class Interpreter {
  private readonly rc: RenderContext;
  private target: Target;
  private gs: GState;
  private stack: GState[] = [];
  private masks: MaskScope[] = [];
  private tokens = 0;
  private hidden = 0;
  private marked: boolean[] = [];
  private tm: Matrix = IDENTITY;
  private tlm: Matrix = IDENTITY;
  private textClip: Path2D | null = null;
  private path = new Path2D();
  private pathBox: Box = [Infinity, Infinity, -Infinity, -Infinity];
  private cx = 0;
  private cy = 0;
  private pendingClip: CanvasFillRule | null = null;
  private readonly active = new Set<number>();
  private readonly patterns = new Map<number, Promise<Pattern | undefined>>();
  private readonly spaces = new Map<PdfDict | undefined, Map<string, Promise<ColorSpace | undefined>>>();

  constructor(rc: RenderContext, target: Target, ctm: Matrix) {
    this.rc = rc;
    this.target = target;
    const black = (blackPaint ??= { cs: GRAY, c: [0], css: 'rgb(0,0,0)' });
    this.gs = {
      ctm,
      clipBox: [target.ox, target.oy, target.ox + target.w, target.oy + target.h],
      clips: [],
      fill: black,
      stroke: black,
      lw: 1,
      cap: 'butt',
      join: 'miter',
      miter: 10,
      dash: [],
      phase: 0,
      ca: 1,
      CA: 1,
      bm: 'source-over',
      fs: 0,
      tc: 0,
      tw: 0,
      th: 1,
      tl: 0,
      rise: 0,
      tr: 0,
    };
  }

  get ctm(): Matrix {
    return this.gs.ctm;
  }

  // ------------------------------------------------------------------ state

  private save(): void {
    this.stack.push(this.gs);
    this.gs = { ...this.gs };
    this.target.ctx.save();
  }

  private restore(): void {
    const prev = this.stack.pop();
    if (!prev) return;
    this.endMasks(this.gs);
    this.gs = prev;
    this.target.ctx.restore();
  }

  /** Finish the soft masks set by `owner` (it is going out of scope). */
  private endMasks(owner: GState): void {
    while (this.masks.length && this.masks[this.masks.length - 1].owner === owner) this.endMask(this.masks.pop()!);
  }

  private setT(m: Matrix): void {
    setT(this.target.ctx, m, this.target.ox, this.target.oy);
  }

  /** A new layer covering `box` (device pixels), with the current clip applied. */
  private layer(box: Box): Target | null {
    const pb = pixelBox(intersect(box, this.gs.clipBox));
    if (!pb) return null;
    const [c, ctx] = canvas(pb[2] - pb[0], pb[3] - pb[1]);
    const t: Target = { ctx, canvas: c, ox: pb[0], oy: pb[1], w: pb[2] - pb[0], h: pb[3] - pb[1] };
    for (const clip of this.gs.clips) {
      setT(ctx, clip.m, t.ox, t.oy);
      ctx.clip(clip.path, clip.rule);
    }
    return t;
  }

  /** Draw a finished layer onto `onto` (the current target by default). */
  private composite(t: Target, alpha = 1, bm: GlobalCompositeOperation = 'source-over', onto = this.target): void {
    const ctx = onto.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = bm;
    ctx.drawImage(t.canvas!, t.ox - onto.ox, t.oy - onto.oy);
    ctx.restore();
  }

  private beginMask(mask: SoftMask): void {
    const layer = this.layer(this.gs.clipBox);
    if (!layer) return;
    this.masks.push({ mask, owner: this.gs, layer, parent: this.target });
    this.target = layer;
  }

  private async endMaskAsync(scope: MaskScope): Promise<void> {
    const { layer, mask } = scope;
    const [mc, mctx] = canvas(layer.w, layer.h, true);
    const t: Target = { ctx: mctx, canvas: mc, ox: layer.ox, oy: layer.oy, w: layer.w, h: layer.h };
    if (mask.luminosity) {
      mctx.fillStyle = mask.backdrop ? css(mask.backdrop) : '#000';
      mctx.fillRect(0, 0, layer.w, layer.h);
    }
    const sub = new Interpreter(this.rc, t, mask.ctm);
    sub.tokens = this.tokens;
    await sub.form(mask.group, undefined, 0, true);
    this.tokens = sub.tokens;
    maskToAlpha(mctx, layer.w, layer.h, mask.luminosity, mask.transfer);
    const lctx = layer.ctx as Ctx;
    lctx.save();
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(mc, 0, 0);
    lctx.restore();
    this.composite(layer, 1, 'source-over', scope.parent);
  }

  private pendingMasks: Promise<void> = Promise.resolve();

  private endMask(scope: MaskScope): void {
    // Masks end at Q, which is synchronous; the work is chained and awaited by the run loop.
    this.target = scope.parent;
    this.pendingMasks = this.pendingMasks.then(() => this.endMaskAsync(scope));
  }

  // ------------------------------------------------------------------ resources

  private async resource(run: Run, kind: string, name: string): Promise<PdfObj | undefined> {
    const all = await this.rc.doc.resolve(run.res?.get(kind));
    return all instanceof PdfDict ? all.get(name) : undefined;
  }

  private colorSpace(run: Run, o: PdfObj): Promise<ColorSpace | undefined> {
    const key = o instanceof PdfName ? o.name : undefined;
    let scope = this.spaces.get(run.res);
    if (!scope) this.spaces.set(run.res, (scope = new Map()));
    let p = key ? scope.get(key) : undefined;
    if (!p) {
      p = (async () => loadColorSpace(this.rc.doc, o, (await this.rc.doc.resolve(run.res?.get('ColorSpace'))) as PdfDict | undefined))();
      if (key) scope.set(key, p);
    }
    return p;
  }

  /** A font resource; a missing one draws with a system font rather than not at all. */
  private async font(run: Run, name: string): Promise<RenderFont> {
    const ref = await this.resource(run, 'Font', name);
    const num = ref instanceof PdfRef ? ref.num : ref === undefined ? -2 : -1;
    let p = num !== -1 ? this.rc.fonts.get(num) : undefined;
    if (!p) {
      p = loadRenderFont(this.rc.doc, ref);
      if (num !== -1) {
        if (this.rc.fonts.size >= 64) this.rc.fonts.delete(this.rc.fonts.keys().next().value!);
        this.rc.fonts.set(num, p);
      }
    }
    return p;
  }

  private async pattern(run: Run, name: string): Promise<Pattern | undefined> {
    const ref = await this.resource(run, 'Pattern', name);
    if (!(ref instanceof PdfRef)) return undefined;
    let p = this.patterns.get(ref.num);
    if (!p) {
      p = (async (): Promise<Pattern | undefined> => {
        const doc = this.rc.doc;
        const hdr = await doc.header(ref.num);
        const d = hdr?.value;
        if (!(d instanceof PdfDict)) return undefined;
        const m = await doc.resolve(d.get('Matrix'));
        const matrix = (Array.isArray(m) && asMatrix(await Promise.all(m.map((x) => doc.resolve(x))))) || IDENTITY;
        if (intOf(await doc.resolve(d.get('PatternType'))) === 2) {
          const cs = (await doc.resolve(run.res?.get('ColorSpace'))) as PdfDict | undefined;
          return { tiling: false, matrix, shading: await loadShading(doc, d.get('Shading'), cs instanceof PdfDict ? cs : undefined) };
        }
        const bb = await doc.resolve(d.get('BBox'));
        const bbox = Array.isArray(bb) ? await Promise.all(bb.map(async (x) => numOf(await doc.resolve(x)) ?? 0)) : [];
        const xs = numOf(await doc.resolve(d.get('XStep'))) ?? 0;
        const ys = numOf(await doc.resolve(d.get('YStep'))) ?? 0;
        const res = await doc.resolve(d.get('Resources'));
        if (bbox.length !== 4 || !xs || !ys || !hdr?.stream) return undefined;
        return { tiling: true, ref, dict: d, matrix, bbox, xs: Math.abs(xs), ys: Math.abs(ys), colored: intOf(await doc.resolve(d.get('PaintType'))) !== 2, res: res instanceof PdfDict ? res : undefined };
      })();
      this.patterns.set(ref.num, p);
    }
    return p;
  }

  // ------------------------------------------------------------------ painting

  private hairline(): number {
    const s = scaleOf(this.gs.ctm);
    return s ? Math.max(this.gs.lw, 1 / s) : this.gs.lw;
  }

  private strokeStyle(ctx: Ctx2D): void {
    const g = this.gs;
    ctx.lineWidth = this.hairline();
    ctx.lineCap = g.cap;
    ctx.lineJoin = g.join;
    ctx.miterLimit = Math.max(1, g.miter);
    ctx.setLineDash(g.dash.some((x) => x > 0) ? g.dash : []);
    ctx.lineDashOffset = g.phase;
  }

  private fillPath(path: Path2D, rule: CanvasFillRule, box: Box, run: Run): Promise<void> | void {
    if (this.hidden) return;
    const g = this.gs;
    if (g.fill.pattern) return this.patternPaint(g.fill, box, run, g.ca, (ctx) => ctx.fill(path, rule), path, rule);
    const ctx = this.target.ctx;
    ctx.globalAlpha = g.ca;
    ctx.globalCompositeOperation = g.bm;
    ctx.fillStyle = g.fill.css;
    this.setT(g.ctm);
    ctx.fill(path, rule);
  }

  private strokePath(path: Path2D, box: Box, run: Run): Promise<void> | void {
    if (this.hidden) return;
    const g = this.gs;
    const pad = this.hairline() * scaleOf(g.ctm) * Math.max(1, g.miter);
    const grown: Box = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
    if (g.stroke.pattern) {
      return this.patternPaint(g.stroke, grown, run, g.CA, (ctx) => {
        this.strokeStyle(ctx);
        ctx.stroke(path);
      });
    }
    const ctx = this.target.ctx;
    ctx.globalAlpha = g.CA;
    ctx.globalCompositeOperation = g.bm;
    ctx.strokeStyle = g.stroke.css;
    this.strokeStyle(ctx);
    this.setT(g.ctm);
    ctx.stroke(path);
  }

  /**
   * Paint with a pattern where `shape` draws (in user space). Fills with a path clip directly;
   * other shapes (strokes, glyphs, stencils) through a layer used as a mask.
   */
  private async patternPaint(paint: Paint, box: Box, run: Run, alpha: number, shape: (ctx: Ctx2D) => void, clip?: Path2D, rule?: CanvasFillRule): Promise<void> {
    const area = intersect(box, this.gs.clipBox);
    if (!pixelBox(area)) return;
    if (clip) {
      const ctx = this.target.ctx;
      ctx.save();
      this.setT(this.gs.ctm);
      ctx.clip(clip, rule);
      await this.paintPattern(paint, area, run, alpha);
      ctx.restore();
      return;
    }
    const layer = this.layer(area);
    if (!layer) return;
    const parent = this.target;
    this.target = layer;
    await this.paintPattern(paint, area, run, 1);
    this.target = parent;
    const ctx = layer.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = ctx.strokeStyle = '#000';
    setT(ctx, this.gs.ctm, layer.ox, layer.oy);
    shape(ctx);
    ctx.restore();
    this.composite(layer, alpha, this.gs.bm);
  }

  /** Cover `area` of the current target with a pattern. */
  private async paintPattern(paint: Paint, area: Box, run: Run, alpha: number): Promise<void> {
    const p = paint.pattern!;
    const ctx = this.target.ctx;
    const m = mul(p.matrix, run.base);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = this.gs.bm;
    if (!p.tiling) {
      if (p.shading) paintShading(ctx, p.shading, m, area, this.target.ox, this.target.oy, true);
      return;
    }
    const cell = await this.tile(p, m, paint);
    if (!cell) return;
    const pat = ctx.createPattern(cell.canvas, 'repeat');
    if (!pat) return;
    const t = mul(cell.toPattern, m);
    pat.setTransform(new DOMMatrix([t[0], t[1], t[2], t[3], t[4] - this.target.ox, t[5] - this.target.oy]));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pat;
    ctx.fillRect(area[0] - this.target.ox, area[1] - this.target.oy, area[2] - area[0], area[3] - area[1]);
    ctx.restore();
  }

  /** Render one tiling cell at device resolution; `toPattern` maps its pixels to pattern space. */
  private async tile(p: Extract<Pattern, { tiling: true }>, m: Matrix, paint: Paint): Promise<{ canvas: Canvas; toPattern: Matrix } | null> {
    const cw = Math.max(1, Math.min(MAX_CELL, Math.ceil(p.xs * Math.hypot(m[0], m[1]))));
    const ch = Math.max(1, Math.min(MAX_CELL, Math.ceil(p.ys * Math.hypot(m[2], m[3]))));
    const [bx, by, bx1, by1] = p.bbox;
    const cellM: Matrix = [cw / p.xs, 0, 0, -ch / p.ys, -bx * (cw / p.xs), ch + by * (ch / p.ys)];
    const [c, ctx] = canvas(cw, ch);
    const t: Target = { ctx, canvas: c, ox: 0, oy: 0, w: cw, h: ch };
    const data = await readStream(this.rc.doc, p.ref, MAX_CONTENT);
    if (!data) return null;
    // Content reaching past the step (a /BBox larger than it) wraps into the next cells.
    const nx = Math.min(3, Math.ceil((bx1 - bx) / p.xs));
    const ny = Math.min(3, Math.ceil((by1 - by) / p.ys));
    for (let i = 0; i < Math.max(1, nx); i++) {
      for (let j = 0; j < Math.max(1, ny); j++) {
        const sub = new Interpreter(this.rc, t, mul([1, 0, 0, 1, -i * p.xs, -j * p.ys], cellM));
        sub.tokens = this.tokens;
        if (!p.colored) sub.gs.fill = sub.gs.stroke = { ...paint, pattern: undefined };
        ctx.save();
        sub.setT(sub.gs.ctm);
        ctx.beginPath();
        ctx.rect(bx, by, bx1 - bx, by1 - by);
        ctx.clip();
        await sub.run(data, { res: p.res, base: sub.gs.ctm, depth: 1, uncolored: !p.colored });
        ctx.restore();
        this.tokens = sub.tokens;
      }
    }
    return { canvas: c, toPattern: invert(cellM)! };
  }

  private async shade(run: Run, name: string): Promise<void> {
    if (this.hidden) return;
    const cs = (await this.rc.doc.resolve(run.res?.get('ColorSpace'))) as PdfDict | undefined;
    const sp = await loadShading(this.rc.doc, await this.resource(run, 'Shading', name), cs instanceof PdfDict ? cs : undefined);
    if (!sp) return;
    const ctx = this.target.ctx;
    ctx.globalAlpha = this.gs.ca;
    ctx.globalCompositeOperation = this.gs.bm;
    paintShading(ctx, sp, this.gs.ctm, this.gs.clipBox, this.target.ox, this.target.oy, false);
  }

  // ------------------------------------------------------------------ images

  private async drawImage(get: ImageDict, data: () => Promise<Decoded | null>, cacheKey: number, run: Run): Promise<void> {
    const m = mul([1, 0, 0, -1, 0, 1], this.gs.ctm);
    const w = Math.hypot(m[0], m[1]);
    const h = Math.hypot(m[2], m[3]);
    let entry = cacheKey >= 0 ? this.rc.images.get(cacheKey) : undefined;
    if (!entry || entry.w < w * 0.9 || entry.h < h * 0.9) {
      const cs = await this.rc.doc.resolve(run.res?.get('ColorSpace'));
      const img = await loadImage(this.rc.doc, get, await data(), { width: w, height: h, colorSpaces: cs instanceof PdfDict ? cs : undefined, warn: this.rc.warn });
      entry = { img, w, h };
      if (cacheKey >= 0) this.rc.images.set(cacheKey, entry);
    }
    const img = entry.img;
    if (!img || this.hidden) return;
    const g = this.gs;
    const draw = (ctx: Ctx2D, src: CanvasImageSource = img.source) => {
      ctx.imageSmoothingEnabled = img.stencil || img.interpolate || img.source.width > w * 0.5;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, 1, 1);
    };
    if (img.stencil) {
      if (g.fill.pattern) {
        await this.patternPaint(g.fill, transformBox([0, 0, 1, 1], m), run, g.ca, (ctx) => {
          const t = ctx.getTransform();
          ctx.transform(1, 0, 0, -1, 0, 1);
          draw(ctx);
          ctx.setTransform(t);
        });
        return;
      }
      // Color the stencil with the fill color.
      const [c, cctx] = canvas(img.source.width, img.source.height);
      cctx.drawImage(img.source, 0, 0);
      cctx.globalCompositeOperation = 'source-in';
      cctx.fillStyle = g.fill.css;
      cctx.fillRect(0, 0, c.width, c.height);
      const ctx = this.target.ctx;
      ctx.globalAlpha = g.ca;
      ctx.globalCompositeOperation = g.bm;
      this.setT(m);
      draw(ctx, c);
      return;
    }
    const ctx = this.target.ctx;
    ctx.globalAlpha = g.ca;
    ctx.globalCompositeOperation = g.bm;
    this.setT(m);
    draw(ctx);
  }

  private async inlineImage(lex: Lexer, run: Run): Promise<void> {
    const { info, data } = readInlineImage(lex);
    if (this.hidden) return;
    const doc = this.rc.doc;
    const get: ImageDict = async (k, a) => doc.resolve(info.get(k) ?? (a ? info.get(a) : undefined));
    const f = (await get('Filter', 'F')) ?? [];
    const filters = (Array.isArray(f) ? f : [f]).map((x) => nameOf(x as PdfObj));
    const dp = await get('DecodeParms', 'DP');
    const parms = filters.map((_, i) => {
      const p = Array.isArray(dp) ? dp[i] : i === 0 ? dp : undefined;
      return p instanceof PdfDict ? p : undefined;
    });
    // Inline image color spaces may name /ColorSpace resources.
    const cs = await get('ColorSpace', 'CS');
    const res = cs instanceof PdfName && !/^(G|RGB|CMYK|I|Device\w+|Indexed)$/.test(cs.name) ? await this.resource(run, 'ColorSpace', cs.name) : undefined;
    const get2: ImageDict = res === undefined ? get : async (k, a) => (k === 'ColorSpace' ? doc.resolve(res) : get(k, a));
    await this.drawImage(get2, () => decodeFilters(data, filters, parms, 1 << 26), -1, run);
  }

  // ------------------------------------------------------------------ XObjects

  private async xobject(run: Run, name: string): Promise<void> {
    const ref = await this.resource(run, 'XObject', name);
    if (!(ref instanceof PdfRef)) return;
    const doc = this.rc.doc;
    const hdr = await doc.header(ref.num);
    const d = hdr?.value;
    if (!hdr?.stream || !(d instanceof PdfDict) || this.hidden) return;
    if (d.get('OC') !== undefined && !(await this.rc.visible(d.get('OC')))) return;
    const sub = nameOf(await doc.resolve(d.get('Subtype')));
    if (sub === 'Image') {
      const get: ImageDict = async (k, _a, raw) => (raw ? d.get(k) : doc.resolve(d.get(k)));
      await this.drawImage(get, () => decodeStream(doc, hdr, 1 << 28), ref.num, run);
    } else if (sub === 'Form') await this.form(ref, run, run.depth);
  }

  /** Draw an annotation's appearance stream with `ctm` (its placement on the page). */
  async annotation(ref: PdfRef, ctm: Matrix, run: Run): Promise<void> {
    this.save();
    this.gs.ctm = ctm;
    try {
      await this.form(ref, run, 0);
    } finally {
      this.restore();
      await this.flushMasks();
    }
  }

  /** Run a Form XObject: its matrix, clip to /BBox, and transparency group handling. */
  async form(ref: PdfRef, run: Run | undefined, depth: number, maskGroup = false): Promise<void> {
    if (depth >= MAX_DEPTH || this.active.has(ref.num)) return;
    const doc = this.rc.doc;
    const hdr = await doc.header(ref.num);
    const d = hdr?.value;
    if (!hdr?.stream || !(d instanceof PdfDict)) return;
    const r = (k: string) => doc.resolve(d.get(k));
    const m = await r('Matrix');
    const matrix = (Array.isArray(m) && asMatrix(await Promise.all(m.map((x) => doc.resolve(x))))) || IDENTITY;
    const bb = await r('BBox');
    const bbox = Array.isArray(bb) ? await Promise.all(bb.map(async (x) => numOf(await doc.resolve(x)) ?? 0)) : undefined;
    const resObj = await r('Resources');
    const res = resObj instanceof PdfDict ? resObj : run?.res;
    const group = await r('Group');
    const transparency = group instanceof PdfDict && nameOf(await doc.resolve(group.get('S'))) === 'Transparency';
    const data = await readStream(doc, hdr, MAX_CONTENT);
    if (!data) return;

    this.save();
    const g = this.gs;
    g.ctm = mul(matrix, g.ctm);
    if (bbox && bbox.length === 4) this.clipRect(bbox);
    // A transparency group is composited as a whole with the current alpha and blend mode.
    let layer: Target | null = null;
    const parent = this.target;
    const alpha = g.ca;
    const bm = g.bm;
    if (transparency && !maskGroup && (alpha < 1 || bm !== 'source-over')) {
      layer = this.layer(bbox && bbox.length === 4 ? transformBox(bbox, g.ctm) : g.clipBox);
      if (!layer) {
        this.restore();
        return;
      }
      this.target = layer;
    }
    if (transparency) {
      g.ca = g.CA = 1;
      g.bm = 'source-over';
    }
    this.active.add(ref.num);
    try {
      await this.run(data, { res, base: g.ctm, depth: depth + 1 });
    } finally {
      this.active.delete(ref.num);
      if (layer) {
        this.target = parent;
        this.composite(layer, alpha, bm);
      }
      this.restore();
      await this.flushMasks();
    }
  }

  private clipRect(b: number[]): void {
    const p = new Path2D();
    p.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    this.clip(p, 'nonzero', transformBox(b, this.gs.ctm));
  }

  private clip(path: Path2D, rule: CanvasFillRule, box: Box, m = this.gs.ctm): void {
    const g = this.gs;
    g.clips = [...g.clips, { path, m, rule }];
    g.clipBox = intersect(g.clipBox, box);
    setT(this.target.ctx, m, this.target.ox, this.target.oy);
    this.target.ctx.clip(path, rule);
  }

  // ------------------------------------------------------------------ text

  private async show(bytes: Uint8Array, run: Run): Promise<void> {
    const g = this.gs;
    const f = g.font;
    if (!f) return;
    const mode = g.tr;
    const draws = !this.hidden && mode !== 3 && mode !== 7;
    const clips = mode >= 4;
    const patternFill = draws && (mode === 0 || mode === 2 || mode === 4 || mode === 6) && g.fill.pattern;
    const outline = draws && (mode !== 0 && mode !== 4 ? true : !!patternFill);
    let collected: Path2D | undefined;
    let box: Box = [Infinity, Infinity, -Infinity, -Infinity];
    const ctx = this.target.ctx;
    for (let i = 0; i < bytes.length && ++this.tokens < MAX_TOKENS; ) {
      const n = Math.max(1, Math.min(f.len(bytes, i), bytes.length - i));
      let code = 0;
      for (let k = 0; k < n; k++) code = code * 256 + bytes[i + k];
      i += n;
      const w = f.width(code) * g.fs + g.tc + (n === 1 && code === 32 ? g.tw : 0);
      // Glyph space of this glyph in user space, then device space.
      let trm = mul([g.fs * g.th, 0, 0, g.fs, 0, g.rise], this.tm);
      if (f.vertical) trm = mul([1, 0, 0, 1, -0.5 * g.fs, -0.88 * g.fs], trm);
      const dev = mul(trm, g.ctm);
      if (draws || clips) {
        if (f.proc) {
          if (draws) await this.type3(f, code, dev, run);
        } else if (f.path) {
          const p = f.path(code);
          if (p) {
            if (outline || clips) {
              box = unionBox(box, transformBox([-0.2, -0.4, 1.5, 1.2], dev));
              collected ??= new Path2D();
              collected.addPath(p, new DOMMatrix(mul(f.matrix, trm)));
            }
            if (draws && !outline) {
              ctx.globalAlpha = g.ca;
              ctx.globalCompositeOperation = g.bm;
              ctx.fillStyle = g.fill.css;
              this.setT(mul(f.matrix, dev));
              ctx.fill(p);
            }
          }
        } else if (f.system && draws) this.systemGlyph(f, code, n, dev, mode);
      }
      const adv = f.vertical ? 0 : w * g.th;
      const vadv = f.vertical ? w : 0;
      this.tm = [this.tm[0], this.tm[1], this.tm[2], this.tm[3], this.tm[4] + adv * this.tm[0] + vadv * this.tm[2], this.tm[5] + adv * this.tm[1] + vadv * this.tm[3]];
    }
    if (!collected) return;
    if (outline) {
      if (mode === 0 || mode === 2 || mode === 4 || mode === 6) await this.fillPath(collected, 'nonzero', box, run);
      if (mode === 1 || mode === 2 || mode === 5 || mode === 6) await this.strokePath(collected, box, run);
    }
    if (clips) {
      const dev = new Path2D();
      dev.addPath(collected, new DOMMatrix(g.ctm));
      (this.textClip ??= new Path2D()).addPath(dev);
      this.textClipBox = unionBox(this.textClipBox, box);
    }
  }

  private textClipBox: Box = [Infinity, Infinity, -Infinity, -Infinity];

  /** A glyph of a font that isn't embedded, drawn by the browser with a similar system font. */
  private systemGlyph(f: RenderFont, code: number, n: number, dev: Matrix, mode: number): void {
    const sys = f.system!;
    const text = sys.text(code, n);
    if (!text.trim()) return;
    const S = 100;
    const ctx = this.target.ctx;
    ctx.font = sys.css(S);
    let natural = sys.widths.get(code);
    if (natural === undefined) sys.widths.set(code, (natural = ctx.measureText(text).width / S));
    const want = f.width(code);
    const sx = natural > 0 && want > 0 ? Math.min(2, Math.max(0.5, want / natural)) : 1;
    ctx.globalAlpha = this.gs.ca;
    ctx.globalCompositeOperation = this.gs.bm;
    ctx.fillStyle = this.gs.fill.css;
    this.setT(mul([sx / S, 0, 0, -1 / S, 0, 0], dev));
    ctx.textBaseline = 'alphabetic';
    if (mode !== 1 && mode !== 5) ctx.fillText(text, 0, 0);
    if (mode === 1 || mode === 2 || mode === 5 || mode === 6) {
      // Line width is in user space; this transform is 1/S of the font size.
      ctx.globalAlpha = this.gs.CA;
      ctx.strokeStyle = this.gs.stroke.css;
      ctx.lineWidth = (this.hairline() * S) / Math.max(1e-6, Math.abs(this.gs.fs));
      ctx.lineJoin = this.gs.join;
      ctx.strokeText(text, 0, 0);
    }
  }

  private async type3(f: RenderFont, code: number, dev: Matrix, run: Run): Promise<void> {
    const ref = f.proc!(code);
    if (!ref || this.active.has(ref.num) || run.depth >= MAX_DEPTH) return;
    const data = await readStream(this.rc.doc, ref, MAX_CONTENT);
    if (!data) return;
    const saved = [this.tm, this.tlm] as const;
    this.save();
    this.gs.ctm = mul(f.matrix, dev);
    this.active.add(ref.num);
    try {
      await this.run(data, { res: f.resources ?? run.res, base: run.base, depth: run.depth + 1 });
    } finally {
      this.active.delete(ref.num);
      this.restore();
      [this.tm, this.tlm] = saved;
      await this.flushMasks();
    }
  }

  // ------------------------------------------------------------------ colors and state

  private async setColor(run: Run, stroke: boolean, cs: ColorSpace | undefined, ops: Operand[]): Promise<void> {
    if (run.uncolored) return;
    const g = this.gs;
    const cur = stroke ? g.stroke : g.fill;
    const space = cs ?? cur.cs;
    const last = ops[ops.length - 1];
    let pattern: Pattern | undefined;
    let comps = ops.filter((x): x is number => typeof x === 'number');
    if (space.name === 'Pattern') {
      if (last instanceof PdfName) pattern = await this.pattern(run, last.name);
      if (!pattern) {
        // An unusable pattern paints nothing visible rather than black.
        const p = { ...cur, css: 'rgba(0,0,0,0)', pattern: undefined, cs: space, c: [] };
        if (stroke) g.stroke = p;
        else g.fill = p;
        return;
      }
      const base = space.base;
      const c = base ? comps.slice(0, base.n) : [];
      const paint: Paint = { cs: space, c, css: base && c.length === base.n ? css(base.rgb(c)) : 'rgb(0,0,0)', pattern };
      if (stroke) g.stroke = paint;
      else g.fill = paint;
      return;
    }
    if (cs && !ops.length) comps = [...cs.initial];
    if (comps.length < space.n) return;
    comps = comps.slice(0, space.n);
    // /None colorants paint nothing.
    const paint: Paint = { cs: space, c: comps, css: space.none ? 'rgba(0,0,0,0)' : css(space.rgb(comps)) };
    if (stroke) g.stroke = paint;
    else g.fill = paint;
  }

  private async extGState(run: Run, name: string): Promise<void> {
    const doc = this.rc.doc;
    const d = await doc.resolve(await this.resource(run, 'ExtGState', name));
    if (!(d instanceof PdfDict)) return;
    const g = this.gs;
    for (const [k, raw] of d.map) {
      const v = await doc.resolve(raw);
      const n = numOf(v);
      switch (k) {
        case 'LW':
          if (n !== undefined) g.lw = n;
          break;
        case 'LC':
          if (n !== undefined) g.cap = CAPS[n] ?? 'butt';
          break;
        case 'LJ':
          if (n !== undefined) g.join = JOINS[n] ?? 'miter';
          break;
        case 'ML':
          if (n !== undefined) g.miter = n;
          break;
        case 'D':
          if (Array.isArray(v)) {
            const arr = await doc.resolve(v[0]);
            g.dash = Array.isArray(arr) ? await Promise.all(arr.map(async (x) => Math.max(0, numOf(await doc.resolve(x)) ?? 0))) : [];
            g.phase = numOf(await doc.resolve(v[1])) ?? 0;
          }
          break;
        case 'CA':
          if (n !== undefined) g.CA = Math.min(1, Math.max(0, n));
          break;
        case 'ca':
          if (n !== undefined) g.ca = Math.min(1, Math.max(0, n));
          break;
        case 'BM': {
          const list = Array.isArray(v) ? v : [v];
          for (const x of list) {
            const b = blendMode(nameOf((await doc.resolve(x)) as PdfObj));
            if (b) {
              g.bm = b;
              break;
            }
          }
          break;
        }
        case 'Font':
          if (Array.isArray(v) && v.length === 2) {
            const num = v[0] instanceof PdfRef ? v[0].num : -1;
            let p = num >= 0 ? this.rc.fonts.get(num) : undefined;
            if (!p) {
              p = loadRenderFont(doc, v[0]);
              if (num >= 0) this.rc.fonts.set(num, p);
            }
            g.font = await p;
            g.fs = numOf(await doc.resolve(v[1])) ?? g.fs;
          }
          break;
        case 'SMask':
          this.endMasks(g);
          await this.flushMasks();
          if (v instanceof PdfDict) {
            const group = v.get('G');
            if (group instanceof PdfRef) {
              const luminosity = nameOf(await doc.resolve(v.get('S'))) !== 'Alpha';
              let backdrop: number[] | undefined;
              const bc = await doc.resolve(v.get('BC'));
              if (luminosity && Array.isArray(bc)) {
                const gd = await doc.header(group.num);
                const grp = await doc.resolve((gd?.value as PdfDict | undefined)?.get('Group'));
                const cs = grp instanceof PdfDict ? await loadColorSpace(doc, await doc.resolve(grp.get('CS')), undefined) : undefined;
                const comps = await Promise.all(bc.map(async (x) => numOf(await doc.resolve(x)) ?? 0));
                if (cs && comps.length === cs.n) backdrop = cs.rgb(comps);
              }
              let transfer: Uint8Array | undefined;
              const tr = v.get('TR');
              const fn = tr !== undefined && nameOf(await doc.resolve(tr)) !== 'Identity' ? await loadFunction(doc, tr) : undefined;
              if (fn) transfer = Uint8Array.from({ length: 256 }, (_, i) => Math.round(255 * Math.min(1, Math.max(0, fn([i / 255])[0]))));
              this.beginMask({ group, luminosity, backdrop, transfer, ctm: g.ctm });
            }
          }
          break;
      }
    }
  }

  private async flushMasks(): Promise<void> {
    const p = this.pendingMasks;
    this.pendingMasks = Promise.resolve();
    await p;
  }

  private async markedContent(run: Run, tag: Operand, props: Operand): Promise<void> {
    let hide = false;
    if (tag instanceof PdfName && tag.name === 'OC') {
      let oc: PdfObj | undefined = props instanceof PdfDict ? props : undefined;
      if (props instanceof PdfName) oc = await this.resource(run, 'Properties', props.name);
      hide = !(await this.rc.visible(oc));
    }
    if (this.marked.length < 4096) {
      this.marked.push(hide);
      if (hide) this.hidden++;
    }
  }

  // ------------------------------------------------------------------ paths

  private point(x: number, y: number): void {
    const m = this.gs.ctm;
    const dx = m[0] * x + m[2] * y + m[4];
    const dy = m[1] * x + m[3] * y + m[5];
    const b = this.pathBox;
    if (dx < b[0]) b[0] = dx;
    if (dy < b[1]) b[1] = dy;
    if (dx > b[2]) b[2] = dx;
    if (dy > b[3]) b[3] = dy;
  }

  private newPath(): void {
    this.path = new Path2D();
    this.pathBox = [Infinity, Infinity, -Infinity, -Infinity];
  }

  /** End of a path: apply a pending clip (W/W*), then start a new path. */
  private endPath(): void {
    if (this.pendingClip) this.clip(this.path, this.pendingClip, this.pathBox);
    this.pendingClip = null;
    this.newPath();
  }

  // ------------------------------------------------------------------ the loop

  /** Interpret a content stream. */
  async run(data: Uint8Array, run: Run): Promise<void> {
    const lex = new Lexer(data, 0, true);
    const ops: Operand[] = [];
    const depth0 = this.stack.length;
    const marked0 = this.marked.length;
    let check = 0;
    for (;;) {
      if (++this.tokens > MAX_TOKENS) break;
      if (this.tokens > check) {
        check = this.tokens + 0xffff;
        this.rc.signal?.throwIfAborted();
      }
      const t = lex.next();
      if (t.t === T_EOF) break;
      if (t.t !== T_KW) {
        if (ops.length >= 64) ops.shift();
        if (t.t === T_NUM || t.t === T_STR) ops.push(t.v as number | Uint8Array);
        else if (t.t === T_NAME) ops.push(new PdfName(t.v as string));
        else if (t.t === T_AOPEN) ops.push(readArray(lex));
        else if (t.t === T_DOPEN) ops.push(readDict(lex, t.s));
        continue;
      }
      try {
        await this.op(t.v as string, ops, lex, run, depth0);
      } catch (e) {
        if (isFatal(e) || (e instanceof DOMException && e.name === 'AbortError')) throw e;
        this.rc.warn(`Some content could not be drawn (${e instanceof Error ? e.message : String(e)})`);
      }
      ops.length = 0;
    }
    // Unbalanced q and marked content end with the stream.
    while (this.stack.length > depth0) this.restore();
    this.endMasks(this.gs);
    while (this.marked.length > marked0) if (this.marked.pop()) this.hidden--;
    await this.flushMasks();
  }

  private async op(k: string, ops: Operand[], lex: Lexer, run: Run, depth0: number): Promise<void> {
    const g = this.gs;
    const n = ops.length;
    const num = (i: number): number => {
      const v = ops[n - i];
      return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
    };
    const last = ops[n - 1];
    switch (k) {
      // Graphics state
      case 'q':
        if (this.stack.length < MAX_STACK) this.save();
        return;
      case 'Q':
        if (this.stack.length > depth0) {
          this.restore();
          await this.flushMasks();
        }
        return;
      case 'cm': {
        const m = asMatrix(ops.slice(-6));
        if (m) g.ctm = mul(m, g.ctm);
        return;
      }
      case 'w':
        if (!Number.isNaN(num(1))) g.lw = Math.abs(num(1));
        return;
      case 'J':
        g.cap = CAPS[num(1)] ?? 'butt';
        return;
      case 'j':
        g.join = JOINS[num(1)] ?? 'miter';
        return;
      case 'M':
        if (!Number.isNaN(num(1))) g.miter = num(1);
        return;
      case 'd':
        if (Array.isArray(ops[n - 2])) {
          g.dash = (ops[n - 2] as Operand[]).map((x) => (typeof x === 'number' ? Math.max(0, x) : 0));
          g.phase = Number.isNaN(num(1)) ? 0 : num(1);
        }
        return;
      case 'gs':
        if (last instanceof PdfName) await this.extGState(run, last.name);
        return;
      case 'ri':
      case 'i':
        return;

      // Paths
      case 'm':
        if (Number.isNaN(num(1) + num(2))) return;
        this.path.moveTo((this.cx = num(2)), (this.cy = num(1)));
        this.point(this.cx, this.cy);
        return;
      case 'l':
        if (Number.isNaN(num(1) + num(2))) return;
        this.path.lineTo((this.cx = num(2)), (this.cy = num(1)));
        this.point(this.cx, this.cy);
        return;
      case 'c':
      case 'v':
      case 'y': {
        const a = ops.slice(-(k === 'c' ? 6 : 4)).map((x) => (typeof x === 'number' ? x : NaN));
        if (a.some(Number.isNaN)) return;
        const [x1, y1, x2, y2, x3, y3] = k === 'c' ? a : k === 'v' ? [this.cx, this.cy, ...a] : [a[0], a[1], a[2], a[3], a[2], a[3]];
        this.path.bezierCurveTo(x1, y1, x2, y2, x3, y3);
        this.point(x1, y1);
        this.point(x2, y2);
        this.point(x3, y3);
        this.cx = x3;
        this.cy = y3;
        return;
      }
      case 'h':
        this.path.closePath();
        return;
      case 're': {
        const [x, y, w, h] = [num(4), num(3), num(2), num(1)];
        if (Number.isNaN(x + y + w + h)) return;
        this.path.rect(x, y, w, h);
        this.point(x, y);
        this.point(x + w, y + h);
        this.cx = x;
        this.cy = y;
        return;
      }
      case 'W':
      case 'W*':
        this.pendingClip = k === 'W' ? 'nonzero' : 'evenodd';
        return;
      case 'n':
        this.endPath();
        return;
      case 'f':
      case 'F':
      case 'f*':
        await this.fillPath(this.path, k === 'f*' ? 'evenodd' : 'nonzero', this.pathBox, run);
        this.endPath();
        return;
      case 'S':
      case 's':
        if (k === 's') this.path.closePath();
        await this.strokePath(this.path, this.pathBox, run);
        this.endPath();
        return;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        if (k[0] === 'b') this.path.closePath();
        await this.fillPath(this.path, k.endsWith('*') ? 'evenodd' : 'nonzero', this.pathBox, run);
        await this.strokePath(this.path, this.pathBox, run);
        this.endPath();
        return;

      // Colors
      case 'CS':
      case 'cs':
        if (last instanceof PdfName) {
          const cs = await this.colorSpace(run, last);
          if (cs) await this.setColor(run, k === 'CS', cs, []);
        }
        return;
      case 'SC':
      case 'SCN':
      case 'sc':
      case 'scn':
        await this.setColor(run, k[0] === 'S', undefined, ops);
        return;
      case 'G':
      case 'g':
        await this.setColor(run, k === 'G', GRAY, ops.slice(-1));
        return;
      case 'RG':
      case 'rg':
        await this.setColor(run, k === 'RG', (RGB ??= (await loadColorSpace(this.rc.doc, new PdfName('DeviceRGB')))!), ops.slice(-3));
        return;
      case 'K':
      case 'k':
        await this.setColor(run, k === 'K', (CMYK ??= (await loadColorSpace(this.rc.doc, new PdfName('DeviceCMYK')))!), ops.slice(-4));
        return;

      // Text
      case 'BT':
        this.tm = this.tlm = IDENTITY;
        this.textClip = null;
        this.textClipBox = [Infinity, Infinity, -Infinity, -Infinity];
        return;
      case 'ET':
        if (this.textClip) {
          this.clip(this.textClip, 'nonzero', this.textClipBox, IDENTITY);
          this.textClip = null;
        }
        return;
      case 'Tc':
        if (!Number.isNaN(num(1))) g.tc = num(1);
        return;
      case 'Tw':
        if (!Number.isNaN(num(1))) g.tw = num(1);
        return;
      case 'Tz':
        if (!Number.isNaN(num(1))) g.th = num(1) / 100;
        return;
      case 'TL':
        if (!Number.isNaN(num(1))) g.tl = num(1);
        return;
      case 'Ts':
        if (!Number.isNaN(num(1))) g.rise = num(1);
        return;
      case 'Tr':
        if (!Number.isNaN(num(1))) g.tr = num(1);
        return;
      case 'Tf': {
        if (!Number.isNaN(num(1))) g.fs = num(1);
        const name = ops[n - 2];
        if (name instanceof PdfName) g.font = await this.font(run, name.name);
        return;
      }
      case 'Td':
      case 'TD':
        if (Number.isNaN(num(1) + num(2))) return;
        if (k === 'TD') g.tl = -num(1);
        this.tm = this.tlm = mul([1, 0, 0, 1, num(2), num(1)], this.tlm);
        return;
      case 'Tm': {
        const m = asMatrix(ops.slice(-6));
        if (m) this.tm = this.tlm = m;
        return;
      }
      case 'T*':
      case "'":
      case '"':
        if (k === '"' && !Number.isNaN(num(3) + num(2))) {
          g.tw = num(3);
          g.tc = num(2);
        }
        this.tm = this.tlm = mul([1, 0, 0, 1, 0, -g.tl], this.tlm);
        if (k !== 'T*' && last instanceof Uint8Array) await this.show(stringBytes(new PdfString(last)), run);
        return;
      case 'Tj':
        if (last instanceof Uint8Array) await this.show(stringBytes(new PdfString(last)), run);
        return;
      case 'TJ':
        if (!Array.isArray(last)) return;
        for (const x of last) {
          if (x instanceof Uint8Array) await this.show(stringBytes(new PdfString(x)), run);
          else if (typeof x === 'number' && Number.isFinite(x)) {
            const d = (-x / 1000) * g.fs;
            this.tm = g.font?.vertical ? mul([1, 0, 0, 1, 0, d], this.tm) : mul([1, 0, 0, 1, d * g.th, 0], this.tm);
          }
        }
        return;
      case 'd0':
      case 'd1':
        return;

      // Shadings, images, XObjects
      case 'sh':
        if (last instanceof PdfName) await this.shade(run, last.name);
        return;
      case 'Do':
        if (last instanceof PdfName) await this.xobject(run, last.name);
        return;
      case 'BI':
        await this.inlineImage(lex, run);
        return;

      // Marked content: optional content hides what it encloses.
      case 'BMC':
      case 'BDC':
        await this.markedContent(run, k === 'BDC' ? ops[n - 2] : null, k === 'BDC' ? last : null);
        return;
      case 'EMC':
        if (this.marked.pop()) this.hidden--;
        return;
    }
  }
}

function unionBox(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** DeviceGray, available synchronously for the initial state. */
const GRAY: ColorSpace = {
  name: 'DeviceGray',
  n: 1,
  initial: [0],
  defaultDecode: () => [0, 1],
  rgb: (c) => {
    const v = Math.round(255 * Math.min(1, Math.max(0, c[0] ?? 0)));
    return [v, v, v];
  },
  rgbRow(src, off, count, dst, doff) {
    for (let i = 0; i < count; i++) dst[doff + 4 * i] = dst[doff + 4 * i + 1] = dst[doff + 4 * i + 2] = 255 * (src[off + i] ?? 0);
  },
};
let RGB: ColorSpace | undefined;
let CMYK: ColorSpace | undefined;

