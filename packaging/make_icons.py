#!/usr/bin/env python3
"""
Draw the app icon, in pure Python.

An installer needs an icon in three formats on three runners, and every
convenient way to rasterise an SVG (librsvg, Inkscape, cairosvg, Pillow) is an
extra dependency that has to exist on all of them. The icon is simple enough —
a rounded tile and two caption bars — to draw analytically instead, so this
module writes the PNG bytes itself with nothing but zlib.

Antialiasing comes from signed distance fields rather than supersampling: each
shape reports its distance to the nearest edge, and pixel coverage is that
distance clamped across one pixel. That is both sharper and far faster than
rendering at 4x and downsampling, which matters at 1024x1024 in pure Python.

    python3 packaging/make_icons.py --dest build/icons

Writes icon.png (1024), icon.ico (Windows) and, on macOS, icon.icns.
"""

import argparse
import os
import struct
import subprocess
import sys
import zlib

# Graphite tile, warm off-white bars: legible on both a light and a dark dock,
# and still readable when the Windows taskbar shrinks it to 16 px.
BG_TOP = (0x23, 0x27, 0x2F)
BG_BOTTOM = (0x14, 0x16, 0x1B)
BAR = (0xF5, 0xF2, 0xEA)
ACCENT = (0xE8, 0x8B, 0x3C)

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def _rounded_rect_sdf(x, y, cx, cy, hw, hh, r):
    """Signed distance from (x, y) to a rounded rectangle. Negative is inside."""
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    ax, ay = max(dx, 0.0), max(dy, 0.0)
    outside = (ax * ax + ay * ay) ** 0.5
    inside = min(max(dx, dy), 0.0)
    return outside + inside - r


def _coverage(dist):
    """Pixel coverage from a distance, giving a one-pixel antialiased edge."""
    return min(max(0.5 - dist, 0.0), 1.0)


def _blend(dst, src, alpha):
    return tuple(int(round(d + (s - d) * alpha)) for d, s in zip(dst, src))


def render(size):
    """Return raw RGBA rows for one square icon of the given size."""
    s = float(size)
    # Proportions are fractions of the canvas so every size is the same picture.
    tile_inset = 0.055 * s
    tile_radius = 0.225 * s
    cx = cy = s / 2.0

    bars = [
        # (centre y, half width, half height) as fractions, longest bar on top.
        (0.615, 0.300, 0.052),
        (0.775, 0.205, 0.052),
    ]
    bar_radius = 0.052 * s

    # A small waveform above the caption bars: the icon then says "sound becomes
    # captions" rather than reading as a generic card. Five bars is the fewest
    # that still scans as a waveform once it is 16 px wide.
    wave_y = 0.355
    wave_hw = 0.021
    wave = [(-0.124, 0.052), (-0.062, 0.104), (0.0, 0.148),
            (0.062, 0.090), (0.124, 0.046)]

    rows = []
    for py in range(size):
        y = py + 0.5
        row = bytearray()
        # Vertical gradient across the tile, computed once per row.
        t = py / max(s - 1.0, 1.0)
        bg = tuple(int(round(a + (b - a) * t)) for a, b in zip(BG_TOP, BG_BOTTOM))
        for px in range(size):
            x = px + 0.5
            tile = _coverage(_rounded_rect_sdf(
                x, y, cx, cy, (s / 2.0) - tile_inset, (s / 2.0) - tile_inset,
                tile_radius))
            if tile <= 0.0:
                row += b'\x00\x00\x00\x00'
                continue

            colour = bg
            for dx, hh in wave:
                a = _coverage(_rounded_rect_sdf(
                    x, y, cx + dx * s, wave_y * s, wave_hw * s, hh * s,
                    wave_hw * s))
                if a > 0.0:
                    colour = _blend(colour, ACCENT, a)
            for by, bw, bh in bars:
                c = _coverage(_rounded_rect_sdf(
                    x, y, cx, by * s, bw * s, bh * s, bar_radius))
                if c > 0.0:
                    colour = _blend(colour, BAR, c)

            row += bytes(colour) + bytes((int(round(tile * 255)),))
        rows.append(bytes(row))
    return rows


def png_bytes(rows, size):
    """Encode RGBA rows as a PNG."""
    raw = b''.join(b'\x00' + r for r in rows)  # filter type 0 per scanline

    def chunk(tag, data):
        body = tag + data
        return (struct.pack('>I', len(data)) + body
                + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF))

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def write_png(path, size):
    data = png_bytes(render(size), size)
    with open(path, 'wb') as fh:
        fh.write(data)
    return data


def write_ico(path, pngs):
    """
    An .ico is a small directory of images; since Vista those may be PNGs, so
    the sizes rendered above can be embedded as they are.
    """
    count = len(pngs)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries, blobs = b'', b''
    for size, blob in pngs:
        entries += struct.pack('<BBBBHHII',
                               0 if size >= 256 else size,
                               0 if size >= 256 else size,
                               0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        blobs += blob
    with open(path, 'wb') as fh:
        fh.write(header + entries + blobs)


def write_icns(path, dest):
    """
    Build the .icns through iconutil, which is the only way to get a bundle
    icon macOS reliably accepts at every size including the Finder's 1024.
    """
    iconset = os.path.join(dest, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    # iconutil expects this exact naming, and wants both scales of each size.
    for size in (16, 32, 128, 256, 512):
        write_png(os.path.join(iconset, f'icon_{size}x{size}.png'), size)
        write_png(os.path.join(iconset, f'icon_{size}x{size}@2x.png'), size * 2)
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', path], check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dest', required=True)
    args = ap.parse_args()
    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    write_png(os.path.join(dest, 'icon.png'), 1024)
    print('[icons] icon.png')

    write_ico(os.path.join(dest, 'icon.ico'),
              [(s, png_bytes(render(s), s)) for s in ICO_SIZES])
    print('[icons] icon.ico')

    if sys.platform == 'darwin':
        write_icns(os.path.join(dest, 'icon.icns'), dest)
        print('[icons] icon.icns')


if __name__ == '__main__':
    main()
