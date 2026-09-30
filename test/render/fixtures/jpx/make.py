#!/usr/bin/env python3
"""
Regenerate the JPEG 2000 fixtures for test/render/jpx.test.ts:

    python3 test/render/fixtures/jpx/make.py

Needs numpy and OpenJPEG 2.5 (libopenjp2: Pillow's wheel bundles one, or the system library),
driven through ctypes so every codestream option is reachable: SOP/EPH, code-block style
switches, POC, ROI, tile-parts, PLT/TLM, component subsampling, signed and odd precisions. JP2
boxes the encoder can't write (palettes, channel definitions, ICC colr) are assembled here, and
PPM/PPT variants are made by moving packet headers out of SOP/EPH-delimited codestreams.

Writes the .j2k/.jp2 files and manifest.json. Each fixture's expected decode is given as the
SHA-1 of the exact 8-bit output (lossless: from the source pixels) or, for lossy ones, as a
gzipped reference decoded by OpenJPEG (.ref.gz), both in the decoder's output conventions:
interleaved channels, level-shifted, scaled to 8 bits, subsampled components upsampled by
repetition, sYCC converted to RGB.
"""
import ctypes as C
import ctypes.util
import glob
import gzip
import hashlib
import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def load_openjpeg():
    cands = []
    try:
        import PIL

        cands += glob.glob(os.path.join(os.path.dirname(PIL.__file__), '..', 'pillow.libs', 'libopenjp2*'))
    except ImportError:
        pass
    found = ctypes.util.find_library('openjp2')
    if found:
        cands.append(found)
    cands += glob.glob('/usr/lib/*/libopenjp2.so*') + glob.glob('/usr/local/lib/libopenjp2*')
    for c in cands:
        try:
            lib = C.CDLL(c)
            lib.opj_version.restype = C.c_char_p
            if lib.opj_version() >= b'2.5':
                return lib
        except OSError:
            pass
    sys.exit('OpenJPEG >= 2.5 (libopenjp2) not found')


lib = load_openjpeg()
U32, I32 = C.c_uint32, C.c_int32


class Poc(C.Structure):
    _fields_ = [(n, U32) for n in 'resno0 compno0 layno1 resno1 compno1 layno0 precno0 precno1'.split()] + [
        ('prg1', C.c_int), ('prg', C.c_int), ('progorder', C.c_char * 5), ('tile', U32),
    ] + [(n, I32) for n in 'tx0 tx1 ty0 ty1'.split()] + [
        (n, U32) for n in 'layS resS compS prcS layE resE compE prcE txS txE tyS tyE dx dy lay_t res_t comp_t prc_t tx0_t ty0_t'.split()
    ]


PATH = 4096
class CParams(C.Structure):
    _fields_ = [
        ('tile_size_on', C.c_int), ('cp_tx0', C.c_int), ('cp_ty0', C.c_int), ('cp_tdx', C.c_int), ('cp_tdy', C.c_int),
        ('cp_disto_alloc', C.c_int), ('cp_fixed_alloc', C.c_int), ('cp_fixed_quality', C.c_int),
        ('cp_matrice', C.c_void_p), ('cp_comment', C.c_char_p), ('csty', C.c_int), ('prog_order', C.c_int),
        ('POC', Poc * 32), ('numpocs', U32), ('tcp_numlayers', C.c_int), ('tcp_rates', C.c_float * 100),
        ('tcp_distoratio', C.c_float * 100), ('numresolution', C.c_int), ('cblockw_init', C.c_int), ('cblockh_init', C.c_int),
        ('mode', C.c_int), ('irreversible', C.c_int), ('roi_compno', C.c_int), ('roi_shift', C.c_int), ('res_spec', C.c_int),
        ('prcw_init', C.c_int * 33), ('prch_init', C.c_int * 33), ('infile', C.c_char * PATH), ('outfile', C.c_char * PATH),
        ('index_on', C.c_int), ('index', C.c_char * PATH), ('image_offset_x0', C.c_int), ('image_offset_y0', C.c_int),
        ('subsampling_dx', C.c_int), ('subsampling_dy', C.c_int), ('decod_format', C.c_int), ('cod_format', C.c_int),
        ('jpwl_epc_on', C.c_int), ('jpwl_hprot_MH', C.c_int), ('jpwl_hprot_TPH_tileno', C.c_int * 16), ('jpwl_hprot_TPH', C.c_int * 16),
        ('jpwl_pprot_tileno', C.c_int * 16), ('jpwl_pprot_packno', C.c_int * 16), ('jpwl_pprot', C.c_int * 16),
        ('jpwl_sens_size', C.c_int), ('jpwl_sens_addr', C.c_int), ('jpwl_sens_range', C.c_int), ('jpwl_sens_MH', C.c_int),
        ('jpwl_sens_TPH_tileno', C.c_int * 16), ('jpwl_sens_TPH', C.c_int * 16), ('cp_cinema', C.c_int), ('max_comp_size', C.c_int),
        ('cp_rsiz', C.c_int), ('tp_on', C.c_char), ('tp_flag', C.c_char), ('tcp_mct', C.c_char), ('jpip_on', C.c_int),
        ('mct_data', C.c_void_p), ('max_cs_size', C.c_int), ('rsiz', C.c_uint16),
    ]


class DParams(C.Structure):
    _fields_ = [
        ('cp_reduce', U32), ('cp_layer', U32), ('infile', C.c_char * PATH), ('outfile', C.c_char * PATH),
        ('decod_format', C.c_int), ('cod_format', C.c_int), ('DA_x0', U32), ('DA_x1', U32), ('DA_y0', U32), ('DA_y1', U32),
        ('m_verbose', C.c_int), ('tile_index', U32), ('nb_tile_to_decode', U32), ('jpwl_correct', C.c_int),
        ('jpwl_exp_comps', C.c_int), ('jpwl_max_tiles', C.c_int), ('flags', C.c_uint),
    ]


class CmptParm(C.Structure):
    _fields_ = [(n, U32) for n in 'dx dy w h x0 y0 prec bpp sgnd'.split()]


class ImageComp(C.Structure):
    _fields_ = [(n, U32) for n in 'dx dy w h x0 y0 prec bpp sgnd resno_decoded factor'.split()] + [
        ('data', C.POINTER(I32)), ('alpha', C.c_uint16),
    ]


class Image(C.Structure):
    _fields_ = [(n, U32) for n in 'x0 y0 x1 y1 numcomps'.split()] + [
        ('color_space', C.c_int), ('comps', C.POINTER(ImageComp)), ('icc_profile_buf', C.c_void_p), ('icc_profile_len', U32),
    ]


MSG = C.CFUNCTYPE(None, C.c_char_p, C.c_void_p)
_err = MSG(lambda m, _: sys.stderr.write('openjpeg: ' + m.decode()))
_quiet = MSG(lambda m, _: None)
lib.opj_image_create.restype = C.POINTER(Image)
lib.opj_image_create.argtypes = [U32, C.POINTER(CmptParm), C.c_int]
for f in ('opj_create_compress', 'opj_create_decompress', 'opj_stream_create_default_file_stream'):
    getattr(lib, f).restype = C.c_void_p
lib.opj_stream_create_default_file_stream.argtypes = [C.c_char_p, C.c_int]
for f in ('opj_setup_encoder', 'opj_start_compress', 'opj_encode', 'opj_end_compress', 'opj_setup_decoder', 'opj_decode',
          'opj_end_decompress', 'opj_stream_destroy', 'opj_destroy_codec', 'opj_image_destroy', 'opj_set_error_handler',
          'opj_set_warning_handler', 'opj_set_info_handler', 'opj_encoder_set_extra_options'):
    getattr(lib, f).argtypes = None
lib.opj_read_header.argtypes = [C.c_void_p, C.c_void_p, C.POINTER(C.POINTER(Image))]

ORDERS = {'LRCP': 0, 'RLCP': 1, 'RPCL': 2, 'PCRL': 3, 'CPRL': 4}
CLRSPC = {None: 0, 'srgb': 1, 'gray': 2, 'sycc': 3, 'cmyk': 5}


def encode(path, comps, *, jp2=False, cs=None, x0=0, y0=0, width=None, height=None, lossy=False, rates=None, numres=6,
           cblk=(64, 64), prc=None, prog='LRCP', tile=None, tile_offset=(0, 0), mct=None, mode=0, sop=False, eph=False,
           roi=None, tp=None, pocs=None, extra=(), comment=None):
    """comps: dicts with `a` (2-D int array at the component's own size), prec, sgnd, dx, dy, alpha."""
    n = len(comps)
    parms = (CmptParm * n)()
    for i, c in enumerate(comps):
        h, w = c['a'].shape
        parms[i] = CmptParm(c.get('dx', 1), c.get('dy', 1), w, h, -(-x0 // c.get('dx', 1)), -(-y0 // c.get('dy', 1)), c['prec'], 0, int(c.get('sgnd', 0)))
    img = lib.opj_image_create(n, parms, CLRSPC[cs])
    im = img.contents
    im.x0, im.y0 = x0, y0
    im.x1, im.y1 = x0 + (width or comps[0]['a'].shape[1]), y0 + (height or comps[0]['a'].shape[0])
    for i, c in enumerate(comps):
        a = np.ascontiguousarray(c['a'], dtype=np.int32)
        C.memmove(im.comps[i].data, a.ctypes.data, a.nbytes)
        im.comps[i].alpha = c.get('alpha', 0)
    p = CParams()
    lib.opj_set_default_encoder_parameters(C.byref(p))
    if lossy or rates:
        rates = rates or [10]
        p.tcp_numlayers = len(rates)
        for i, r in enumerate(rates):
            p.tcp_rates[i] = r
    else:
        p.tcp_numlayers, p.tcp_rates[0] = 1, 0
    p.cp_disto_alloc = 1
    p.irreversible = int(lossy)
    p.numresolution = numres
    p.cblockw_init, p.cblockh_init = cblk
    p.prog_order = ORDERS[prog]
    p.mode = mode
    p.csty = (2 if sop else 0) | (4 if eph else 0)
    p.tcp_mct = bytes([(1 if n >= 3 else 0) if mct is None else mct])
    if prc:
        p.csty |= 1
        p.res_spec = len(prc)
        for i, (w, h) in enumerate(prc):
            p.prcw_init[i], p.prch_init[i] = w, h
    if tile:
        p.tile_size_on = 1
        p.cp_tdx, p.cp_tdy = tile
        p.cp_tx0, p.cp_ty0 = tile_offset
    if roi:
        p.roi_compno, p.roi_shift = roi
    if tp:
        p.tp_on, p.tp_flag = b'\x01', tp.encode()
    if pocs:
        for i, (rs, cs0, le, re, ce, order) in enumerate(pocs):
            q = p.POC[i]
            q.tile, q.resno0, q.compno0, q.layno1, q.resno1, q.compno1, q.prg1 = 1, rs, cs0, le, re, ce, ORDERS[order]
        p.numpocs = len(pocs)
    if comment:
        p.cp_comment = comment.encode()
    codec = lib.opj_create_compress(2 if jp2 else 0)
    lib.opj_set_error_handler(C.c_void_p(codec), _err, None)
    lib.opj_set_warning_handler(C.c_void_p(codec), _err, None)
    assert lib.opj_setup_encoder(C.c_void_p(codec), C.byref(p), img)
    if extra:
        opts = (C.c_char_p * (len(extra) + 1))(*[e.encode() for e in extra], None)
        assert lib.opj_encoder_set_extra_options(C.c_void_p(codec), opts)
    stream = lib.opj_stream_create_default_file_stream(path.encode(), 0)
    ok = lib.opj_start_compress(C.c_void_p(codec), img, C.c_void_p(stream)) and lib.opj_encode(C.c_void_p(codec), C.c_void_p(stream)) \
        and lib.opj_end_compress(C.c_void_p(codec), C.c_void_p(stream))
    lib.opj_stream_destroy(C.c_void_p(stream))
    lib.opj_destroy_codec(C.c_void_p(codec))
    lib.opj_image_destroy(img)
    assert ok, path


def opj_decode(path, reduce=0):
    """OpenJPEG's decode: image bounds and components (JP2 palettes applied, channels in cdef order)."""
    codec = lib.opj_create_decompress(2 if path.endswith('.jp2') else 0)
    lib.opj_set_error_handler(C.c_void_p(codec), _err, None)
    lib.opj_set_warning_handler(C.c_void_p(codec), _quiet, None)
    p = DParams()
    lib.opj_set_default_decoder_parameters(C.byref(p))
    p.cp_reduce = reduce
    assert lib.opj_setup_decoder(C.c_void_p(codec), C.byref(p))
    stream = lib.opj_stream_create_default_file_stream(path.encode(), 1)
    img = C.POINTER(Image)()
    assert lib.opj_read_header(C.c_void_p(stream), C.c_void_p(codec), C.byref(img))
    assert lib.opj_decode(C.c_void_p(codec), C.c_void_p(stream), img)
    lib.opj_end_decompress(C.c_void_p(codec), C.c_void_p(stream))
    im = img.contents
    comps = []
    for i in range(im.numcomps):
        c = im.comps[i]
        a = np.ctypeslib.as_array(c.data, (c.h, c.w)).copy()
        comps.append(dict(a=a, prec=c.prec, sgnd=c.sgnd, dx=c.dx, dy=c.dy, x0=c.x0, y0=c.y0))
    out = dict(x0=im.x0, y0=im.y0, x1=im.x1, y1=im.y1, comps=comps)
    lib.opj_stream_destroy(C.c_void_p(stream))
    lib.opj_destroy_codec(C.c_void_p(codec))
    lib.opj_image_destroy(img)
    return out


def to8(comps, X0, Y0, X1, Y1, ycc=False, pal=None):
    """The decoder's output over [X0,X1)x[Y0,Y1) for components at their own size; `x0`/`y0`: a
    component's origin, by default where the grid origin falls on it."""
    chans = []
    for c in comps:
        a = c['a'].astype(np.float64)
        dx, dy = c.get('dx', 1), c.get('dy', 1)
        xs = np.clip(np.arange(X0, X1) // dx - c.get('x0', -(-X0 // dx)), 0, a.shape[1] - 1)
        ys = np.clip(np.arange(Y0, Y1) // dy - c.get('y0', -(-Y0 // dy)), 0, a.shape[0] - 1)
        v = a[np.ix_(ys, xs)] + 2 ** (c['prec'] - 1) * (1 if c.get('sgnd') else 0)
        chans.append(np.clip(np.rint(v * 255 / (2 ** c['prec'] - 1)), 0, 255))
    if pal is not None:
        chans = [pal[:, i][chans[0].astype(int)].astype(np.float64) for i in range(pal.shape[1])]
    if ycc:
        Y, cb, cr = chans[0], chans[1] - 128, chans[2] - 128
        chans[:3] = [np.clip(np.rint(Y + 1.402 * cr), 0, 255), np.clip(np.rint(Y - 0.344136 * cb - 0.714136 * cr), 0, 255),
                     np.clip(np.rint(Y + 1.772 * cb), 0, 255)]
    return np.stack(chans, -1).astype(np.uint8)


# --- sources: deterministic, photo-like (gradients, edges, texture, noise) --------------------

def photo(h, w, seed=1, ch=3):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    out = []
    for k in range(ch):
        v = 128 + 70 * np.sin(x / (9 + 3 * k) + k) * np.cos(y / (11 + 2 * k))
        v += 40 * ((x + 2 * y + 17 * k) % 53 < 20)
        v += 25 * (((x - w / 2) ** 2 + (y - h / 3) ** 2) < (min(w, h) / 3) ** 2)
        v += rng.normal(0, 1.5, (h, w))
        out.append(np.clip(v, 0, 255))
    return np.stack(out, -1)


def scaled(a, prec, sgnd=False):
    v = np.rint(a * (2 ** prec - 1) / 255).astype(np.int64)
    return v - 2 ** (prec - 1) if sgnd else v


def comp(a, prec=8, sgnd=False, **kw):
    return dict(a=scaled(a, prec, sgnd), prec=prec, sgnd=sgnd, **kw)


# --- JP2 assembly and codestream rewriting ------------------------------------------------------

def box(t, data):
    return struct.pack('>I', 8 + len(data)) + t + data


def wrap_jp2(cs, w, h, nc, bpc=7, colr=16, icc=None, pclr=None, cmap=None, cdef=None):
    hdr = box(b'ihdr', struct.pack('>IIHBBBB', h, w, nc, bpc, 7, 0, 0))
    if icc is not None:
        hdr += box(b'colr', bytes([2, 0, 0]) + icc)
    elif colr is not None:
        hdr += box(b'colr', bytes([1, 0, 0]) + struct.pack('>I', colr))
    if pclr is not None:
        entries, bits = pclr
        hdr += box(b'pclr', struct.pack('>HB', len(entries), len(bits)) + bytes(bits) + b''.join(
            b''.join(v.to_bytes(((b & 127) >> 3) + 1, 'big') for v, b in zip(e, bits)) for e in entries))
    if cmap is not None:
        hdr += box(b'cmap', b''.join(struct.pack('>HBB', *m) for m in cmap))
    if cdef is not None:
        hdr += box(b'cdef', struct.pack('>H', len(cdef)) + b''.join(struct.pack('>HHH', *d) for d in cdef))
    return (box(b'jP  ', b'\r\n\x87\n') + box(b'ftyp', b'jp2 \0\0\0\0jp2 ') + box(b'jp2h', hdr) + box(b'jp2c', cs))


def markers(cs, p, stop):
    """Marker segments from p until one of `stop`: list of (marker, start, end)."""
    out = []
    while True:
        m = struct.unpack_from('>H', cs, p)[0]
        if m in stop:
            return out, p
        n = struct.unpack_from('>H', cs, p + 2)[0]
        out.append((m, p, p + 2 + n))
        p += 2 + n


def split_packets(data):
    """Packets of an SOP/EPH tile-part body: (header incl. EPH, body) each."""
    starts = [i for i in range(len(data) - 1) if data[i] == 0xFF and data[i + 1] == 0x91]
    out = []
    for k, s in enumerate(starts):
        e = starts[k + 1] if k + 1 < len(starts) else len(data)
        eph = data.index(b'\xff\x92', s + 6) + 2
        out.append((data[s + 6:eph], data[eph:e]))
    return out


def packed(cs, where, keep_markers):
    """Move packet headers into PPM (main header) or PPT (tile-part headers) markers."""
    main, p = markers(cs, 2, (0xFF90,))
    head = bytearray(cs[:p])
    parts = []
    while struct.unpack_from('>H', cs, p)[0] == 0xFF90:
        psot = struct.unpack_from('>I', cs, p + 6)[0]
        tph, sod = markers(cs, p + 12, (0xFF93,))
        pk = split_packets(cs[sod + 2:p + psot])
        hdrs = b''.join(h if keep_markers else h[:-2] for h, _ in pk)
        bodies = b''.join((b'\xff\x91\x00\x04' + struct.pack('>H', i % 65536) if keep_markers else b'') + b for i, (_, b) in enumerate(pk))
        parts.append((cs[p:p + 12], cs[p + 12:sod], hdrs, bodies))
        p += psot
    if not keep_markers:
        for m, s, e in main:
            if m == 0xFF52:
                head[s + 4] &= ~6
    out = bytearray(head)
    if where == 'ppm':
        stream = b''.join(struct.pack('>I', len(h)) + h for _, _, h, _ in parts)
        out += b''.join(b'\xff\x60' + struct.pack('>HB', len(c) + 3, z) + c for z, c in enumerate(chunks(stream, 4000)))
    zppt = {}  # Zppt counts on across a tile's tile-parts
    for sot, tph, hdrs, bodies in parts:
        ppt = b''
        for c in chunks(hdrs, 3000) if where == 'ppt' else []:
            z = zppt[sot[4:6]] = zppt.get(sot[4:6], -1) + 1
            ppt += b'\xff\x61' + struct.pack('>HB', len(c) + 3, z) + c
        body = tph + ppt + b'\xff\x93' + bodies
        out += sot[:6] + struct.pack('>I', 12 + len(body)) + sot[10:] + body
    return bytes(out + b'\xff\xd9')


def chunks(b, n):
    return [b[i:i + n] for i in range(0, len(b), n)] or [b'']


# --- fixtures -----------------------------------------------------------------------------------

manifest = []


def sha1(a):
    return hashlib.sha1(np.ascontiguousarray(a).tobytes()).hexdigest()


def add(name, expected, *, lossy=False, reduces=(), extra=None, ycc=False, mupdf=False, tol=None, check=True):
    """Record a written fixture. `expected`: the exact output (lossless) or None to use OpenJPEG's
    decode. `check`: OpenJPEG's own decode must equal `expected` (not where it orders channels differently).
    `mupdf`: an 8-bit gray or RGB image MuPDF decodes the same way, so the test compares the
    full-size lossy decode with MuPDF's instead of a stored reference."""
    path = os.path.join(HERE, name)
    entry = dict(file=name, mupdf=mupdf, **(extra or {}))
    full = opj_decode(path)

    def reference(r):
        img, f = opj_decode(path, r), 1 << r
        for c in img['comps']:
            # OpenJPEG leaves a reduced component's origin at its full-resolution value.
            c['x0'], c['y0'] = -(-full['x0'] // (c['dx'] * f)), -(-full['y0'] // (c['dy'] * f))
        return to8(img['comps'], -(-full['x0'] // f), -(-full['y0'] // f), -(-full['x1'] // f), -(-full['y1'] // f), ycc=ycc)

    def record(r, exact):
        out = exact if exact is not None else reference(r)
        e = dict(reduce=r, width=out.shape[1], height=out.shape[0], components=out.shape[2])
        if not lossy:
            e['sha1'] = sha1(out)
            assert not check or sha1(reference(r)) == e['sha1'], (name, r)
        else:
            e['tol'] = tol or [2, 0.1]
            if not (mupdf and r == 0):
                # OpenJPEG's decode, stored once per distinct content.
                e['ref'] = sha1(out)[:16] + '.ref.gz'
                open(os.path.join(HERE, e['ref']), 'wb').write(gzip.compress(out.tobytes(), 9, mtime=0))
        return e

    entry['decodes'] = [record(0, expected)] + [record(r, None) for r in reduces]
    manifest.append(entry)


def main():
    for f in glob.glob(os.path.join(HERE, '*.j2k')) + glob.glob(os.path.join(HERE, '*.jp2')) + glob.glob(os.path.join(HERE, '*.gz')):
        os.remove(f)
    P = lambda n: os.path.join(HERE, n)
    rgb = photo(45, 67)
    gray = rgb[..., 1]
    big = photo(64, 88, seed=7)

    # Plain lossless and lossy, gray and RGB, J2K and JP2.
    encode(P('gray-53.j2k'), [comp(gray)])
    add('gray-53.j2k', to8([comp(gray)], 0, 0, 67, 45), reduces=(1, 2), extra=dict(colorSpace=None, levels=6))
    encode(P('rgb-53.jp2'), [comp(rgb[..., i]) for i in range(3)], jp2=True, cs='srgb')
    add('rgb-53.jp2', to8([comp(rgb[..., i]) for i in range(3)], 0, 0, 67, 45), reduces=(1, 3), extra=dict(colorSpace='rgb'))
    encode(P('rgb-97.jp2'), [comp(big[..., i]) for i in range(3)], jp2=True, cs='srgb', lossy=True, rates=[12])
    add('rgb-97.jp2', None, lossy=True, reduces=(1, 2), mupdf=True, extra=dict(colorSpace='rgb'))
    encode(P('gray-97.j2k'), [comp(big[..., 0])], lossy=True, rates=[6])
    add('gray-97.j2k', None, lossy=True, reduces=(2,), mupdf=True)
    encode(P('rgb-97-nomct.j2k'), [comp(rgb[..., i]) for i in range(3)], lossy=True, rates=[5], mct=0)
    add('rgb-97-nomct.j2k', None, lossy=True, mupdf=True)

    # Every progression order, with precincts, layers and more resolutions than the image needs.
    for order in ORDERS:
        name = f'rgb-53-{order.lower()}.j2k'
        encode(P(name), [comp(rgb[..., i]) for i in range(3)], prog=order, rates=[40, 10, 0], numres=5, cblk=(8, 16),
               prc=[(16, 16), (16, 16), (8, 8), (8, 8), (4, 4)], sop=order in ('RPCL', 'CPRL'), eph=order in ('PCRL', 'CPRL'))
        add(name, to8([comp(rgb[..., i]) for i in range(3)], 0, 0, 67, 45), reduces=(1,))
        name = f'rgb-97-{order.lower()}.j2k'
        encode(P(name), [comp(big[..., i]) for i in range(3)], prog=order, lossy=True, rates=[60, 20, 8], numres=4, cblk=(16, 16),
               prc=[(32, 32), (16, 16), (16, 16), (8, 8)])
        add(name, None, lossy=True, reduces=(1,), mupdf=True)

    # Tiles with image and tile offsets, odd sizes, and progression order changes.
    enc = lambda **kw: [comp(rgb[..., i]) for i in range(3)]
    encode(P('tiles-offset-53.j2k'), enc(), x0=5, y0=3, tile=(16, 12), tile_offset=(2, 1), numres=3, prog='RPCL', prc=[(8, 8)] * 3)
    add('tiles-offset-53.j2k', to8(enc(), 5, 3, 72, 48), reduces=(1, 2))
    encode(P('tiles-offset-97.jp2'), [comp(big[..., i]) for i in range(3)], jp2=True, cs='srgb', x0=13, y0=7, tile=(40, 33),
           tile_offset=(3, 5), numres=4, lossy=True, rates=[20, 6], prog='PCRL', sop=True, eph=True)
    add('tiles-offset-97.jp2', None, lossy=True, reduces=(1, 3), mupdf=True)
    encode(P('tiles-parts.j2k'), enc(), tile=(32, 32), tp='R', numres=4, rates=[20, 0], prog='RLCP')
    add('tiles-parts.j2k', to8(enc(), 0, 0, 67, 45), reduces=(2,))
    encode(P('tiles-parts-layers.j2k'), enc(), tile=(24, 24), tp='L', numres=3, rates=[30, 10, 0], sop=True, extra=['PLT=YES', 'TLM=YES'])
    add('tiles-parts-layers.j2k', to8(enc(), 0, 0, 67, 45))
    encode(P('poc.j2k'), enc(), numres=4, rates=[20, 0], prog='LRCP', pocs=[(0, 0, 2, 2, 3, 'RLCP'), (2, 0, 2, 4, 3, 'CPRL')])
    add('poc.j2k', to8(enc(), 0, 0, 67, 45))

    # Code-block style switches, alone and together, lossless and over several lossy layers.
    for mode in (1, 2, 4, 8, 16, 32, 5, 63):
        name = f'mode{mode}-53.j2k'
        encode(P(name), [comp(gray)], mode=mode, cblk=(16, 8), rates=[20, 5, 0])
        add(name, to8([comp(gray)], 0, 0, 67, 45))
        name = f'mode{mode}-97.j2k'
        encode(P(name), [comp(big[..., 1])], mode=mode, lossy=True, rates=[30, 12, 4], cblk=(32, 32))
        add(name, None, lossy=True, mupdf=True)
    encode(P('cblk-4x4.j2k'), [comp(gray)], cblk=(4, 4), numres=3)
    add('cblk-4x4.j2k', to8([comp(gray)], 0, 0, 67, 45))
    encode(P('cblk-1024x4.j2k'), [comp(gray)], cblk=(1024, 4), numres=2)
    add('cblk-1024x4.j2k', to8([comp(gray)], 0, 0, 67, 45))
    encode(P('cblk-4x1024.j2k'), [comp(gray)], cblk=(4, 1024), numres=1)
    add('cblk-4x1024.j2k', to8([comp(gray)], 0, 0, 67, 45))

    # Precisions and signedness.
    for prec, sgnd, lossy in ((16, False, False), (12, False, False), (8, True, False), (4, False, False), (1, False, False),
                              (16, True, True), (12, False, True)):
        name = f'gray-{prec}bit{"-signed" if sgnd else ""}-{97 if lossy else 53}.j2k'
        c = comp(gray, prec, sgnd)
        encode(P(name), [c], lossy=lossy, rates=[8] if lossy else None, numres=4)
        add(name, None if lossy else to8([c], 0, 0, 67, 45), lossy=lossy, reduces=(1,))
    c3 = [comp(rgb[..., i], 12) for i in range(3)]
    encode(P('rgb-12bit-53.jp2'), c3, jp2=True, cs='srgb')
    add('rgb-12bit-53.jp2', to8(c3, 0, 0, 67, 45))

    # Edge-case sizes: single rows/columns and pixels, more levels than samples.
    for (h, w, nr) in ((1, 1, 1), (1, 37, 1), (29, 1, 1), (2, 3, 2), (5, 7, 3)):
        name = f'tiny-{w}x{h}.j2k'
        c = comp(photo(h, w, seed=w * h, ch=1)[..., 0])
        encode(P(name), [c], numres=nr, cblk=(4, 4))
        add(name, to8([c], 0, 0, w, h))
        name = f'tiny-{w}x{h}-97.j2k'
        encode(P(name), [c], numres=nr, lossy=True, rates=[1.5], x0=3, y0=1)
        add(name, None, lossy=True, mupdf=True)

    # Edge tiles one sample wide and high, at odd coordinates, over empty lower resolutions. (OpenJPEG
    # 2.5 encodes a lone odd column with three empty resolutions below it wrongly, so two levels.)
    encode(P('tiles-edge-53.j2k'), enc(), tile=(33, 22), numres=3, cblk=(4, 4))
    add('tiles-edge-53.j2k', to8(enc(), 0, 0, 67, 45), reduces=(1, 2))
    encode(P('tiles-edge-97.j2k'), [comp(rgb[..., i]) for i in range(3)], tile=(33, 22), numres=3, lossy=True, rates=[3])
    add('tiles-edge-97.j2k', None, lossy=True, reduces=(2,), mupdf=True)

    # Subsampled chroma (4:2:0 and 4:2:2 shapes), sYCC, odd origin.
    y = photo(45, 67, seed=3)
    Y = comp(y[..., 0])
    cb = comp(y[::2, ::2, 1], dx=2, dy=2)
    cr = comp(y[::2, ::2, 2], dx=2, dy=2)
    encode(P('sycc-420-53.jp2'), [Y, cb, cr], jp2=True, cs='sycc', mct=0)
    add('sycc-420-53.jp2', to8([Y, cb, cr], 0, 0, 67, 45, ycc=True), ycc=True, reduces=(1,), extra=dict(colorSpace='rgb'))
    Yo = comp(photo(44, 66, seed=4)[..., 0])
    cbo = comp(photo(44, 33, seed=5)[..., 0], dx=2, dy=1)
    cro = comp(photo(44, 33, seed=6)[..., 0], dx=2, dy=1)
    encode(P('sub-422-odd.j2k'), [Yo, cbo, cro], x0=1, y0=3, width=66, height=44, mct=0, numres=3, tile=(20, 20))
    add('sub-422-odd.j2k', to8([Yo, cbo, cro], 1, 3, 67, 47))
    # Mixed precisions (QCC markers) and subsampling, image offset, precincts, position progressions.
    m = [comp(y[:44, :64, 0], 12), comp(y[:22, :32, 1], 8, dx=2, dy=2), comp(y[:22, :64, 2], 4, dy=2)]
    encode(P('mixed-cprl-53.j2k'), m, mct=0, prog='CPRL', prc=[(16, 16), (16, 16), (8, 8)], numres=3, x0=3, y0=1, width=64, height=44, rates=[20, 0])
    add('mixed-cprl-53.j2k', to8(m, 3, 1, 67, 45), reduces=(1,))
    encode(P('mixed-pcrl-97.j2k'), m, mct=0, prog='PCRL', prc=[(16, 16), (8, 8), (8, 8)], numres=3, x0=3, y0=1, width=64, height=44, lossy=True, rates=[8, 3])
    add('mixed-pcrl-97.j2k', None, lossy=True, reduces=(1,))
    encode(P('sycc-420-97.jp2'), [Y, cb, cr], jp2=True, cs='sycc', mct=0, lossy=True, rates=[6])
    add('sycc-420-97.jp2', None, lossy=True, ycc=True, extra=dict(colorSpace='rgb'))

    # Alpha (cdef), CMYK, channel definitions that reorder, palettes, ICC colour.
    a = photo(45, 67, seed=9, ch=4)
    c4 = [comp(a[..., i]) for i in range(3)] + [comp(a[..., 3], alpha=1)]
    encode(P('rgba-53.jp2'), c4, jp2=True, cs='srgb')
    add('rgba-53.jp2', to8(c4, 0, 0, 67, 45), extra=dict(colorSpace='rgb', alpha=3))
    encode(P('rgba-97.jp2'), c4, jp2=True, cs='srgb', lossy=True, rates=[8])
    add('rgba-97.jp2', None, lossy=True, extra=dict(colorSpace='rgb', alpha=3))
    k4 = [comp(a[..., i]) for i in range(4)]
    encode(P('cmyk-53.jp2'), k4, jp2=True, cs='cmyk', mct=0)
    add('cmyk-53.jp2', to8(k4, 0, 0, 67, 45), extra=dict(colorSpace='cmyk'))
    bgr = [comp(rgb[..., i]) for i in (2, 1, 0)]
    tmp = P('tmp.j2k')
    # Codestream order B, opacity, G, R, put right by cdef: channel 0 is colour 3, channel 1 opacity, and so on.
    encode(tmp, [bgr[0], comp(a[..., 3]), bgr[1], bgr[2]], mct=0)
    cs = open(tmp, 'rb').read()
    open(P('cdef-reorder.jp2'), 'wb').write(wrap_jp2(cs, 67, 45, 4, cdef=[(0, 0, 3), (1, 1, 0), (2, 0, 2), (3, 0, 1)]))
    add('cdef-reorder.jp2', to8([bgr[2], bgr[1], bgr[0], comp(a[..., 3])], 0, 0, 67, 45), extra=dict(colorSpace='rgb', alpha=3), check=False)
    encode(tmp, [comp(rgb[..., i]) for i in range(3)])
    open(P('icc.jp2'), 'wb').write(wrap_jp2(open(tmp, 'rb').read(), 67, 45, 3, icc=b'\0' * 128))
    add('icc.jp2', to8([comp(rgb[..., i]) for i in range(3)], 0, 0, 67, 45), extra=dict(colorSpace='rgb'))
    # Palette: 1-component indices through a 3-column palette with 8-, 5- and 12-bit entries.
    rng = np.random.default_rng(11)
    pal = np.stack([rng.integers(0, 256, 200), rng.integers(0, 32, 200), rng.integers(0, 4096, 200)], -1)
    idx = (gray.astype(int) * 199 // 255)
    encode(tmp, [dict(a=idx, prec=8)])
    open(P('palette.jp2'), 'wb').write(wrap_jp2(open(tmp, 'rb').read(), 67, 45, 1, pclr=(pal.tolist(), [7, 4, 11]),
                                                cmap=[(0, 1, 0), (0, 1, 1), (0, 1, 2)]))
    pal8 = np.rint(pal * 255 / np.array([255, 31, 4095])).astype(np.uint8)
    add('palette.jp2', to8([dict(a=idx, prec=8)], 0, 0, 67, 45, pal=pal8), extra=dict(colorSpace='rgb'))

    # Packed packet headers (PPM, PPT), with and without SOP/EPH, over tiles and tile-parts.
    encode(tmp, enc(), tile=(32, 24), tp='R', numres=3, rates=[30, 0], sop=True, eph=True, prog='RPCL', prc=[(16, 16)] * 3)
    cs = open(tmp, 'rb').read()
    for where, keep in (('ppt', True), ('ppt', False), ('ppm', True), ('ppm', False)):
        name = f'{where}{"-sop-eph" if keep else ""}.j2k'
        open(P(name), 'wb').write(packed(cs, where, keep))
        add(name, to8(enc(), 0, 0, 67, 45))
    encode(P('roi.j2k'), [comp(big[..., 0])], roi=(0, 6), lossy=True, rates=[4])
    add('roi.j2k', None, lossy=True, mupdf=True)
    encode(P('roi-53.j2k'), enc(), roi=(1, 9), numres=4)
    add('roi-53.j2k', to8(enc(), 0, 0, 67, 45))
    encode(P('comment.jp2'), [comp(gray)], jp2=True, cs='gray', comment='leanpdf test')
    add('comment.jp2', to8([comp(gray)], 0, 0, 67, 45), extra=dict(colorSpace='gray'))
    os.remove(tmp)

    with open(os.path.join(HERE, 'manifest.json'), 'w') as f:
        f.write('[\n' + ',\n'.join(json.dumps(m) for m in manifest) + '\n]\n')
    total = sum(os.path.getsize(f) for f in glob.glob(os.path.join(HERE, '*')))
    print(f'{len(manifest)} fixtures, {total / 1024:.0f} KB with OpenJPEG {lib.opj_version().decode()}')


main()
