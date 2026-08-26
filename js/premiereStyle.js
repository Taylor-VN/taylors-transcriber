/**
 * Premiere Pro .prtextstyle decoder.
 *
 * A .prtextstyle is a plain-XML <PremiereData> project skeleton, but none of the
 * typography lives in the XML tags. Everything the Essential Graphics panel calls
 * "appearance" is packed into a single base64 blob:
 *
 *   <ArbVideoComponentParam ...>
 *     <Name>Source Text</Name>
 *     <StartKeyframeValue Encoding="base64">lAEAAAAAAABEMyIR...</StartKeyframeValue>
 *   </ArbVideoComponentParam>
 *
 * Decoded, that blob is:
 *
 *   [0..7]   uint64 little-endian payload length
 *   [8..11]  magic 0x11223344
 *   [12..]   a standard FlatBuffers buffer (root uoffset first)
 *
 * The transform — position, scale, rotation, opacity — stays in the readable XML
 * as sibling <VideoComponentParam> / <PointComponentParam> nodes keyed by <Name>,
 * with the value as field 1 of the <StartKeyframe> CSV.
 *
 * The FlatBuffers table is Premiere's ATE "text param". Its field names — in
 * declaration order — are still in the Premiere binary, left over from the older
 * JSON form of the same object that CC2019 motion graphics templates were saved
 * in:
 *
 *   mWidth, mHeight, mAlignment, mVerticalAlignment, mLeading, mTabWidth,
 *   … mShadowColor, mShadowVisible, mShadowOpacity, mShadowAngle, mShadowOffset,
 *   mShadowSize, mShadowBlur, mBackFillColor, mBackFillVisible,
 *   mBackFillOpacity, mBackFillSize, …
 *
 * and per run: mFontName, mFontSize, mFillColor, mFillVisible, mStrokeColor,
 * mStrokeVisible, mStrokeWidth, mKerning, mTracking, … mCapsOption,
 * mBaselineOption, mFauxBold, mFauxItalic.
 *
 * The field numbers below line those names up against the vtables of real
 * Premiere exports. Anything not positively identified is returned under `raw`
 * rather than guessed at, so a caller can see exactly what was in the file.
 */

/** Minimal little-endian FlatBuffers reader — just the accessors we need. */
class FlatBufferReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(o) { return this.view.getUint8(o); }
  u16(o) { return this.view.getUint16(o, true); }
  i32(o) { return this.view.getInt32(o, true); }
  u32(o) { return this.view.getUint32(o, true); }
  f32(o) { return this.view.getFloat32(o, true); }

  /** Absolute position of a table's vtable. */
  vtable(table) { return table - this.i32(table); }

  /**
   * Byte offset of `field` within `table`, or 0 when the field is absent.
   * Absent means "use the schema default", which for Premiere is 0 / false.
   */
  fieldOffset(table, field) {
    const vt = this.vtable(table);
    const vtSize = this.u16(vt);
    const slot = 4 + field * 2;
    if (slot >= vtSize) return 0;
    return this.u16(vt + slot);
  }

  has(table, field) { return this.fieldOffset(table, field) !== 0; }

  /** Bytes the table actually reserves for a field — guards short trailing fields. */
  fieldRoom(table, field) {
    const off = this.fieldOffset(table, field);
    if (!off) return 0;
    return this.u16(this.vtable(table) + 2) - off;
  }

  float(table, field, dflt = 0) {
    const off = this.fieldOffset(table, field);
    if (!off || this.fieldRoom(table, field) < 4) return dflt;
    return this.f32(table + off);
  }

  int(table, field, dflt = 0) {
    const off = this.fieldOffset(table, field);
    if (!off || this.fieldRoom(table, field) < 4) return dflt;
    return this.i32(table + off);
  }

  byte(table, field, dflt = 0) {
    const off = this.fieldOffset(table, field);
    if (!off) return dflt;
    return this.u8(table + off);
  }

  bool(table, field, dflt = false) {
    const off = this.fieldOffset(table, field);
    if (!off) return dflt;
    return this.u8(table + off) !== 0;
  }

  /** Follow an indirect (uoffset) field to the absolute position it points at. */
  indirect(table, field) {
    const off = this.fieldOffset(table, field);
    if (!off) return 0;
    const p = table + off;
    return p + this.u32(p);
  }

  string(table, field) {
    const p = this.indirect(table, field);
    if (!p) return null;
    const len = this.u32(p);
    if (len > this.bytes.length - p - 4) return null;
    return new TextDecoder('utf-8').decode(this.bytes.subarray(p + 4, p + 4 + len));
  }

  /** Returns the absolute positions of every element of a vector-of-offsets. */
  vector(table, field) {
    const p = this.indirect(table, field);
    if (!p) return [];
    const count = this.u32(p);
    const out = [];
    for (let i = 0; i < count; i++) {
      const eo = p + 4 + i * 4;
      out.push(eo + this.u32(eo));
    }
    return out;
  }

  /** Reads a string sitting at an absolute position (vector elements). */
  stringAt(p) {
    const len = this.u32(p);
    if (len > this.bytes.length - p - 4) return null;
    return new TextDecoder('utf-8').decode(this.bytes.subarray(p + 4, p + 4 + len));
  }

  /** Every present field of a table, for diagnostics and unmapped values. */
  describe(table) {
    const vt = this.vtable(table);
    const vtSize = this.u16(vt);
    const tblSize = this.u16(vt + 2);
    const out = {};
    for (let f = 0; f < (vtSize - 4) / 2; f++) {
      const off = this.u16(vt + 4 + f * 2);
      if (!off) continue;
      const room = tblSize - off;
      const entry = { offset: off, u8: this.u8(table + off) };
      if (room >= 4) {
        entry.u32 = this.u32(table + off);
        entry.f32 = this.f32(table + off);
      }
      out['f' + f] = entry;
    }
    return out;
  }
}

/* Field numbers of the paragraph (text param) table. */
const PARA = {
  RUNS: 0,           // vector<Run> — mTextRuns, hoisted to the front
  FONTS: 1,          // vector<string> — the PostScript names runs index into
  ALIGN: 4,          // mAlignment, an ATE justification enum
  VALIGN: 5,         // mVerticalAlignment
  LEADING: 6,        // mLeading, points added to the font's auto leading
  SHADOW_COLOR: 10,
  SHADOW_VISIBLE: 11,
  SHADOW_OPACITY: 12,  // percent
  SHADOW_ANGLE: 13,    // degrees
  SHADOW_OFFSET: 14,   // points — Premiere calls this Distance
  SHADOW_SIZE: 15,
  SHADOW_BLUR: 16,
  BACK_COLOR: 17,      // the "Background" box behind the text
  BACK_VISIBLE: 18,
  BACK_OPACITY: 19,    // percent
  BACK_SIZE: 20        // points the box is grown by on every side
};

/* Field numbers of the per-run character style table. */
const STYLE = {
  FONT: 0,           // index into the paragraph's font vector
  SIZE: 1,           // float, points
  FILL_COLOR: 2,
  FILL_VISIBLE: 3,
  STROKE_COLOR: 4,
  STROKE_VISIBLE: 5,
  STROKE_WIDTH: 6,   // float, points drawn outside the glyph
  KERNING: 7,
  TRACKING: 8,       // 1/1000 em, the number Premiere's Tracking field shows
  CAPS: 12,          // mCapsOption: 0 none, 1 small caps, 2 all caps
  FAUX_BOLD: 14,
  FAUX_ITALIC: 15
};

/* ATE justification enum, as stored in mAlignment. */
const JUSTIFY = { LEFT: 0, RIGHT: 1, CENTER: 2, FULL_LEFT: 3, FULL_RIGHT: 4, FULL_CENTER: 5 };

/**
 * Colour sub-table: three ubyte channels whose schema default is 255.
 *
 * That default is why black arrives as three explicit zeros while white — the
 * Premiere default for both fill and stroke — arrives as an empty table, or as
 * no table at all. Reading absent channels as 0 turned every imported caption
 * black.
 */
function readColor(fb, table) {
  if (!table) return null;
  const r = fb.byte(table, 0, 255);
  const g = fb.byte(table, 1, 255);
  const b = fb.byte(table, 2, 255);
  const hex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

class PremiereStyleDecoder {
  static MAGIC = 0x11223344;

  /** Strips the 8-byte length prefix and magic, returning the FlatBuffers root. */
  static openBlob(bytes) {
    if (bytes.length < 16) throw new Error('Source Text blob is too short.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(8, true);
    if (magic !== PremiereStyleDecoder.MAGIC) {
      throw new Error('Unexpected Source Text magic 0x' + magic.toString(16));
    }
    // The FlatBuffers buffer starts after length+magic; every uoffset inside it
    // is relative to that point, so slice rather than carry a base around.
    const fb = new FlatBufferReader(bytes.subarray(12));
    const root = fb.u32(0);
    return { fb, root };
  }

  /** Decodes the base64 Source Text payload into fonts, runs and paragraph values. */
  static decodeSourceText(base64) {
    const clean = String(base64 || '').replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const { fb, root } = PremiereStyleDecoder.openBlob(bytes);

    // The root table wraps the real paragraph table in its first field.
    const para = fb.has(root, 0) ? fb.indirect(root, 0) : root;

    const fonts = fb.vector(para, PARA.FONTS)
      .map(p => fb.stringAt(p))
      .filter(Boolean);

    const runs = fb.vector(para, PARA.RUNS).map(runTable => {
      const text = fb.string(runTable, 0);
      const st = fb.has(runTable, 1) ? fb.indirect(runTable, 1) : 0;
      if (!st) return { text, style: null };
      const fontIndex = fb.int(st, STYLE.FONT, 0);
      return {
        text,
        style: {
          font: fonts[fontIndex] || fonts[0] || null,
          fontIndex,
          fontSize: fb.float(st, STYLE.SIZE, 0),
          // Absent colour tables are Premiere's defaults: white fill, white
          // stroke. Absent visibility flags mean the fill is drawn and the
          // stroke is not.
          fillColor: readColor(fb, fb.indirect(st, STYLE.FILL_COLOR)) || '#ffffff',
          fillVisible: fb.bool(st, STYLE.FILL_VISIBLE, true),
          strokeColor: readColor(fb, fb.indirect(st, STYLE.STROKE_COLOR)) || '#ffffff',
          strokeVisible: fb.bool(st, STYLE.STROKE_VISIBLE, false),
          strokeWidth: fb.float(st, STYLE.STROKE_WIDTH, 0),
          tracking: fb.float(st, STYLE.TRACKING, 0),
          kerning: fb.float(st, STYLE.KERNING, 0),
          capsOption: fb.int(st, STYLE.CAPS, 0),
          fauxBold: fb.bool(st, STYLE.FAUX_BOLD, false),
          fauxItalic: fb.bool(st, STYLE.FAUX_ITALIC, false)
        },
        raw: fb.describe(st)
      };
    });

    const paragraph = {
      align: fb.int(para, PARA.ALIGN, JUSTIFY.CENTER),
      verticalAlign: fb.int(para, PARA.VALIGN, 0),
      // Premiere's Leading field is a delta on the font's auto leading, so 0
      // (and an absent field) means "auto", not "no line height".
      leading: fb.float(para, PARA.LEADING, 0),
      shadow: {
        visible: fb.bool(para, PARA.SHADOW_VISIBLE, false),
        color: readColor(fb, fb.indirect(para, PARA.SHADOW_COLOR)) || '#000000',
        opacity: fb.float(para, PARA.SHADOW_OPACITY, 100),
        angle: fb.float(para, PARA.SHADOW_ANGLE, 0),
        distance: fb.float(para, PARA.SHADOW_OFFSET, 0),
        size: fb.float(para, PARA.SHADOW_SIZE, 0),
        blur: fb.float(para, PARA.SHADOW_BLUR, 0)
      },
      background: {
        visible: fb.bool(para, PARA.BACK_VISIBLE, false),
        color: readColor(fb, fb.indirect(para, PARA.BACK_COLOR)) || '#000000',
        opacity: fb.float(para, PARA.BACK_OPACITY, 100),
        size: fb.float(para, PARA.BACK_SIZE, 0)
      }
    };

    return { fonts, runs, paragraph, raw: fb.describe(para) };
  }

  /** Maps an ATE justification enum onto this app's horizontal alignment. */
  static horizontalAlign(justify) {
    if (justify === JUSTIFY.LEFT || justify === JUSTIFY.FULL_LEFT) return 'left';
    if (justify === JUSTIFY.RIGHT || justify === JUSTIFY.FULL_RIGHT) return 'right';
    return 'center';
  }

  /**
   * Pulls the transform params, which Premiere leaves as readable XML.
   * Values are field 1 of the StartKeyframe CSV; points use "x:y".
   */
  static readTransform(doc) {
    const out = {};
    if (!doc) return out;
    const params = doc.getElementsByTagName('*');
    for (let i = 0; i < params.length; i++) {
      const el = params[i];
      if (!/ComponentParam$/.test(el.localName || el.nodeName || '')) continue;
      const nameEl = el.getElementsByTagName('Name')[0];
      const kfEl = el.getElementsByTagName('StartKeyframe')[0];
      if (!nameEl || !kfEl) continue;
      const name = (nameEl.textContent || '').trim();
      if (!name) continue;
      const parts = (kfEl.textContent || '').split(',');
      if (parts.length < 2) continue;
      out[name] = parts[1].trim();
    }
    return out;
  }

  /** The user-facing style name, which lives on the StyleProjectItem. */
  static readStyleName(doc) {
    if (!doc) return null;
    const items = doc.getElementsByTagName('StyleProjectItem');
    for (let i = 0; i < items.length; i++) {
      const names = items[i].getElementsByTagName('Name');
      for (let j = 0; j < names.length; j++) {
        const t = (names[j].textContent || '').trim();
        if (t) return t;
      }
    }
    return null;
  }

  /** Finds the base64 Source Text payload in a parsed .prtextstyle document. */
  static findSourceTextBase64(doc) {
    if (!doc) return null;
    const params = doc.getElementsByTagName('ArbVideoComponentParam');
    for (let i = 0; i < params.length; i++) {
      const nameEl = params[i].getElementsByTagName('Name')[0];
      const name = nameEl ? (nameEl.textContent || '').trim() : '';
      const valEl = params[i].getElementsByTagName('StartKeyframeValue')[0];
      if (!valEl) continue;
      if (name && name !== 'Source Text') continue;
      const enc = (valEl.getAttribute('Encoding') || '').toLowerCase();
      if (enc && enc !== 'base64') continue;
      const text = (valEl.textContent || '').trim();
      if (text) return text;
    }
    return null;
  }

  /** Regex fallback for documents DOMParser rejects. */
  static findSourceTextBase64InRaw(raw) {
    const m = String(raw || '').match(
      /<StartKeyframeValue[^>]*Encoding="base64"[^>]*>([\s\S]*?)<\/StartKeyframeValue>/i);
    return m ? m[1].trim() : null;
  }
}

if (typeof window !== 'undefined') {
  window.FlatBufferReader = FlatBufferReader;
  window.PremiereStyleDecoder = PremiereStyleDecoder;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FlatBufferReader, PremiereStyleDecoder };
}
