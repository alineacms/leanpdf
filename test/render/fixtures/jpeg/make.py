"""Regenerate the JPEG decoder fixtures: python3 make.py (needs Pillow).

Each <name>.jpg comes with <name>.<reduce>.raw: Pillow's (libjpeg-turbo's) decoding at 1/2^reduce,
as the samples stored in the file (CMYK not inverted), interleaved.
"""
import io, math, random
from PIL import Image

W, H = 45, 37
random.seed(1)

def pattern(mode):
    im = Image.new(mode, (W, H))
    px = im.load()
    n = len(mode) if mode != 'L' else 1
    for y in range(H):
        for x in range(W):
            v = []
            for c in range(n):
                t = (x * (c + 1) * 5 + y * (4 - c) * 3) % 256
                smooth = 128 + 100 * math.sin((x + 3 * c) / 7) * math.cos((y - 2 * c) / 5)
                v.append(int(smooth if x < 30 else t) & 255)
                if 12 < x < 20 and 10 < y < 25:
                    v[-1] = 30 + 180 * c % 256
            px[x, y] = v[0] if n == 1 else tuple(v)
    return im

def save(name, im, **kw):
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=90, **kw)
    data = bytearray(b.getvalue())
    if name.startswith('ycck'):
        # Mark as YCCK (Adobe transform 2, component IDs 1-4): decoders read the components as
        # Y, Cb, Cr, K.
        i = data.find(b'Adobe')
        data[i + 11] = 2
        sof = data.find(b'\xff\xc0')
        ids = {data[sof + 10 + 3 * c]: c + 1 for c in range(4)}
        for c in range(4):
            data[sof + 10 + 3 * c] = c + 1
        sos = data.find(b'\xff\xda')
        for c in range(data[sos + 4]):
            data[sos + 5 + 2 * c] = ids[data[sos + 5 + 2 * c]]
    open(name + '.jpg', 'wb').write(data)
    for reduce in range(4):
        d = Image.open(io.BytesIO(bytes(data)))
        if reduce:
            d.draft(d.mode, (W >> reduce, H >> reduce))
        raw = d.tobytes()
        if d.mode == 'CMYK':
            raw = bytes(255 - v for v in raw)
        open(f'{name}.{reduce}.raw', 'wb').write(raw)
        print(name, reduce, d.size, d.mode)

save('gray', pattern('L'))
save('rgb420', pattern('RGB'), subsampling=2)
save('rgb444-progressive', pattern('RGB'), subsampling=0, progressive=True)
save('cmyk', pattern('CMYK'))
save('cmyk-progressive-restart', pattern('CMYK'), progressive=True, restart_marker_blocks=3)
save('ycck', pattern('CMYK'))
