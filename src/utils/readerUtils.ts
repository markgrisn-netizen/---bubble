export type ReaderMode = 'web' | 'paginated' | 'infinite';
export type PageSpacingPreset = 'none' | 'small' | 'large';
export type PageWidthMode = 'fit_width' | 'fit_screen';

export interface ReaderPreferences {
  mode: ReaderMode;
  spacing: PageSpacingPreset;
  backgroundColor: string;
  pageWidth: PageWidthMode;
  brightness: number; // 40..130 (%)
}

export const READER_PREFS_STORAGE_KEY = 'faqqa_reader_prefs_v1';

export const READER_BACKGROUND_SWATCHES: Array<{
  id: string;
  color: string;
  labelAr: string;
  labelEn: string;
  isLight: boolean;
}> = [
  { id: 'black', color: '#000000', labelAr: 'أسود', labelEn: 'Black', isLight: false },
  { id: 'charcoal', color: '#111318', labelAr: 'داكن', labelEn: 'Charcoal', isLight: false },
  { id: 'slate', color: '#262A33', labelAr: 'رمادي', labelEn: 'Gray', isLight: false },
  { id: 'cream', color: '#FAF5E8', labelAr: 'ورقي', labelEn: 'Paper', isLight: true },
  { id: 'white', color: '#FFFFFF', labelAr: 'أبيض', labelEn: 'White', isLight: true },
];

export const DEFAULT_READER_PREFERENCES: ReaderPreferences = {
  mode: 'web',
  spacing: 'none',
  backgroundColor: '#111318',
  pageWidth: 'fit_width',
  brightness: 100,
};

export function normalizeReaderPreferences(
  raw: Partial<ReaderPreferences> | null | undefined
): ReaderPreferences {
  const mode: ReaderMode =
    raw?.mode === 'paginated' || raw?.mode === 'infinite' || raw?.mode === 'web'
      ? raw.mode
      : DEFAULT_READER_PREFERENCES.mode;

  const spacing: PageSpacingPreset =
    raw?.spacing === 'none' || raw?.spacing === 'small' || raw?.spacing === 'large'
      ? raw.spacing
      : DEFAULT_READER_PREFERENCES.spacing;

  const pageWidth: PageWidthMode =
    raw?.pageWidth === 'fit_screen' || raw?.pageWidth === 'fit_width'
      ? raw.pageWidth
      : DEFAULT_READER_PREFERENCES.pageWidth;

  const bg =
    typeof raw?.backgroundColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.backgroundColor.trim())
      ? raw.backgroundColor.trim()
      : DEFAULT_READER_PREFERENCES.backgroundColor;

  const rawBright = Number(raw?.brightness);
  const brightness = Number.isFinite(rawBright)
    ? Math.max(40, Math.min(130, Math.round(rawBright)))
    : DEFAULT_READER_PREFERENCES.brightness;

  return {
    mode,
    spacing,
    backgroundColor: bg,
    pageWidth,
    brightness,
  };
}

export function getPageSpacingPx(spacing: PageSpacingPreset): number {
  switch (spacing) {
    case 'none':
      return 0;
    case 'small':
      return 8;
    case 'large':
      return 24;
    default:
      return 0;
  }
}

export function isLightBackgroundHex(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return false;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma >= 165;
}

export interface PageFrameSizeInput {
  naturalWidth: number;
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  pageWidthMode: PageWidthMode;
  zoom?: number;
  desktopMaxColumnWidth?: number;
}

export interface PageFrameSizeResult {
  width: number;
  height: number;
}

/**
 * Computes exact rendered frame size preserving original aspect ratio cleanly:
 * - fit_width on mobile (< 768px): fills 100% of available reading container width without clipping edges.
 * - fit_width on desktop: centers cleanly up to a readable column max (default 920px, or container width if smaller), scaled by zoom.
 * - fit_screen: scales proportionally to fit inside both viewportWidth and viewportHeight simultaneously.
 */
export function computeReaderPageFrameSize({
  naturalWidth,
  naturalHeight,
  viewportWidth,
  viewportHeight,
  pageWidthMode,
  zoom = 1,
  desktopMaxColumnWidth = 920,
}: PageFrameSizeInput): PageFrameSizeResult {
  const natW = Math.max(1, Number.isFinite(naturalWidth) ? naturalWidth : 900);
  const natH = Math.max(1, Number.isFinite(naturalHeight) ? naturalHeight : 1200);
  const vw = Math.max(160, Number.isFinite(viewportWidth) ? viewportWidth : 390);
  const vh = Math.max(200, Number.isFinite(viewportHeight) ? viewportHeight : 720);
  const safeZoom = Math.max(0.5, Math.min(2.5, Number.isFinite(zoom) ? zoom : 1));
  const aspect = natW / natH;

  if (pageWidthMode === 'fit_screen') {
    const availW = Math.max(160, vw - (vw < 640 ? 8 : 32));
    const availH = Math.max(200, vh - 24);
    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    return {
      width: Math.max(1, Math.round(w * safeZoom)),
      height: Math.max(1, Math.round(h * safeZoom)),
    };
  }

  // fit_width: edge-to-edge on mobile, comfortable max column width on wide desktops
  const isMobile = vw < 768;
  const baseTargetW = isMobile ? vw : Math.min(vw - 32, desktopMaxColumnWidth);
  const targetW = Math.max(1, Math.round(baseTargetW * safeZoom));
  const targetH = Math.max(1, Math.round(targetW / aspect));
  return {
    width: targetW,
    height: targetH,
  };
}

/**
 * Computes active high-resolution canvas window around currently visible pages so
 * 50-500+ page graphic novels only keep nearby canvases in GPU/bitmap memory.
 */
export function computeRenderWindow(
  visibleIndices: number[],
  totalPages: number,
  overscan = 4
): { start: number; end: number } {
  if (totalPages <= 0) return { start: 0, end: -1 };
  if (visibleIndices.length === 0) {
    return { start: 0, end: Math.min(totalPages - 1, overscan) };
  }
  let minIdx = totalPages - 1;
  let maxIdx = 0;
  for (const idx of visibleIndices) {
    if (idx >= 0 && idx < totalPages) {
      if (idx < minIdx) minIdx = idx;
      if (idx > maxIdx) maxIdx = idx;
    }
  }
  if (minIdx > maxIdx) {
    return { start: 0, end: Math.min(totalPages - 1, overscan) };
  }
  return {
    start: Math.max(0, minIdx - overscan),
    end: Math.min(totalPages - 1, maxIdx + overscan),
  };
}

/**
 * Advances progressive page batch size for Infinite mode.
 */
export function getNextInfiniteVisibleCount(
  currentCount: number,
  totalCount: number,
  batchSize = 8
): number {
  if (totalCount <= 0) return 0;
  return Math.min(totalCount, Math.max(1, currentCount) + Math.max(1, batchSize));
}

export interface PageViewportSpan {
  index: number;
  top: number;
  bottom: number;
}

/**
 * Determines which page currently occupies the reader focal line (~32% from viewport top).
 */
export function computeCurrentPageFromScroll(
  spans: PageViewportSpan[],
  viewportHeight: number
): number {
  if (spans.length === 0) return 0;
  const focalY = Math.max(0, viewportHeight * 0.32);

  let closestIdx = spans[0].index;
  let bestDist = Infinity;

  for (const span of spans) {
    if (span.top <= focalY && span.bottom >= focalY) {
      return span.index;
    }
    const center = (span.top + span.bottom) / 2;
    const dist = Math.abs(center - focalY);
    if (dist < bestDist) {
      bestDist = dist;
      closestIdx = span.index;
    }
  }

  return closestIdx;
}

export function computeReadingProgressPercent(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  currentPageIdx: number,
  totalPages: number,
  mode: ReaderMode
): number {
  if (totalPages <= 0) return 0;
  if (mode === 'paginated') {
    return Math.round(((currentPageIdx + 1) / totalPages) * 100);
  }
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll <= 4) {
    return Math.round(((currentPageIdx + 1) / totalPages) * 100);
  }
  const ratio = Math.max(0, Math.min(1, scrollTop / maxScroll));
  return Math.round(ratio * 100);
}
