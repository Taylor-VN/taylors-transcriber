/**
 * Premiere Pro Subtitle & Text Style Preset Parser
 *
 * Handles Premiere Pro (.prfpset / .prtextstyle) documents and JSON configs.
 * Premiere writes these as XML wrapped in <PremiereData>, sometimes gzipped and
 * sometimes with the interesting values buried in <Parameter Name="..."> nodes
 * or in attributes, so the lookup below sweeps tag names, Name= attributes and
 * finally the raw text before giving up.
 *
 * Style numbers are expressed against a 1080-pixel-tall reference frame; the
 * renderer scales them by project.height / 1080 so a preset looks the same in
 * 16:9, 1:1, 4:5 and 9:16.
 */

class PresetParser {
  constructor() {
    this.defaultPresets = {
      classic_yellow: {
        id: 'classic_yellow',
        name: 'Classic Film Yellow (Premiere Pro)',
        fontFamily: 'Inter',
        fontSize: 66,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffea00',
        enableStroke: true,
        strokeColor: '#000000',
        strokeWidth: 5,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 75,
        bgBoxPadding: 18,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 12,
        shadowOffsetY: 6,
        align: 'bottom-center',
        bottomMargin: 75,
        animationPreset: 'none'
      },
      tiktok_pop: {
        id: 'tiktok_pop',
        name: 'TikTok Pop (Bold Cyan Stroke)',
        fontFamily: 'Montserrat',
        fontSize: 72,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: true,
        fillColor: '#ffffff',
        enableStroke: true,
        strokeColor: '#00d2ff',
        strokeWidth: 7,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 80,
        bgBoxPadding: 15,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 15,
        shadowOffsetY: 9,
        align: 'bottom-center',
        bottomMargin: 90,
        animationPreset: 'pop'
      },
      netflix_clean: {
        id: 'netflix_clean',
        name: 'Netflix Clean (Bottom Center)',
        fontFamily: 'Inter',
        fontSize: 57,
        fontWeightBold: false,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffffff',
        enableStroke: true,
        strokeColor: '#000000',
        strokeWidth: 3,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 60,
        bgBoxPadding: 12,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 9,
        shadowOffsetY: 4,
        align: 'bottom-center',
        bottomMargin: 68,
        animationPreset: 'none'
      },
      cinematic_boxed: {
        id: 'cinematic_boxed',
        name: 'Cinematic Black Box',
        fontFamily: 'Roboto',
        fontSize: 60,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffffff',
        enableStroke: false,
        strokeColor: '#000000',
        strokeWidth: 0,
        enableBgBox: true,
        bgBoxColor: '#000000',
        bgBoxOpacity: 85,
        bgBoxPadding: 21,
        enableShadow: false,
        shadowColor: '#000000',
        shadowBlur: 0,
        shadowOffsetY: 0,
        align: 'bottom-center',
        bottomMargin: 83,
        animationPreset: 'fade'
      },
      cyber_neon: {
        id: 'cyber_neon',
        name: 'Cyber Neon Glow',
        fontFamily: 'Outfit',
        fontSize: 69,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: true,
        fillColor: '#00ffff',
        enableStroke: true,
        strokeColor: '#ff00ff',
        strokeWidth: 3,
        enableBgBox: false,
        bgBoxColor: '#121212',
        bgBoxOpacity: 90,
        bgBoxPadding: 15,
        enableShadow: true,
        shadowColor: '#00ffff',
        shadowBlur: 24,
        shadowOffsetY: 0,
        align: 'bottom-center',
        bottomMargin: 75,
        animationPreset: 'karaoke'
      },
      minimal_white: {
        id: 'minimal_white',
        name: 'Minimal White Shadow',
        fontFamily: 'Inter',
        fontSize: 54,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffffff',
        enableStroke: false,
        strokeColor: '#000000',
        strokeWidth: 0,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 50,
        bgBoxPadding: 9,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 15,
        shadowOffsetY: 6,
        align: 'bottom-center',
        bottomMargin: 60,
        animationPreset: 'none'
      }
    };
  }

  getPreset(id) {
    return this.defaultPresets[id] || this.defaultPresets['classic_yellow'];
  }

  listPresets() {
    return Object.values(this.defaultPresets);
  }

  addPreset(preset) {
    this.defaultPresets[preset.id] = preset;
    return preset;
  }

  /**
   * Parse an uploaded Premiere Pro preset.
   * @param {string} fileContent decoded text content
   * @param {string} fileName    original file name (used as the preset name)
   */
  parsePresetFile(fileContent, fileName) {
    const baseName = (fileName || 'Imported Preset').replace(/\.[^/.]+$/, '');
    try {
      const trimmed = (fileContent || '').trim();

      // JSON style config
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        if (!parsed.name) parsed.name = baseName;
        return this.normalizePreset(parsed, baseName);
      }

      if (!trimmed) throw new Error('Preset file is empty.');

      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(trimmed, 'text/xml');
      const parseError = xmlDoc.querySelector('parsererror');
      const doc = parseError ? null : xmlDoc;

      // A real Premiere .prtextstyle keeps none of its typography in the XML
      // tags — it is all in a base64 FlatBuffers blob. Try that first; the tag
      // sweep below only ever matches this app's own exported presets.
      const native = this.parsePremiereTextStyle(doc, trimmed, baseName);
      if (native) return native;

      const lookup = (names, fallback) => {
        const fromXml = doc ? this.findValue(doc, names) : null;
        if (fromXml !== null && fromXml !== undefined && fromXml !== '') return fromXml;
        const fromRaw = this.findValueInRawText(trimmed, names);
        return (fromRaw !== null && fromRaw !== '') ? fromRaw : fallback;
      };

      const fontSize = this.toNumber(lookup(
        ['FontSize', 'Size', 'TextSize', 'PointSize', 'fontSize'], null));
      const strokeWidth = this.toNumber(lookup(
        ['StrokeWidth', 'OutlineWidth', 'EdgeWidth', 'strokeWidth'], null));
      const fillColorRaw = lookup(['FillColor', 'TextColor', 'FontColor', 'Color', 'fillColor'], null);
      const strokeColorRaw = lookup(['StrokeColor', 'OutlineColor', 'EdgeColor', 'strokeColor'], null);
      const bgColorRaw = lookup(['BackgroundColor', 'BackgroundBoxColor', 'BackColor', 'bgBoxColor'], null);
      const shadowColorRaw = lookup(['ShadowColor', 'DropShadowColor', 'shadowColor'], null);

      const strokeEnabled = this.toBool(lookup(
        ['StrokeEnabled', 'OutlineEnabled', 'EnableStroke', 'enableStroke'], null));
      const bgEnabled = this.toBool(lookup(
        ['BackgroundBoxEnabled', 'BackgroundEnabled', 'EnableBackground', 'enableBgBox'], null));
      const shadowEnabled = this.toBool(lookup(
        ['ShadowEnabled', 'DropShadowEnabled', 'EnableShadow', 'enableShadow'], null));

      const preset = {
        name: lookup(['PresetName', 'StyleName', 'Name'], baseName) || baseName,
        fontFamily: lookup(['FontFamily', 'TextFont', 'FontName', 'Font', 'fontFamily'], 'Inter'),
        fontPostScriptName: lookup(['FontPostScriptName', 'PostScriptName', 'fontPostScriptName'], '') || '',
        letterSpacing: this.toNumber(lookup(['Tracking', 'LetterSpacing', 'letterSpacing'], null)) ?? 0,
        lineHeight: this.toNumber(lookup(['LineHeight', 'Leading', 'lineHeight'], null)) ?? 1.25,
        // Premiere point sizes are authored against a 1080-tall frame already.
        fontSize: fontSize !== null ? Math.round(fontSize) : 66,
        fontWeightBold: this.toBool(lookup(['Bold', 'FontBold', 'fontWeightBold'], null)) === true,
        fontStyleItalic: this.toBool(lookup(['Italic', 'FontItalic', 'fontStyleItalic'], null)) === true,
        textUppercase: this.toBool(lookup(['AllCaps', 'Uppercase', 'textUppercase'], null)) === true,
        fillColor: this.parseColorString(fillColorRaw) || '#ffea00',
        enableStroke: strokeEnabled !== null ? strokeEnabled : (!!strokeColorRaw || (strokeWidth || 0) > 0),
        strokeColor: this.parseColorString(strokeColorRaw) || '#000000',
        strokeWidth: strokeWidth !== null ? Math.round(strokeWidth) : 5,
        enableBgBox: bgEnabled !== null ? bgEnabled : !!bgColorRaw,
        bgBoxColor: this.parseColorString(bgColorRaw) || '#000000',
        bgBoxOpacity: this.toNumber(lookup(['BackgroundOpacity', 'BackgroundBoxOpacity', 'bgBoxOpacity'], null)) ?? 75,
        bgBoxPadding: this.toNumber(lookup(['BackgroundPadding', 'BackgroundBoxPadding', 'bgBoxPadding'], null)) ?? 18,
        enableShadow: shadowEnabled !== null ? shadowEnabled : !!shadowColorRaw,
        shadowColor: this.parseColorString(shadowColorRaw) || '#000000',
        shadowBlur: this.toNumber(lookup(['ShadowBlur', 'ShadowSoftness', 'shadowBlur'], null)) ?? 12,
        shadowOffsetY: this.toNumber(lookup(['ShadowOffsetY', 'ShadowDistance', 'shadowOffsetY'], null)) ?? 6,
        align: this.normalizeAlign(lookup(['Alignment', 'Align', 'TextAlignment', 'align'], null)),
        bottomMargin: this.toNumber(lookup(['BottomMargin', 'SafeMargin', 'bottomMargin'], null)) ?? 75,
        offsetX: this.toNumber(lookup(['PositionX', 'OffsetX', 'offsetX'], null)) ?? 0,
        offsetY: this.toNumber(lookup(['PositionY', 'OffsetY', 'offsetY'], null)) ?? 0,
        animationPreset: lookup(['Animation', 'AnimationPreset', 'animationPreset'], 'none')
      };

      return this.normalizePreset(preset, baseName);
    } catch (e) {
      console.warn('Failed XML/JSON parse for preset, falling back to default:', e);
      return { ...this.defaultPresets['classic_yellow'], name: baseName + ' (unreadable — defaults used)' };
    }
  }

  /**
   * Decodes a genuine Premiere Pro .prtextstyle.
   *
   * Returns null when the document is not one, so the caller can fall back to
   * the generic tag sweep. Fields Premiere does not store — animation, and the
   * shadow's angle and opacity, which this app's single vertical offset cannot
   * express — keep this app's defaults rather than being invented.
   */
  parsePremiereTextStyle(doc, rawText, baseName) {
    if (typeof PremiereStyleDecoder === 'undefined') return null;

    const b64 = PremiereStyleDecoder.findSourceTextBase64(doc)
      || PremiereStyleDecoder.findSourceTextBase64InRaw(rawText);
    if (!b64) return null;

    let decoded;
    try {
      decoded = PremiereStyleDecoder.decodeSourceText(b64);
    } catch (e) {
      console.warn('Premiere Source Text blob could not be decoded:', e);
      return null;
    }

    const run = (decoded.runs || [])[0] || {};
    const style = run.style || {};
    const para = decoded.paragraph || {};
    const shadow = para.shadow || {};
    const background = para.background || {};
    const fontName = style.font || (decoded.fonts || [])[0] || '';
    const styleName = PremiereStyleDecoder.readStyleName(doc);
    const transform = PremiereStyleDecoder.readTransform(doc);

    const base = { ...this.defaultPresets['netflix_clean'] };
    const fontSize = style.fontSize > 0 ? Math.round(style.fontSize) : base.fontSize;

    const preset = {
      ...base,
      id: 'premiere_' + Date.now(),
      name: styleName || baseName,

      // The PostScript name is what Premiere means; the font loader turns it
      // into something canvas can draw, so keep it verbatim.
      fontFamily: fontName || base.fontFamily,
      fontPostScriptName: fontName || '',
      // Weight and slant normally live in the face itself ("…-Bold"), so only
      // Premiere's faux flags — the ones that really do synthesise a style —
      // set these.
      fontWeightBold: !!style.fauxBold,
      fontStyleItalic: !!style.fauxItalic,
      textUppercase: style.capsOption === 2,

      fontSize,
      letterSpacing: Math.round(style.tracking || 0),
      lineHeight: this.lineHeightFromLeading(para.leading, fontSize),

      fillColor: style.fillColor || '#ffffff',
      enableStroke: !!style.strokeVisible && (style.strokeWidth || 0) > 0,
      strokeColor: style.strokeColor || '#000000',
      strokeWidth: style.strokeWidth > 0 ? style.strokeWidth : 0,

      enableShadow: !!shadow.visible,
      shadowColor: shadow.color || '#000000',
      shadowBlur: Math.round(shadow.blur || 0),
      // Premiere throws the shadow at an angle; this app only offsets it
      // downwards, so the distance is kept and the angle dropped.
      shadowOffsetY: Math.round(shadow.distance || 0),

      enableBgBox: !!background.visible,
      bgBoxColor: background.color || '#000000',
      bgBoxOpacity: Math.round(background.opacity !== undefined ? background.opacity : 100),
      bgBoxPadding: Math.round(background.size || 0),

      // Premiere positions text by a normalised anchor rather than a margin.
      ...this.alignmentFromTransform(transform, para.align),

      // Everything the blob carries, kept so an operator can see exactly what
      // was in the file and so the remaining fields can be mapped later.
      premiere: {
        fonts: decoded.fonts,
        paragraph: para,
        transform,
        runs: decoded.runs
      }
    };

    return this.normalizePreset(preset, baseName);
  }

  /**
   * Premiere's Leading is points added to the font's auto leading (120% of the
   * size), and can be negative. This app stores a multiple of the font size.
   */
  lineHeightFromLeading(leading, fontSize) {
    const AUTO = 1.2;
    if (!leading || !fontSize) return AUTO;
    // Snapped to the 0.05 the line-height slider steps in, so the control and
    // the render agree about what was imported.
    return Math.max(0.5, Math.round((AUTO + leading / fontSize) * 20) / 20);
  }

  /**
   * Converts Premiere's normalised Position (0..1 of frame) and paragraph
   * justification into this app's align + margin model.
   */
  alignmentFromTransform(transform, justify) {
    const horizontal = typeof PremiereStyleDecoder !== 'undefined'
      ? PremiereStyleDecoder.horizontalAlign(justify)
      : 'center';

    const pos = transform && transform['Position'];
    const y = pos && /:/.test(pos) ? parseFloat(pos.split(':')[1]) : NaN;

    // A .prtextstyle carries no layout — every file Premiere writes pins
    // Position to 0.5:0.5 and Anchor Point to 0:0 no matter where the caption
    // it was saved from actually sat, so the zone and the Position pair the
    // Essential Graphics panel shows have to be dialled in by hand (the
    // Offset X / Y fields under the position grid take Premiere's own
    // numbers). Anything but a decisively placed graphic therefore keeps this
    // app's bottom-of-frame caption default instead of jumping to the middle.
    if (isNaN(y) || (y > 0.34 && y < 0.66)) {
      return { align: 'bottom-' + horizontal };
    }

    // Margin is expressed against the 1080-tall reference frame the renderer
    // scales from, measured to the text block's centre.
    if (y <= 0.34) return { align: 'top-' + horizontal, bottomMargin: Math.round(y * 1080) };
    return { align: 'bottom-' + horizontal, bottomMargin: Math.round((1 - y) * 1080) };
  }

  /** Search the document for a tag, a Name="..." parameter node, or an attribute. */
  findValue(doc, names) {
    const all = doc.getElementsByTagName('*');

    // Names are tried in the order given, and each name is tried by tag first,
    // then by Parameter Name=, then by a same-named attribute. Sweeping all
    // three at once meant a generic candidate like "Name" or "Color" matched
    // the first unrelated node in the document and won over an exact tag.
    for (const name of names) {
      const w = name.toLowerCase();

      for (let i = 0; i < all.length; i++) {
        const tag = (all[i].localName || all[i].nodeName || '').toLowerCase();
        if (tag === w) {
          const direct = this.elementValue(all[i]);
          if (direct) return direct;
        }
      }

      // <Parameter Name="FontSize"><Value>72</Value></Parameter>
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const nameAttr = (el.getAttribute('Name') || el.getAttribute('name') || '').toLowerCase();
        if (nameAttr !== w) continue;
        const valueAttr = el.getAttribute('Value') || el.getAttribute('value');
        if (valueAttr && valueAttr.trim()) return valueAttr.trim();
        const direct = this.elementValue(el);
        if (direct) return direct;
      }

      for (let i = 0; i < all.length; i++) {
        for (const attr of all[i].attributes || []) {
          if (attr.name.toLowerCase() === w && attr.value.trim()) return attr.value.trim();
        }
      }
    }
    return null;
  }

  elementValue(el) {
    const child = el.querySelector && el.querySelector('Value, value');
    if (child && child.textContent.trim()) return child.textContent.trim();
    const text = (el.textContent || '').trim();
    // Ignore container nodes whose text is just the concatenation of children.
    if (text && el.children.length === 0) return text;
    return null;
  }

  /** Last resort for binary-ish .prtextstyle payloads: scan the raw bytes as text. */
  findValueInRawText(raw, names) {
    for (const name of names) {
      const patterns = [
        new RegExp(`<${name}[^>]*>([^<]{1,120})</${name}>`, 'i'),
        new RegExp(`["']${name}["']\\s*[:=]\\s*["']?([^,"'}\\s<]{1,120})`, 'i'),
        new RegExp(`${name}\\s*=\\s*["']([^"']{1,120})["']`, 'i')
      ];
      for (const re of patterns) {
        const m = raw.match(re);
        if (m && m[1] && m[1].trim()) return m[1].trim();
      }
    }
    return null;
  }

  toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = parseFloat(String(value).replace(/[^0-9.+-]/g, ''));
    return isNaN(n) ? null : n;
  }

  toBool(value) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(s)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(s)) return false;
    return null;
  }

  normalizeAlign(value) {
    if (!value) return 'bottom-center';
    const s = String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
    const valid = [
      'top-left', 'top-center', 'top-right',
      'center-left', 'center', 'center-right',
      'bottom-left', 'bottom-center', 'bottom-right'
    ];
    if (valid.includes(s)) return s;
    // Premiere sometimes stores just "Center" / "Left" / "Bottom"
    if (s === 'left') return 'bottom-left';
    if (s === 'right') return 'bottom-right';
    if (s === 'bottom' || s === 'centre') return 'bottom-center';
    if (s === 'top') return 'top-center';
    if (s === 'middle') return 'center';
    return 'bottom-center';
  }

  /**
   * Accepts #rrggbb, 0xRRGGBB, "r,g,b", "r g b a", Premiere floats
   * ("1.0 0.92 0.0"), and packed ARGB integers.
   */
  parseColorString(colorStr) {
    if (colorStr === null || colorStr === undefined) return null;
    let s = String(colorStr).trim();
    if (!s) return null;

    if (/^#[0-9a-f]{3}$/i.test(s)) {
      return '#' + s.slice(1).split('').map(c => c + c).join('');
    }
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{8}$/i.test(s)) return '#' + s.slice(3).toLowerCase(); // #aarrggbb
    if (/^0x[0-9a-f]{6}$/i.test(s)) return '#' + s.slice(2).toLowerCase();
    if (/^0x[0-9a-f]{8}$/i.test(s)) return '#' + s.slice(4).toLowerCase();

    const parts = s.split(/[\s,]+/).map(p => parseFloat(p)).filter(n => !isNaN(n));
    if (parts.length >= 3) {
      // Premiere writes normalised floats. Detect them by the notation rather
      // than by value: "1.0 1.0 1.0" is white, but treating it as bytes gives
      // #010101, which is why pure colours used to import as near-black.
      const written = s.split(/[\s,]+/).filter(t => t !== '');
      const looksDecimal = written.slice(0, 3).some(t => /\./.test(t));
      const inUnitRange = parts.slice(0, 3).every(n => n >= 0 && n <= 1);
      const isFloat = inUnitRange && (looksDecimal || parts.slice(0, 3).every(n => n === 0 || n === 1));
      // Four byte channels are alpha-first in Premiere's own writing, so a
      // leading 255 is opacity rather than the red channel.
      const chans = parts.length >= 4 && !isFloat
        ? parts.slice(1, 4)   // ARGB byte order
        : parts.slice(0, 3);
      const toHex = (n) => {
        const v = Math.round(isFloat ? n * 255 : n);
        return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
      };
      return '#' + chans.map(toHex).join('');
    }

    // Packed ARGB integer (e.g. 4294958336 = 0xFFFFDD00 -> #ffdd00)
    if (/^\d+$/.test(s)) {
      const num = parseInt(s, 10);
      if (num > 0xFFFFFF) return '#' + (num & 0xFFFFFF).toString(16).padStart(6, '0');
      return '#' + num.toString(16).padStart(6, '0');
    }

    return null;
  }

  normalizePreset(presetObj, nameFallback) {
    const num = (v, d) => {
      const n = this.toNumber(v);
      return n === null ? d : n;
    };
    return {
      id: presetObj.id || 'custom_' + Date.now(),
      name: presetObj.name || nameFallback || 'Imported Premiere Preset',
      fontFamily: presetObj.fontFamily || 'Inter',
      // Premiere names the exact face; kept alongside the family so the font
      // loader can ask for it by the name the file actually used.
      fontPostScriptName: presetObj.fontPostScriptName || '',
      fontSize: num(presetObj.fontSize, 66),
      // Tracking is in 1/1000 em, matching Premiere's own units. Leading is a
      // multiple of the font size; 0 means "use the font's natural line height".
      letterSpacing: num(presetObj.letterSpacing, 0),
      lineHeight: num(presetObj.lineHeight, 1.25),
      fontWeightBold: presetObj.fontWeightBold !== undefined ? !!presetObj.fontWeightBold : true,
      fontStyleItalic: !!presetObj.fontStyleItalic,
      textUppercase: !!presetObj.textUppercase,
      fillColor: this.parseColorString(presetObj.fillColor) || '#ffea00',
      enableStroke: presetObj.enableStroke !== undefined ? !!presetObj.enableStroke : true,
      strokeColor: this.parseColorString(presetObj.strokeColor) || '#000000',
      strokeWidth: num(presetObj.strokeWidth, 5),
      enableBgBox: !!presetObj.enableBgBox,
      bgBoxColor: this.parseColorString(presetObj.bgBoxColor) || '#000000',
      bgBoxOpacity: num(presetObj.bgBoxOpacity, 75),
      bgBoxPadding: num(presetObj.bgBoxPadding, 18),
      enableShadow: presetObj.enableShadow !== undefined ? !!presetObj.enableShadow : true,
      shadowColor: this.parseColorString(presetObj.shadowColor) || '#000000',
      shadowBlur: num(presetObj.shadowBlur, 12),
      shadowOffsetY: num(presetObj.shadowOffsetY, 6),
      align: this.normalizeAlign(presetObj.align),
      bottomMargin: num(presetObj.bottomMargin, 75),
      // Premiere's Position pair, in the same 1080-tall reference pixels the
      // rest of the style is authored against. Positive Y is down.
      offsetX: num(presetObj.offsetX, 0),
      offsetY: num(presetObj.offsetY, 0),
      animationPreset: ['none', 'fade', 'pop', 'karaoke'].includes(presetObj.animationPreset)
        ? presetObj.animationPreset : 'none',
      premiere: presetObj.premiere || null
    };
  }

  exportPresetToXml(preset) {
    const esc = (v) => String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    return `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
  <TextPreset Name="${esc(preset.name)}">
    <PresetName>${esc(preset.name)}</PresetName>
    <FontFamily>${esc(preset.fontFamily)}</FontFamily>
    <FontPostScriptName>${esc(preset.fontPostScriptName || '')}</FontPostScriptName>
    <FontSize>${esc(preset.fontSize)}</FontSize>
    <Tracking>${esc(preset.letterSpacing || 0)}</Tracking>
    <LineHeight>${esc(preset.lineHeight !== undefined ? preset.lineHeight : 1.25)}</LineHeight>
    <Bold>${esc(!!preset.fontWeightBold)}</Bold>
    <Italic>${esc(!!preset.fontStyleItalic)}</Italic>
    <AllCaps>${esc(!!preset.textUppercase)}</AllCaps>
    <FillColor>${esc(preset.fillColor)}</FillColor>
    <StrokeEnabled>${esc(!!preset.enableStroke)}</StrokeEnabled>
    <StrokeColor>${esc(preset.strokeColor)}</StrokeColor>
    <StrokeWidth>${esc(preset.strokeWidth)}</StrokeWidth>
    <BackgroundBoxEnabled>${esc(!!preset.enableBgBox)}</BackgroundBoxEnabled>
    <BackgroundBoxColor>${esc(preset.bgBoxColor)}</BackgroundBoxColor>
    <BackgroundBoxOpacity>${esc(preset.bgBoxOpacity)}</BackgroundBoxOpacity>
    <BackgroundBoxPadding>${esc(preset.bgBoxPadding)}</BackgroundBoxPadding>
    <ShadowEnabled>${esc(!!preset.enableShadow)}</ShadowEnabled>
    <ShadowColor>${esc(preset.shadowColor)}</ShadowColor>
    <ShadowBlur>${esc(preset.shadowBlur)}</ShadowBlur>
    <ShadowOffsetY>${esc(preset.shadowOffsetY)}</ShadowOffsetY>
    <Alignment>${esc(preset.align)}</Alignment>
    <BottomMargin>${esc(preset.bottomMargin)}</BottomMargin>
    <PositionX>${esc(preset.offsetX || 0)}</PositionX>
    <PositionY>${esc(preset.offsetY || 0)}</PositionY>
    <AnimationPreset>${esc(preset.animationPreset)}</AnimationPreset>
  </TextPreset>
</PremiereData>`;
  }
}

window.PresetParser = PresetParser;
