const DEFAULT_DIMENSIONS = { thicknessMm: 16, widthMm: 2800, heightMm: 2070 };
const THICKNESS_MIN = 1, THICKNESS_MAX = 100;
const SIDE_MIN = 100, SIDE_MAX = 4000;
const SIZE_RE = /(\d{3,4})\s*[xхXХ*]\s*(\d{3,4})/;   // Latin x, Cyrillic х (U+0445), X, *
const THICKNESS_RE = /(\d{1,3})\s*мм/i;

function inRange(n, min, max) { return Number.isFinite(n) && n >= min && n <= max; }

function parseSheetDimensions(name) {
  const text = typeof name === 'string' ? name : '';
  let { widthMm, heightMm, thicknessMm } = DEFAULT_DIMENSIONS;
  const parsed = { thickness: false, width: false, height: false };

  const sizeMatch = SIZE_RE.exec(text);
  if (sizeMatch) {
    const w = Number(sizeMatch[1]), h = Number(sizeMatch[2]);
    if (inRange(w, SIDE_MIN, SIDE_MAX) && inRange(h, SIDE_MIN, SIDE_MAX)) {
      widthMm = w; heightMm = h; parsed.width = true; parsed.height = true;
    }
  }
  const withoutSize = sizeMatch ? text.replace(SIZE_RE, ' ') : text;
  const tMatch = THICKNESS_RE.exec(withoutSize);
  if (tMatch) {
    const t = Number(tMatch[1]);
    if (inRange(t, THICKNESS_MIN, THICKNESS_MAX)) { thicknessMm = t; parsed.thickness = true; }
  }
  return { thicknessMm, widthMm, heightMm, parsed };
}

module.exports = { parseSheetDimensions, DEFAULT_DIMENSIONS };
