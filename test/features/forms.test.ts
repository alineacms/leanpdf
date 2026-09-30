import { describe, expect, test } from 'bun:test';
import * as mupdf from 'mupdf';
import { PdfEncryptedError } from '../../src/core/errors.ts';
import { openPdf } from '../../src/core/open.ts';
import { getFormFields, type FormField } from '../../src/features/forms.ts';
import { getInfo } from '../../src/features/info.ts';
import { damage, DocBuilder, flate } from '../support/pdfgen.ts';
import { Rng } from '../support/prng.ts';
import { hasQpdf, qpdfTransform } from '../support/qpdf.ts';
import { BytesSource } from '../unit/util.ts';

const open = (b: Uint8Array) => openPdf(new BytesSource(b));

/** Deterministic damaged copies: byte flips, truncations, deleted and duplicated ranges. */
function* mutants(src: Uint8Array, count: number, seed: number): Generator<Uint8Array> {
  const r = new Rng(seed);
  for (let i = 0; i < count; i++) {
    const at = r.int(0, src.length - 1);
    const len = r.int(1, 400);
    switch (i % 4) {
      case 0: {
        const m = src.slice();
        for (let k = 0; k < 12; k++) m[r.int(0, m.length - 1)] = r.int(0, 255);
        yield m;
        break;
      }
      case 1:
        yield src.slice(0, at);
        break;
      case 2:
        yield Buffer.concat([src.subarray(0, at), src.subarray(Math.min(src.length, at + len))]);
        break;
      default:
        yield Buffer.concat([src.subarray(0, at), src.subarray(at, at + len), src.subarray(at)]);
    }
  }
}

/** Run `fn` on damaged copies of `src`: each must settle with a value or an Error. */
async function survives(src: Uint8Array, seed: number, fn: (doc: Awaited<ReturnType<typeof open>>) => Promise<unknown>): Promise<number> {
  let ok = 0;
  for (const m of mutants(src, 80, seed)) {
    try {
      await fn(await open(m));
      ok++;
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  }
  return ok;
}

function mu(b: Uint8Array): mupdf.PDFDocument {
  mupdf.setLog({ error: () => {}, warning: () => {} });
  return mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
}

/**
 * A form with nested fields and inherited /FT, /Ff, /V and /DV; merged and separate widgets;
 * radio buttons, check boxes (with and without /V), combo and multi-select list boxes, a push
 * button, signed and unsigned signatures, a text-stream value, a field without a type and a
 * cycle in /Kids.
 */
function formDoc(): Uint8Array {
  const b = new DocBuilder();
  const page = b.alloc();
  const content = b.stream('', new Uint8Array(0));
  const widgets: number[] = [];
  let y = 800;
  const w = (entries: string, num = b.alloc()): number => {
    b.setObj(num, `<< /Type /Annot /Subtype /Widget /Rect [20 ${(y -= 30)} 200 ${y + 20}] /P ${page} 0 R ${entries} >>`);
    widgets.push(num);
    return num;
  };
  const ap = (on: string) => `/AP << /N << /${on} ${b.obj('<< >>')} 0 R /Off ${b.obj('<< >>')} 0 R >> >>`;

  // person (Tx, required) -> name (merged widget), address (inherited value) -> street, city (2 widgets).
  const person = b.alloc();
  const addr = b.alloc();
  const city = b.alloc();
  const name = w(`/T (name) /Parent ${person} 0 R /V <FEFF004A00F6006800F1> /DV (Anon)`);
  const street = w(`/T (street) /Parent ${addr} 0 R`);
  const cw1 = w(`/Parent ${city} 0 R`);
  const cw2 = w(`/Parent ${city} 0 R`);
  b.setObj(city, `<< /T (city) /Parent ${addr} 0 R /Ff 1 /V (Gent) /Kids [${cw1} 0 R ${cw2} 0 R] >>`);
  b.setObj(addr, `<< /T (address) /Parent ${person} 0 R /V (Main street 1) /DV (none) /Kids [${street} 0 R ${city} 0 R] >>`);
  b.setObj(person, `<< /T (person) /FT /Tx /Ff 2 /Kids [${name} 0 R ${addr} 0 R] >>`);

  // Radio group: V /B, three widgets.
  const rg = b.alloc();
  const radios = ['A', 'B', 'C'].map((s) => w(`/Parent ${rg} 0 R /AS /${s === 'B' ? 'B' : 'Off'} ${ap(s)}`));
  b.setObj(rg, `<< /T (pick) /FT /Btn /Ff 49152 /V /B /Kids [${radios.map((r) => `${r} 0 R`).join(' ')}] >>`);

  // Check boxes: one with /V, one with only /AS, one off.
  const cb1 = w(`/T (agree) /FT /Btn /V /Yes /AS /Yes ${ap('Yes')}`);
  const cb2 = w(`/T (newsletter) /FT /Btn /AS /On ${ap('On')}`);
  const cb3 = w(`/T (spam) /FT /Btn /V /Off /AS /Off ${ap('Ja')}`);

  const ch1 = w(`/T (country) /FT /Ch /Ff 131072 /Opt [[(be) (Belgium)] [(nl) (Netherlands)] (fr)] /V (nl) /DV (be)`);
  const ch2 = w(`/T (langs) /FT /Ch /Ff 2097152 /Opt [(en) (nl) (fr)] /V [(en) (fr)]`);
  const btn = w(`/T (submit) /FT /Btn /Ff 65536`);
  const sigV = b.obj('<< /Type /Sig /ByteRange [0 1 2 3] /Contents <00> >>');
  const sig1 = w(`/T (signed) /FT /Sig /V ${sigV} 0 R`);
  const sig2 = w(`/T (unsigned) /FT /Sig`);
  const notesV = b.stream('/Filter /FlateDecode', flate(new TextEncoder().encode('﻿Long\ntext')));
  const notes = w(`/T (notes) /FT /Tx /Ff 4096 /V ${notesV} 0 R`);
  const mystery = w(`/T (mystery)`);

  // A cycle: a field whose kid is its own parent.
  const loopA = b.alloc();
  const loopB = b.alloc();
  b.setObj(loopA, `<< /T (loop) /FT /Tx /Kids [${loopB} 0 R] >>`);
  b.setObj(loopB, `<< /T (inner) /Kids [${loopA} 0 R] /V (x) >>`);

  b.setObj(page, b.pageDict({ content: '', extra: ` /Annots [${widgets.map((n) => `${n} 0 R`).join(' ')}]` }, content));
  b.pages.push(page);
  const fields = [person, rg, cb1, cb2, cb3, ch1, ch2, btn, sig1, sig2, notes, mystery, loopA, 999];
  b.catalogExtra = ` /AcroForm << /Fields [${fields.map((n) => `${n} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) >>`;
  return b.finish().build().bytes;
}

const EXPECTED: FormField[] = [
  { name: 'person.name', type: 'text', value: 'Jöhñ', defaultValue: 'Anon', flags: 2, readOnly: false, required: true },
  { name: 'person.address.street', type: 'text', value: 'Main street 1', defaultValue: 'none', flags: 2, readOnly: false, required: true },
  { name: 'person.address.city', type: 'text', value: 'Gent', defaultValue: 'none', flags: 1, readOnly: true, required: false },
  { name: 'pick', type: 'radio', value: 'B', options: ['A', 'B', 'C'], flags: 49152, readOnly: false, required: false },
  { name: 'agree', type: 'checkbox', value: 'Yes', options: ['Yes'], flags: 0, readOnly: false, required: false },
  { name: 'newsletter', type: 'checkbox', value: 'On', options: ['On'], flags: 0, readOnly: false, required: false },
  { name: 'spam', type: 'checkbox', value: 'Off', options: ['Ja'], flags: 0, readOnly: false, required: false },
  {
    name: 'country', type: 'choice', value: 'nl', defaultValue: 'be', options: ['be', 'nl', 'fr'], optionLabels: ['Belgium', 'Netherlands', 'fr'],
    flags: 131072, readOnly: false, required: false,
  },
  { name: 'langs', type: 'choice', value: ['en', 'fr'], options: ['en', 'nl', 'fr'], flags: 2097152, readOnly: false, required: false },
  { name: 'submit', type: 'button', flags: 65536, readOnly: false, required: false },
  { name: 'signed', type: 'signature', signed: true, flags: 0, readOnly: false, required: false },
  { name: 'unsigned', type: 'signature', signed: false, flags: 0, readOnly: false, required: false },
  { name: 'notes', type: 'text', value: 'Long\ntext', flags: 4096, readOnly: false, required: false },
  { name: 'loop.inner', type: 'text', value: 'x', flags: 0, readOnly: false, required: false },
];

const MU_TYPES: Record<string, string> = {
  text: 'text', checkbox: 'checkbox', radiobutton: 'radio', combobox: 'choice', listbox: 'choice', button: 'button', signature: 'signature',
};

describe('getFormFields', () => {
  test('nested fields with inheritance, every field type', async () => {
    expect(await getFormFields(await open(formDoc()))).toEqual(EXPECTED);
  });

  test('agrees with mupdf on names, types, values and options', async () => {
    const bytes = formDoc();
    const ours = new Map((await getFormFields(await open(bytes))).map((f) => [f.name, f]));
    const m = mu(bytes);
    const page = m.loadPage(0);
    const seen = new Set<string>();
    for (const w of page.getWidgets()) {
      const name = w.getName();
      const f = ours.get(name);
      if (!f) {
        // mupdf lists widgets of fields we leave out: no type, or reached through a cycle.
        expect(['mystery', 'loop']).toContain(name.split('.')[0]);
        continue;
      }
      seen.add(name);
      expect(MU_TYPES[w.getFieldType()]).toBe(f.type);
      // mupdf reads only /V; without one we report the state the widget shows (/AS).
      if (name === 'newsletter') expect(w.getValue()).toBe('');
      else if (f.type === 'text' || f.type === 'checkbox' || f.type === 'radio') expect(w.getValue()).toBe(f.value as string);
      if (f.type === 'choice' && !Array.isArray(f.value)) expect(w.getValue()).toBe(f.value!);
      if (f.type === 'choice') expect(w.getOptions(true)).toEqual(f.options!);
      if (f.optionLabels) expect(w.getOptions(false)).toEqual(f.optionLabels);
      expect(w.isReadOnly()).toBe(f.readOnly);
    }
    expect(seen.size).toBe(ours.size - 1); // all but loop.inner, which has no widget
    page.destroy();
    m.destroy();
  });

  test('object streams and a damaged xref', async () => {
    const bytes = formDoc();
    const variants = [damage.startxref(bytes, 0)];
    if (hasQpdf) variants.push(qpdfTransform(bytes, ['--object-streams=generate']));
    for (const v of variants) expect(await getFormFields(await open(v))).toEqual(EXPECTED);
  });

  test('getInfo sees the form and the signature', async () => {
    expect(await getInfo(await open(formDoc()))).toMatchObject({ hasForms: true, signed: true });
  });

  test('deep nesting: 40 levels inheriting type, flags and value from the top', async () => {
    const b = new DocBuilder();
    b.page({ content: '' });
    const nums = Array.from({ length: 40 }, () => b.alloc());
    nums.forEach((n, i) => {
      const own = i === 0 ? ' /FT /Tx /Ff 3 /V (top) /DV <FEFF00DF>' : i === 20 ? ' /V (middle)' : '';
      const kids = i + 1 < nums.length ? ` /Kids [${nums[i + 1]} 0 R]` : ' /Subtype /Widget /Rect [0 0 1 1]';
      b.setObj(n, `<< /T (l${i})${own}${kids} >>`);
    });
    b.catalogExtra = ` /AcroForm << /Fields [${nums[0]} 0 R] >>`;
    const [f] = await getFormFields(await open(b.finish().build().bytes));
    expect(f).toEqual({
      name: nums.map((_, i) => `l${i}`).join('.'), type: 'text', value: 'middle', defaultValue: 'ß', flags: 3, readOnly: true, required: true,
    });
  });

  test('damaged copies settle with a result or an Error', async () => {
    const n = await survives(formDoc(), 3, getFormFields);
    expect(n).toBeGreaterThan(20);
  });

  test('no form', async () => {
    const b = new DocBuilder();
    b.page({ content: '' });
    b.catalogExtra = ' /AcroForm 999 0 R';
    expect(await getFormFields(await open(b.finish().build().bytes))).toEqual([]);
  });

  test('encrypted documents are rejected', async () => {
    if (!hasQpdf) return;
    const enc = await open(qpdfTransform(formDoc(), ['--encrypt', '', 'o', '256', '--']));
    expect(getFormFields(enc)).rejects.toBeInstanceOf(PdfEncryptedError);
  });
});
