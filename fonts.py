"""
System font lookup.

Premiere stores typography by PostScript name — "Specsavers-Regular", not
"Specsavers" + weight 400 — so matching an imported caption style to something
the canvas can actually draw means finding the real font file on disk and
handing its bytes to the page, which registers it with the FontFace API.

Filenames are only a hint (plenty of foundries ship "SpecRg.otf"), so this reads
the sfnt `name` table out of each font instead. That is a small, well-specified
binary format, and parsing it here keeps the dependency list unchanged.
"""

import os
import struct
import sys
import threading


# nameID values from the OpenType `name` table spec.
NAME_FAMILY = 1
NAME_SUBFAMILY = 2
NAME_FULL = 4
NAME_POSTSCRIPT = 6
NAME_TYPO_FAMILY = 16
NAME_TYPO_SUBFAMILY = 17

FONT_EXTENSIONS = ('.ttf', '.otf', '.ttc', '.otc')


def font_directories():
    """Standard per-user and system font locations for the current platform."""
    home = os.path.expanduser('~')
    if sys.platform == 'darwin':
        return [
            os.path.join(home, 'Library', 'Fonts'),
            '/Library/Fonts',
            '/System/Library/Fonts',
            '/System/Library/Fonts/Supplemental',
        ]
    if os.name == 'nt':
        local = os.environ.get('LOCALAPPDATA', os.path.join(home, 'AppData', 'Local'))
        return [
            os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts'),
            os.path.join(local, 'Microsoft', 'Windows', 'Fonts'),
        ]
    return [
        os.path.join(home, '.fonts'),
        os.path.join(home, '.local', 'share', 'fonts'),
        '/usr/share/fonts',
        '/usr/local/share/fonts',
    ]


def _decode_name(raw, platform_id, encoding_id):
    """Name records are UTF-16BE on Windows/Unicode platforms, Latin-1 on Mac."""
    try:
        if platform_id == 3 or platform_id == 0:
            return raw.decode('utf-16-be', 'ignore').strip('\x00').strip()
        if platform_id == 1 and encoding_id == 0:
            return raw.decode('mac-roman', 'ignore').strip('\x00').strip()
        return raw.decode('utf-8', 'ignore').strip('\x00').strip()
    except Exception:
        return ''


def _read_name_table(data, offset=0):
    """Returns {nameID: value} for one sfnt font at `offset` inside `data`."""
    if offset + 12 > len(data):
        return {}
    num_tables = struct.unpack_from('>H', data, offset + 4)[0]
    name_off = name_len = 0
    for i in range(num_tables):
        rec = offset + 12 + i * 16
        if rec + 16 > len(data):
            return {}
        tag = data[rec:rec + 4]
        if tag == b'name':
            name_off, name_len = struct.unpack_from('>II', data, rec + 8)
            break
    if not name_off or name_off + 6 > len(data):
        return {}

    count, string_off = struct.unpack_from('>HH', data, name_off + 2)
    storage = name_off + string_off
    out = {}
    for i in range(count):
        rec = name_off + 6 + i * 12
        if rec + 12 > len(data):
            break
        platform_id, encoding_id, _lang, name_id, length, off = \
            struct.unpack_from('>HHHHHH', data, rec)
        start = storage + off
        if start + length > len(data):
            continue
        value = _decode_name(data[start:start + length], platform_id, encoding_id)
        # Prefer the first readable value we see for each ID.
        if value and name_id not in out:
            out[name_id] = value
    return out


def read_font_names(path):
    """
    Returns a list of {postscript, family, subfamily, full, index} — one entry
    per face, since .ttc/.otc collections pack several fonts into one file.
    """
    try:
        with open(path, 'rb') as fh:
            # The name table lives near the front; 4 MB covers every real font.
            data = fh.read(4 * 1024 * 1024)
    except OSError:
        return []

    if len(data) < 12:
        return []

    faces = []
    if data[:4] in (b'ttcf',):
        num_fonts = struct.unpack_from('>I', data, 8)[0]
        for i in range(min(num_fonts, 64)):
            off = struct.unpack_from('>I', data, 12 + i * 4)[0]
            names = _read_name_table(data, off)
            if names:
                faces.append((names, i))
    else:
        names = _read_name_table(data, 0)
        if names:
            faces.append((names, 0))

    out = []
    for names, index in faces:
        out.append({
            'postscript': names.get(NAME_POSTSCRIPT, ''),
            'family': names.get(NAME_TYPO_FAMILY) or names.get(NAME_FAMILY, ''),
            'subfamily': names.get(NAME_TYPO_SUBFAMILY) or names.get(NAME_SUBFAMILY, ''),
            'full': names.get(NAME_FULL, ''),
            'index': index,
        })
    return out


class FontIndex:
    """Lazily built, cached index of every installed font face."""

    def __init__(self):
        self._lock = threading.Lock()
        self._faces = None

    def _scan(self):
        faces = []
        seen = set()
        for directory in font_directories():
            if not os.path.isdir(directory):
                continue
            for root, _dirs, files in os.walk(directory):
                for filename in files:
                    if not filename.lower().endswith(FONT_EXTENSIONS):
                        continue
                    path = os.path.join(root, filename)
                    real = os.path.realpath(path)
                    if real in seen:
                        continue
                    seen.add(real)
                    for face in read_font_names(path):
                        face['path'] = path
                        faces.append(face)
        return faces

    def faces(self, refresh=False):
        with self._lock:
            if self._faces is None or refresh:
                self._faces = self._scan()
            return self._faces

    def resolve(self, name):
        """
        Finds the best face for a Premiere font name. Tries the PostScript name
        first, then the full name, then family+subfamily, then a bare family
        match so "Specsavers" still lands on Specsavers-Regular.
        """
        wanted = (name or '').strip()
        if not wanted:
            return None
        lower = wanted.lower()
        compact = lower.replace(' ', '').replace('-', '').replace('_', '')

        faces = self.faces()

        def compacted(value):
            return (value or '').lower().replace(' ', '').replace('-', '').replace('_', '')

        for key in ('postscript', 'full'):
            for face in faces:
                if compacted(face.get(key)) == compact:
                    return face

        for face in faces:
            joined = compacted(face.get('family')) + compacted(face.get('subfamily'))
            if joined == compact:
                return face

        # Bare family: prefer Regular so "Specsavers" is not an arbitrary weight.
        family_matches = [f for f in faces if compacted(f.get('family')) == compact]
        if family_matches:
            for face in family_matches:
                if (face.get('subfamily') or '').lower() in ('regular', 'book', ''):
                    return face
            return family_matches[0]

        return None
