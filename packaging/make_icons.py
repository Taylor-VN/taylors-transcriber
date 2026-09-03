#!/usr/bin/env python3
"""
Regenerate the app icon files from packaging/icon.svg.

This is a maintainer tool, not a build step: an installer needs an icon in
three formats on three CI runners, and every convenient way to rasterise an
SVG (librsvg, Inkscape, cairosvg) is an extra dependency that would have to
exist on all of them. Instead, whoever edits icon.svg runs this script once
on a Mac — sips already rasterises SVG at arbitrary sizes, and iconutil is
the only reliable way to build a bundle icon macOS accepts at every size
including the Finder's 1024 — and commits the resulting files under
packaging/icons/. The build scripts just copy those committed files.

    python3 packaging/make_icons.py

Writes packaging/icons/icon.png (1024), icon.ico (Windows) and icon.icns
(macOS). Requires macOS (sips, iconutil).
"""

import argparse
import os
import struct
import subprocess
import sys
import tempfile

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SVG = os.path.join(HERE, 'icon.svg')
DEFAULT_DEST = os.path.join(HERE, 'icons')


def rasterize(svg, size, out):
    subprocess.run(
        ['sips', '-s', 'format', 'png', '-z', str(size), str(size), svg,
         '--out', out],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def write_ico(path, svg):
    """
    An .ico is a small directory of images; since Vista those may be PNGs, so
    the rasterised sizes can be embedded as they are.
    """
    with tempfile.TemporaryDirectory() as tmp:
        blobs = []
        for size in ICO_SIZES:
            png_path = os.path.join(tmp, f'{size}.png')
            rasterize(svg, size, png_path)
            with open(png_path, 'rb') as fh:
                blobs.append((size, fh.read()))

        count = len(blobs)
        header = struct.pack('<HHH', 0, 1, count)
        offset = 6 + 16 * count
        entries, data = b'', b''
        for size, blob in blobs:
            entries += struct.pack('<BBBBHHII',
                                   0 if size >= 256 else size,
                                   0 if size >= 256 else size,
                                   0, 0, 1, 32, len(blob), offset)
            offset += len(blob)
            data += blob
        with open(path, 'wb') as fh:
            fh.write(header + entries + data)


def write_icns(path, svg):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, 'icon.iconset')
        os.makedirs(iconset)
        # iconutil expects this exact naming, and wants both scales of each size.
        for size in (16, 32, 128, 256, 512):
            rasterize(svg, size, os.path.join(iconset, f'icon_{size}x{size}.png'))
            rasterize(svg, size * 2, os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', path], check=True)


def main():
    if sys.platform != 'darwin':
        sys.exit('make_icons.py requires macOS (sips, iconutil)')

    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--svg', default=DEFAULT_SVG)
    ap.add_argument('--dest', default=DEFAULT_DEST)
    args = ap.parse_args()
    svg = os.path.abspath(args.svg)
    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    rasterize(svg, 1024, os.path.join(dest, 'icon.png'))
    print('[icons] icon.png')

    write_ico(os.path.join(dest, 'icon.ico'), svg)
    print('[icons] icon.ico')

    write_icns(os.path.join(dest, 'icon.icns'), svg)
    print('[icons] icon.icns')


if __name__ == '__main__':
    main()
