/**
 * Safe-area guide sets.
 *
 * Two different things are drawn, and they are not the same kind of claim:
 *
 *   safe   — the rectangle to keep text inside. Outside it, a band is tinted.
 *   avoid  — a region the platform's own interface sits on top of, so anything
 *            drawn there is covered rather than merely cropped.
 *
 * Every measurement is stored as a fraction of the frame, converted from the
 * platform's published pixel figures on their reference canvas (1080x1920 for
 * the vertical apps). Two provenances are mixed here and the `source` field
 * says which is which:
 *
 *   'spec'      the broadcaster or platform publishes these numbers.
 *   'practical' measured from the current interface. Interfaces move; treat
 *               these as a guide and re-check when an app redesigns.
 *
 * A set is offered only for the ratios in `ratios` — TikTok's zones mean
 * nothing on a 16:9 frame, and offering them there invites a wrong answer.
 */

const V_W = 1080;   // reference vertical canvas the published figures use
const V_H = 1920;

/** Published pixel insets on 1080x1920 -> fractions of the frame. */
function vertical(top, right, bottom, left) {
  return { top: top / V_H, right: right / V_W, bottom: bottom / V_H, left: left / V_W };
}

const SAFE_AREA_SETS = {
  none: {
    id: 'none',
    label: 'None',
    ratios: ['16x9', '1x1', '4x5', '9x16'],
    safe: null,
    avoid: [],
    source: 'spec',
    note: 'No guides drawn.'
  },

  generic: {
    id: 'generic',
    label: 'Generic 5% / 10%',
    ratios: ['16x9', '1x1', '4x5', '9x16'],
    safe: { top: 0.10, right: 0.10, bottom: 0.10, left: 0.10 },
    extraBox: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
    avoid: [],
    source: 'practical',
    note: 'The old 4:3-era convention: 5% action safe, 10% title safe. Kept as a neutral default.'
  },

  ebu_r95: {
    id: 'ebu_r95',
    label: '16:9 EBU R95 (broadcast)',
    ratios: ['16x9'],
    // R95 quotes both insets as a percentage of the full width and height,
    // applied at every edge — so 5% here is 5% off each side, leaving 90% of
    // the frame (1728x972 on an HD raster). The graphics safe area is the one
    // text has to stay inside; it is the smaller box, and it is the primary.
    safe: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
    // Action safe is the looser 3.5% inset (1786x1004 on HD) — essential
    // picture content, not text.
    extraBox: { top: 0.035, right: 0.035, bottom: 0.035, left: 0.035 },
    extraLabel: 'action',
    avoid: [],
    source: 'spec',
    note: 'EBU R95 (v1.1, 2017): 5% graphics safe area for text and logos, 3.5% action safe '
        + 'for essential picture content, measured in from each edge.'
  },

  youtube_16x9: {
    id: 'youtube_16x9',
    label: '16:9 YouTube',
    ratios: ['16x9'],
    // Google publishes no figures for the watch page, and the control row is a
    // fixed height in pixels rather than a fraction of the frame — measured at
    // 59 px, which is 5% of a full-width desktop player and about 15% of a
    // small embed. 12% is the compromise: right for a player around 500 px
    // tall, generous on a large one, still short on a very small embed.
    safe: { top: 0.06, right: 0.06, bottom: 0.12, left: 0.06 },
    avoid: [
      { top: 0.88, left: 0, right: 0, bottom: 0, label: 'Player controls / progress bar' },
      { top: 0, left: 0.74, right: 0, bottom: 0.86, label: 'Cards, Share, Watch later' }
    ],
    source: 'practical',
    note: 'Keeps captions clear of the progress bar and control row along the bottom, '
        + 'and of the card and share affordances top-right. The control row is a fixed '
        + 'pixel height, so it covers more of a small player than of a large one.'
  },

  youtube_shorts: {
    id: 'youtube_shorts',
    label: '9:16 YouTube Shorts',
    ratios: ['9x16'],
    // Google's safe-zone image for vertical video ads on YouTube, which run in
    // the Shorts feed: 288 px top, 672 px bottom, 48 px left, 192 px right on
    // 1080x1920. The right margin is the width of the button column, so the
    // box already clears it. Organic Shorts carry less at the bottom than an
    // ad does, so this errs on the safe side.
    safe: vertical(288, 192, 672, 48),
    avoid: [
      { top: 0, left: 0, right: 0, bottom: 1 - 288 / V_H, label: 'Search, menu' },
      { top: 1 - 672 / V_H, left: 0, right: 0, bottom: 0, label: 'Channel, Subscribe, title, progress bar' },
      { top: 0.42, left: 1 - 192 / V_W, right: 0, bottom: 672 / V_H, label: 'Like / dislike / comment / share / remix' }
    ],
    source: 'spec',
    note: 'Google\'s vertical-video safe zone for YouTube: 288 px top, 672 px bottom, 48 px left '
        + 'and 192 px right on 1080x1920. Published for ads, which run in Shorts; organic '
        + 'Shorts cover a little less at the bottom.'
  },

  instagram_reels: {
    id: 'instagram_reels',
    label: '9:16 Instagram Reels',
    ratios: ['9x16'],
    // Meta publishes this as percentages, not pixels, so it holds at any
    // vertical resolution: 14% of the height clear at the top, 35% at the
    // bottom, 6% of the width down each side. The bottom is not a flat band:
    // the action rail covers the rightmost 21% of the frame over the bottom
    // 40%, so it pokes 5% above the box's bottom edge on the right.
    safe: { top: 0.14, right: 0.06, bottom: 0.35, left: 0.06 },
    avoid: [
      { top: 0, left: 0, right: 0, bottom: 0.86, label: 'Reels header, camera' },
      { top: 0.65, left: 0, right: 0, bottom: 0, label: 'Username, caption, audio' },
      { top: 0.60, left: 0.79, right: 0, bottom: 0.35, label: 'Like / comment / share / save rail' }
    ],
    source: 'spec',
    note: 'Meta\'s published Reels safe zone: 14% clear at the top, 35% at the bottom, 6% '
        + 'each side, with the action rail over the rightmost 21% of the bottom 40%. A '
        + 'caption sitting right on the bottom edge of the box clips the rail — keep '
        + 'clear of the hatching too.'
  },

  instagram_stories: {
    id: 'instagram_stories',
    label: '9:16 Instagram Stories',
    ratios: ['9x16'],
    // Meta's current ads guide quotes one figure for Stories and Reels alike.
    // The sets stay separate because the interface above and below differs —
    // progress bar and profile row here, caption and rail there.
    safe: { top: 0.14, right: 0.06, bottom: 0.35, left: 0.06 },
    avoid: [
      { top: 0, left: 0, right: 0, bottom: 0.87, label: 'Progress bar, profile, close' },
      { top: 0.87, left: 0, right: 0, bottom: 0, label: 'Reply bar' }
    ],
    source: 'spec',
    note: 'Meta\'s published Stories safe zone: 14% clear at the top, 35% at the bottom, '
        + '6% each side — the progress bar and profile row above, the reply bar and '
        + 'call-to-action below.'
  },

  tiktok: {
    id: 'tiktok',
    label: '9:16 TikTok',
    ratios: ['9x16'],
    // TikTok ships a safe-zone template file with its In-Feed Ads guide rather
    // than a table: 240 px top, 660 px bottom, 120 px each side once scaled
    // from its 720x1280 canvas to 1080x1920. The button column is 180 px wide
    // from 840 px down — wider than the 120 px margin, and level with where a
    // bottom caption sits — so the box's right edge is moved in to clear it.
    safe: vertical(240, 180, 660, 120),
    avoid: [
      { top: 0, left: 0, right: 0, bottom: 1 - 240 / V_H, label: 'Following / For You, search' },
      { top: 1 - 660 / V_H, left: 0, right: 0, bottom: 0, label: 'Handle, caption, music' },
      { top: 840 / V_H, left: 1 - 180 / V_W, right: 0, bottom: 660 / V_H, label: 'Action rail' }
    ],
    source: 'spec',
    note: 'TikTok\'s in-feed safe-zone template: 240 px top, 660 px bottom and 120 px each side '
        + 'on 1080x1920, with the right edge pulled in to 180 px to clear the button column. '
        + 'A long post caption pushes the bottom higher still.'
  }
};

/** Sets that make sense for a given project ratio, in menu order. */
function safeAreaSetsFor(ratioId) {
  return Object.values(SAFE_AREA_SETS).filter(set => set.ratios.indexOf(ratioId) !== -1);
}

function getSafeAreaSet(id) {
  return SAFE_AREA_SETS[id] || SAFE_AREA_SETS.generic;
}

/**
 * Renders a guide set into `container` as positioned children.
 *
 * Percentages rather than pixels: the program frame is a scaled copy of the
 * project resolution, so the guides track it through every resize and
 * fullscreen change without being redrawn.
 */
function renderSafeAreas(container, setId, ratioId) {
  if (!container) return null;
  container.innerHTML = '';

  const set = getSafeAreaSet(setId);
  if (!set || !set.safe || set.ratios.indexOf(ratioId) === -1) return null;

  const pct = (n) => `${(n * 100).toFixed(3)}%`;

  // Tint what the platform's interface covers, so the eye reads "do not put a
  // caption here" rather than "this line is a suggestion".
  (set.avoid || []).forEach(zone => {
    const el = document.createElement('div');
    el.className = 'safe-avoid';
    el.style.top = pct(zone.top || 0);
    el.style.left = pct(zone.left || 0);
    el.style.right = pct(zone.right || 0);
    el.style.bottom = pct(zone.bottom || 0);
    if (zone.label) el.title = zone.label;
    container.appendChild(el);
  });

  if (set.extraBox) {
    const extra = document.createElement('div');
    extra.className = 'safe-secondary';
    extra.style.top = pct(set.extraBox.top);
    extra.style.right = pct(set.extraBox.right);
    extra.style.bottom = pct(set.extraBox.bottom);
    extra.style.left = pct(set.extraBox.left);
    if (set.extraLabel) extra.dataset.label = set.extraLabel;
    container.appendChild(extra);
  }

  const safe = document.createElement('div');
  safe.className = 'safe-primary';
  safe.style.top = pct(set.safe.top);
  safe.style.right = pct(set.safe.right);
  safe.style.bottom = pct(set.safe.bottom);
  safe.style.left = pct(set.safe.left);
  container.appendChild(safe);

  const tag = document.createElement('div');
  tag.className = `safe-tag${set.source === 'practical' ? ' practical' : ''}`;
  tag.textContent = set.label;
  tag.title = set.note;
  container.appendChild(tag);

  return set;
}

window.SAFE_AREA_SETS = SAFE_AREA_SETS;
window.safeAreaSetsFor = safeAreaSetsFor;
window.getSafeAreaSet = getSafeAreaSet;
window.renderSafeAreas = renderSafeAreas;
