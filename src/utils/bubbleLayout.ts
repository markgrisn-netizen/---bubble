import type {
  BoundingBox,
  ComicFormat,
  FontSettings,
  GlossaryCategory,
  GlossaryEntry,
  Point,
  ReadingDirection,
  TextRegion,
} from '../types/domain';

export function boxToPolygon(box: BoundingBox): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

export function polygonToBox(polygon: Point[]): BoundingBox {
  if (!polygon.length) {
    return { x: 0, y: 0, width: 100, height: 100 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: Math.max(0, Math.min(1000, minX)),
    y: Math.max(0, Math.min(1000, minY)),
    width: Math.max(10, Math.min(1000 - minX, maxX - minX)),
    height: Math.max(10, Math.min(1000 - minY, maxY - minY)),
  };
}

function boxIntersectionArea(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function compareByDirectionBands(
  a: BoundingBox,
  b: BoundingBox,
  direction: ReadingDirection,
  bandTolerance: number
): number {
  const ay = a.y + a.height / 2;
  const by = b.y + b.height / 2;
  const ax = a.x + a.width / 2;
  const bx = b.x + b.width / 2;

  if (Math.abs(ay - by) > bandTolerance) {
    return ay - by;
  }
  if (direction === 'rtl') {
    return bx - ax;
  }
  return ax - bx;
}

/**
 * Sorts comic/manga text regions by authentic reading order:
 * - When panels are provided (Western multi-tier / staggered / overlapping layouts),
 *   orders panels first in authentic Z-path (LTR for Western Comics, RTL for Manga),
 *   then orders speech bubbles/captions inside each panel cleanly.
 * - Falls back to band-aware sorting when panel geometry is absent.
 */
export function sortRegionsByReadingOrder<T extends { boundingBox: BoundingBox }>(
  regions: T[],
  direction: ReadingDirection,
  panels?: Array<{ box: BoundingBox }>
): T[] {
  if (!panels || panels.length === 0) {
    const bandTolerance = direction === 'vertical' ? 40 : 110;
    return [...regions].sort((a, b) =>
      compareByDirectionBands(a.boundingBox, b.boundingBox, direction, bandTolerance)
    );
  }

  const orderedPanels = [...panels].sort((a, b) =>
    compareByDirectionBands(
      a.box,
      b.box,
      direction,
      direction === 'vertical' ? 40 : 95
    )
  );

  const buckets = new Map<number, T[]>();
  const unassigned: T[] = [];

  for (const reg of regions) {
    const cx = reg.boundingBox.x + reg.boundingBox.width / 2;
    const cy = reg.boundingBox.y + reg.boundingBox.height / 2;

    let bestIdx = -1;
    let bestOverlap = 0;

    for (let i = 0; i < orderedPanels.length; i++) {
      const pBox = orderedPanels[i].box;
      const area = boxIntersectionArea(reg.boundingBox, pBox);
      if (area > bestOverlap) {
        bestOverlap = area;
        bestIdx = i;
      } else if (
        bestIdx === -1 &&
        cx >= pBox.x &&
        cx <= pBox.x + pBox.width &&
        cy >= pBox.y &&
        cy <= pBox.y + pBox.height
      ) {
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      unassigned.push(reg);
    } else {
      const list = buckets.get(bestIdx) || [];
      list.push(reg);
      buckets.set(bestIdx, list);
    }
  }

  const intraTolerance = direction === 'vertical' ? 32 : 55;
  const result: T[] = [];
  for (let i = 0; i < orderedPanels.length; i++) {
    const items = buckets.get(i);
    if (!items || items.length === 0) continue;
    items.sort((a, b) =>
      compareByDirectionBands(a.boundingBox, b.boundingBox, direction, intraTolerance)
    );
    result.push(...items);
  }

  if (unassigned.length > 0) {
    unassigned.sort((a, b) =>
      compareByDirectionBands(a.boundingBox, b.boundingBox, direction, 95)
    );
    result.push(...unassigned);
  }

  return result;
}

/**
 * Natural filename comparator so "page_2.png" sorts before "page_10.png".
 */
export function sortPageFilenames(names: string[]): string[] {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  return [...names].sort((a, b) => collator.compare(a, b));
}

export interface FittedTextResult {
  fontSize: number;
  lines: string[];
  lineHeightPx: number;
  overflowed: boolean;
}

/**
 * Rebalances consecutive wrapped lines so Western/Arabic oval speech bubbles
 * avoid awkward short orphan words on the final line while staying inside availWidth.
 */
function balanceComicLines(
  lines: string[],
  availWidth: number,
  fontSizePx: number,
  measureWidth: (str: string, fontSizePx: number) => number
): string[] {
  if (lines.length < 2) return lines;
  const balanced = [...lines];

  for (let i = 0; i < balanced.length - 1; i++) {
    const curWords = balanced[i].trim().split(/\s+/).filter(Boolean);
    const nextWords = balanced[i + 1].trim().split(/\s+/).filter(Boolean);
    if (curWords.length >= 3 && nextWords.length === 1) {
      const movedWord = curWords[curWords.length - 1];
      const candidateNext = `${movedWord} ${nextWords.join(' ')}`;
      const candidateCur = curWords.slice(0, -1).join(' ');
      if (
        measureWidth(candidateNext, fontSizePx) <= availWidth &&
        measureWidth(candidateCur, fontSizePx) >= measureWidth(candidateNext, fontSizePx) * 0.65
      ) {
        balanced[i] = candidateCur;
        balanced[i + 1] = candidateNext;
      }
    }
  }
  return balanced;
}

/**
 * Deterministic word-wrapper and auto-fit sizer for Western & Arabic comic speech bubbles.
 * Handles Arabic RTL shaping safety, English Comic Lettering, and diamond/oval balancing.
 */
export function fitTextInRegion(
  text: string,
  boxWidthPx: number,
  boxHeightPx: number,
  settings: Pick<FontSettings, 'fontSize' | 'lineHeight' | 'padding' | 'autoFit'> & {
    align?: FontSettings['align'];
  },
  measureWidth: (str: string, fontSizePx: number) => number
): FittedTextResult {
  const cleanText = (text || '').trim();
  if (!cleanText) {
    return {
      fontSize: settings.fontSize,
      lines: [],
      lineHeightPx: settings.fontSize * settings.lineHeight,
      overflowed: false,
    };
  }

  const padRatio = Math.min(0.32, Math.max(0.06, settings.padding / 100));
  const availWidth = Math.max(24, boxWidthPx * (1 - padRatio * 2));
  const availHeight = Math.max(20, boxHeightPx * (1 - padRatio * 2));
  const shouldBalance = settings.align !== 'left' && settings.align !== 'right';

  const wrapAtSize = (fontSizePx: number): string[] => {
    const paragraphs = cleanText.split(/\r?\n/);
    const lines: string[] = [];

    for (const para of paragraphs) {
      const words = para.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push('');
        continue;
      }

      const paraLines: string[] = [];
      let currentLine = words[0];
      if (measureWidth(currentLine, fontSizePx) > availWidth && currentLine.length > 4) {
        const splitChunks = breakLongToken(currentLine, availWidth, fontSizePx, measureWidth);
        paraLines.push(...splitChunks.slice(0, -1));
        currentLine = splitChunks[splitChunks.length - 1];
      }

      for (let i = 1; i < words.length; i++) {
        const candidate = `${currentLine} ${words[i]}`;
        if (measureWidth(candidate, fontSizePx) <= availWidth) {
          currentLine = candidate;
        } else {
          paraLines.push(currentLine);
          currentLine = words[i];
          if (measureWidth(currentLine, fontSizePx) > availWidth && currentLine.length > 4) {
            const splitChunks = breakLongToken(currentLine, availWidth, fontSizePx, measureWidth);
            paraLines.push(...splitChunks.slice(0, -1));
            currentLine = splitChunks[splitChunks.length - 1];
          }
        }
      }
      paraLines.push(currentLine);

      lines.push(
        ...(shouldBalance
          ? balanceComicLines(paraLines, availWidth, fontSizePx, measureWidth)
          : paraLines)
      );
    }
    return lines;
  };

  if (!settings.autoFit) {
    const lines = wrapAtSize(settings.fontSize);
    const lineHeightPx = settings.fontSize * settings.lineHeight;
    const totalH = lines.length * lineHeightPx;
    return {
      fontSize: settings.fontSize,
      lines,
      lineHeightPx,
      overflowed: totalH > availHeight,
    };
  }

  const maxCandidate = Math.min(
    Math.max(settings.fontSize, 26),
    Math.max(14, Math.floor(availHeight * 0.42))
  );
  const minCandidate = 9;

  for (let size = maxCandidate; size >= minCandidate; size -= 1) {
    const lines = wrapAtSize(size);
    const lineHeightPx = size * settings.lineHeight;
    const totalHeight = lines.length * lineHeightPx;
    const maxLineW = lines.reduce((m, l) => Math.max(m, measureWidth(l, size)), 0);
    if (totalHeight <= availHeight && maxLineW <= availWidth * 1.02) {
      return { fontSize: size, lines, lineHeightPx, overflowed: false };
    }
  }

  const fallbackLines = wrapAtSize(minCandidate);
  return {
    fontSize: minCandidate,
    lines: fallbackLines,
    lineHeightPx: minCandidate * settings.lineHeight,
    overflowed: fallbackLines.length * minCandidate * settings.lineHeight > availHeight,
  };
}

function breakLongToken(
  token: string,
  availWidth: number,
  fontSizePx: number,
  measureWidth: (str: string, fontSizePx: number) => number
): string[] {
  const chunks: string[] = [];
  let buf = '';
  for (const ch of token) {
    const next = buf + ch;
    if (buf.length > 0 && measureWidth(next, fontSizePx) > availWidth) {
      chunks.push(buf);
      buf = ch;
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function createDefaultFontSettings(
  targetLanguage: string,
  regionType: TextRegion['regionType'],
  _comicFormat?: ComicFormat
): FontSettings {
  const isArabic =
    targetLanguage.toLowerCase().startsWith('ar') || targetLanguage.includes('العربية');

  if (isArabic) {
    return {
      fontFamily:
        regionType === 'sfx'
          ? 'Lalezar'
          : regionType === 'narration'
          ? 'IBM Plex Sans Arabic'
          : 'Cairo',
      fontSize: regionType === 'sfx' ? 26 : regionType === 'narration' ? 16 : 18,
      fontWeight: regionType === 'sfx' ? '800' : '700',
      color: regionType === 'sfx' ? '#DC2626' : '#0F172A',
      strokeColor: regionType === 'sfx' || regionType === 'outside' ? '#FFFFFF' : undefined,
      strokeWidth: regionType === 'sfx' ? 4 : regionType === 'outside' ? 3 : 0,
      align: 'center',
      lineHeight: 1.38,
      padding: 11,
      rotation: 0,
      direction: 'rtl',
      autoFit: true,
      offsetX: 0,
      offsetY: 0,
      letterCase: 'normal',
    };
  }

  // Western Comic English Lettering defaults
  return {
    fontFamily:
      regionType === 'sfx'
        ? 'Bangers'
        : regionType === 'narration'
        ? 'Architects Daughter'
        : 'Comic Neue',
    fontSize: regionType === 'sfx' ? 28 : regionType === 'narration' ? 15 : 17,
    fontWeight: regionType === 'sfx' ? '800' : '700',
    color: regionType === 'sfx' ? '#DC2626' : '#0F172A',
    strokeColor: regionType === 'sfx' || regionType === 'outside' ? '#FFFFFF' : undefined,
    strokeWidth: regionType === 'sfx' ? 4 : regionType === 'outside' ? 3 : 0,
    align: 'center',
    lineHeight: 1.2,
    padding: 11,
    rotation: 0,
    direction: 'ltr',
    autoFit: true,
    offsetX: 0,
    offsetY: 0,
    letterCase: 'uppercase',
  };
}

/**
 * Matches glossary terms present in source text to build deterministic translation hints.
 */
export function findMatchingGlossaryTerms(
  text: string,
  glossary: GlossaryEntry[]
): GlossaryEntry[] {
  if (!text || !glossary.length) return [];
  const lower = text.toLowerCase();
  return glossary.filter((entry) => {
    const term = entry.originalTerm.trim();
    if (!term) return false;
    return lower.includes(term.toLowerCase());
  });
}

const VALID_GLOSSARY_CATEGORIES = new Set<GlossaryCategory>([
  'character',
  'title',
  'team',
  'power',
  'ability',
  'place',
  'military',
  'scientific',
  'fantasy',
  'sfx',
  'term',
]);

export function normalizeGlossaryCategory(raw?: string): GlossaryCategory {
  const clean = (raw || 'term').trim().toLowerCase() as GlossaryCategory;
  return VALID_GLOSSARY_CATEGORIES.has(clean) ? clean : 'term';
}

export function parseGlossaryCsv(csvContent: string): Array<Omit<GlossaryEntry, 'id' | 'projectId'>> {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const entries: Array<Omit<GlossaryEntry, 'id' | 'projectId'>> = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]);
    if (cols.length < 2) continue;
    if (i === 0 && cols[0].toLowerCase().includes('original')) continue;
    entries.push({
      originalTerm: cols[0].trim(),
      translatedTerm: cols[1].trim(),
      category: normalizeGlossaryCategory(cols[2]),
      notes: (cols[3] || '').trim(),
    });
  }
  return entries.filter((e) => e.originalTerm && e.translatedTerm);
}

export function exportGlossaryCsv(entries: GlossaryEntry[]): string {
  const header = 'original_term,translated_term,category,notes';
  const rows = entries.map((e) =>
    [e.originalTerm, e.translatedTerm, e.category, e.notes]
      .map((val) => `"${(val || '').replace(/"/g, '""')}"`)
      .join(',')
  );
  return [header, ...rows].join('\n');
}

function splitCsvRow(row: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
