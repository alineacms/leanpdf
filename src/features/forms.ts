import type { PdfDocument } from '../core/document.ts';
import { intOf, nameOf, PdfDict, PdfRef, type PdfObj } from '../core/objects.ts';
import { decodeText } from '../core/strings.ts';
import { arrayOf, assertNotEncrypted, catalogOf, dictOf, textAt } from './names.ts';

/** Field kind: /FT, with /Btn split by its flags into check box, radio button and push button. */
export type FieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'button' | 'signature';

/** A terminal form field, with inherited attributes applied. */
export interface FormField {
  /** Fully qualified name: the partial names (/T) of the field and its ancestors, joined by '.'. */
  name: string;
  type: FieldType;
  /**
   * Current value (/V). Text and choice fields: the text (an array for multi-select choices).
   * Check boxes and radio buttons: the name of the selected state ('Off' when none is); without
   * /V, the state a widget shows (/AS).
   * Signature fields and push buttons: absent.
   */
  value?: string | string[];
  /** Default value (/DV), in the same form as `value`. */
  defaultValue?: string | string[];
  /**
   * Choice fields: the export values of the options. Check boxes and radio buttons: the names
   * of their "on" states (from the widgets' appearance dictionaries).
   */
  options?: string[];
  /** Choice fields whose options have display texts that differ from the export values. */
  optionLabels?: string[];
  /** Signature fields: a signature value is present. */
  signed?: boolean;
  /** Raw field flags (/Ff). */
  flags: number;
  readOnly: boolean;
  required: boolean;
}

/** A terminal field as found in the tree, before interpretation. Internal. */
export interface RawField {
  name: string;
  dict: PdfDict;
  /** Inherited /FT name. */
  type: string;
  flags: number;
  /** Inherited /V and /DV, unresolved (a text stream value needs its reference). */
  value: PdfObj | undefined;
  defaultValue: PdfObj | undefined;
  /** Widget annotations: the field itself when merged, and its widget kids. */
  widgets: PdfDict[];
}

const MAX_FIELDS = 1 << 18;
const MAX_DEPTH = 64;

/**
 * Walk the AcroForm field tree depth first and report each terminal field with inherited /FT,
 * /Ff, /V and /DV. Cycles are skipped, and at most 262 144 nodes and 64 levels are visited.
 * `visit` may return true to stop.
 */
export async function walkFields(
  doc: PdfDocument,
  form: PdfDict,
  visit: (f: RawField) => boolean | void | Promise<boolean | void>,
): Promise<void> {
  const seen = new Set<number>();
  let budget = MAX_FIELDS;
  type Inherit = { name: string; type?: PdfObj; flags?: PdfObj; value?: PdfObj; dv?: PdfObj };
  const walk = async (node: PdfObj, parent: Inherit, depth: number): Promise<boolean> => {
    if (node instanceof PdfRef) {
      if (seen.has(node.num)) return false;
      seen.add(node.num);
    }
    const d = await dictOf(doc, node);
    if (!d || --budget < 0 || depth > MAX_DEPTH) return false;
    const t = await textAt(doc, d.get('T'));
    const own: Inherit = {
      name: t === undefined || t === '' ? parent.name : parent.name ? `${parent.name}.${t}` : t,
      type: d.get('FT') ?? parent.type,
      flags: d.get('Ff') ?? parent.flags,
      value: d.get('V') ?? parent.value,
      dv: d.get('DV') ?? parent.dv,
    };
    const fields: PdfObj[] = [];
    const widgets: PdfDict[] = nameOf(d.get('Subtype')) === 'Widget' ? [d] : [];
    for (const kid of (await arrayOf(doc, d.get('Kids'))) ?? []) {
      const k = kid instanceof PdfRef && seen.has(kid.num) ? undefined : await dictOf(doc, kid);
      if (!k) continue;
      // Kids without a partial name or kids of their own are widgets of this field.
      if (k.get('T') === undefined && k.get('Kids') === undefined) {
        if (kid instanceof PdfRef) seen.add(kid.num);
        widgets.push(k);
      } else fields.push(kid);
    }
    for (const f of fields) if (await walk(f, own, depth + 1)) return true;
    if (fields.length && !widgets.length) return false;
    const type = nameOf(await doc.resolve(own.type));
    if (!type) return false;
    const flags = intOf(await doc.resolve(own.flags)) ?? 0;
    return (await visit({ name: own.name, dict: d, type, flags, value: own.value, defaultValue: own.dv, widgets })) === true;
  };
  for (const f of (await arrayOf(doc, form.get('Fields'))) ?? []) if (await walk(f, { name: '' }, 0)) return;
}

/** Interpret a (possibly inherited) /V or /DV for a field of type `kind`. */
async function valueOf(doc: PdfDocument, kind: FieldType, ref: PdfObj | undefined): Promise<string | string[] | undefined> {
  const o = await doc.resolve(ref);
  if (kind === 'checkbox' || kind === 'radio' || kind === 'text' || (kind === 'choice' && !Array.isArray(o))) {
    // Text values may also be text streams (long or rich text).
    const hdr = o instanceof PdfDict && ref instanceof PdfRef && kind === 'text' ? await doc.header(ref.num) : null;
    if (hdr?.stream) {
      const b = await doc.streamData(hdr, 1 << 20);
      return b ? decodeText(b) : undefined;
    }
    return textAt(doc, o);
  }
  if (kind === 'choice' && Array.isArray(o)) {
    const out: string[] = [];
    for (const x of o) {
      const s = await textAt(doc, x);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  return undefined;
}

/**
 * All terminal fields of the document's interactive form (AcroForm), in tree order, with
 * fully qualified names and inherited type, flags and values. Fields without a type are left
 * out. XFA-only forms have no AcroForm fields. Throws PdfEncryptedError for encrypted documents.
 */
export async function getFormFields(doc: PdfDocument): Promise<FormField[]> {
  assertNotEncrypted(doc);
  const form = await dictOf(doc, (await catalogOf(doc))?.get('AcroForm'));
  if (!form) return [];
  const raw: RawField[] = [];
  await walkFields(doc, form, (f) => void raw.push(f));
  const out: FormField[] = [];
  for (const f of raw) {
    const ff = f.flags;
    const kind: FieldType | undefined =
      f.type === 'Tx' ? 'text'
      : f.type === 'Ch' ? 'choice'
      : f.type === 'Sig' ? 'signature'
      : f.type === 'Btn' ? (ff & (1 << 16) ? 'button' : ff & (1 << 15) ? 'radio' : 'checkbox')
      : undefined;
    if (!kind) continue;
    const field: FormField = { name: f.name, type: kind, flags: ff, readOnly: (ff & 1) === 1, required: (ff & 2) === 2 };
    let value = await valueOf(doc, kind, f.value);
    if (kind === 'checkbox' || kind === 'radio') {
      const states: string[] = [];
      let shown: string | undefined;
      for (const w of f.widgets) {
        const n = await dictOf(doc, (await dictOf(doc, w.get('AP')))?.get('N'));
        for (const k of n?.map.keys() ?? []) if (k !== 'Off' && !states.includes(k)) states.push(k);
        const as = nameOf(await doc.resolve(w.get('AS')));
        if (as && as !== 'Off') shown ??= as;
      }
      field.options = states;
      value ??= shown ?? 'Off';
    }
    if (kind === 'choice') {
      const opts = (await arrayOf(doc, f.dict.get('Opt'))) ?? [];
      const values: string[] = [];
      const labels: string[] = [];
      for (const o of opts) {
        const r = await doc.resolve(o);
        const pair = Array.isArray(r) ? r : [r, r];
        const v = await textAt(doc, pair[0]);
        if (v === undefined) continue;
        values.push(v);
        labels.push((await textAt(doc, pair[1])) ?? v);
      }
      field.options = values;
      if (labels.some((l, i) => l !== values[i])) field.optionLabels = labels;
    }
    if (kind === 'signature') field.signed = (await doc.resolve(f.value)) instanceof PdfDict;
    if (value !== undefined) field.value = value;
    const dv = await valueOf(doc, kind, f.defaultValue);
    if (dv !== undefined) field.defaultValue = dv;
    out.push(field);
  }
  return out;
}
