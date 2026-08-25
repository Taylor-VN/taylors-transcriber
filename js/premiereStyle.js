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
 * Field numbers below were mapped by walking the vtables of a real Premiere
 * export. Anything not positively identified is returned under `raw` rather than
 * guessed at, so a caller can see exactly what was in the file.
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

/* Field numbers observed in the paragraph (root style) table. */
const PARA = {
  RUNS: 0,        // vector<Run>
  FONTS: 1,       // vector<string> — PostScript font names
  COLOR_A: 10,    // colour table
  COLOR_B: 17,    // colour table
  NUM_12: 12, NUM_14: 14, NUM_15: 15, NUM_16: 16, NUM_19: 19, NUM_20: 20,
  FLAG_18: 18, FLAG_26: 26, FLAG_43: 43, FLAG_44: 44,
  ENUM_4: 4, ENUM_5: 5
};

/* Field numbers observed in the per-run character-format table. */
const CHAR = {
  FONT_SIZE: 1,     // float, points
  STROKE_WIDTH: 6,  // float
  TABLE_21: 21,
  TABLE_23: 23,
  ENUM_24: 24
};

/** Colour sub-table: three ubyte channels, absent meaning 0. */
function readColor(fb, table) {
  if (!table) return null;
  const r = fb.byte(table, 0, 0);
  const g = fb.byte(table, 1, 0);
  const b = fb.byte(table, 2, 0);
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
      const fmtOff = fb.fieldOffset(runTable, 1);
      const fmt = fmtOff ? fb.indirect(runTable, 1) : 0;
      return {
        text,
        fontSize: fmt ? fb.float(fmt, CHAR.FONT_SIZE, 0) : 0,
        strokeWidth: fmt ? fb.float(fmt, CHAR.STROKE_WIDTH, 0) : 0,
        // These two are present-but-empty in every sample seen so far; an empty
        // table means "all schema defaults", not "absent".
        hasTable21: fmt ? fb.has(fmt, CHAR.TABLE_21) : false,
        hasTable23: fmt ? fb.has(fmt, CHAR.TABLE_23) : false,
        raw: fmt ? fb.describe(fmt) : {}
      };
    });

    const colorA = fb.has(para, PARA.COLOR_A) ? readColor(fb, fb.indirect(para, PARA.COLOR_A)) : null;
    const colorB = fb.has(para, PARA.COLOR_B) ? readColor(fb, fb.indirect(para, PARA.COLOR_B)) : null;

    return {
      fonts,
      runs,
      colors: { a: colorA, b: colorB },
      numbers: {
        n12: fb.float(para, PARA.NUM_12, 0),
        n14: fb.float(para, PARA.NUM_14, 0),
        n15: fb.float(para, PARA.NUM_15, 0),
        n16: fb.float(para, PARA.NUM_16, 0),
        n19: fb.float(para, PARA.NUM_19, 0),
        n20: fb.float(para, PARA.NUM_20, 0)
      },
      flags: {
        f18: fb.bool(para, PARA.FLAG_18),
        f26: fb.bool(para, PARA.FLAG_26),
        f43: fb.bool(para, PARA.FLAG_43),
        f44: fb.bool(para, PARA.FLAG_44),
        e4: fb.byte(para, PARA.ENUM_4, 0),
        e5: fb.byte(para, PARA.ENUM_5, 0)
      },
      raw: fb.describe(para)
    };
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
