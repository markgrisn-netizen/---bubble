import type { Page, ReadingDirection } from '../types/domain';

export interface HashableAsset {
  contentHash?: string;
}

/**
 * Flags duplicate assets by contentHash while keeping the first occurrence marked as primary.
 */
export function annotateDuplicatesByHash<T extends HashableAsset>(
  assets: T[]
): Array<T & { isDuplicate: boolean; duplicateOfIndex?: number }> {
  const firstSeen = new Map<string, number>();
  return assets.map((asset, idx) => {
    const hash = asset.contentHash?.trim();
    if (!hash) {
      return { ...asset, isDuplicate: false };
    }
    const priorIdx = firstSeen.get(hash);
    if (priorIdx !== undefined) {
      return { ...asset, isDuplicate: true, duplicateOfIndex: priorIdx };
    }
    firstSeen.set(hash, idx);
    return { ...asset, isDuplicate: false };
  });
}

/**
 * Removes duplicate entries by contentHash, keeping the first occurrence of each distinct asset.
 */
export function deduplicateByHash<T extends HashableAsset>(assets: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const asset of assets) {
    const hash = asset.contentHash?.trim();
    if (!hash) {
      result.push(asset);
      continue;
    }
    if (seen.has(hash)) continue;
    seen.add(hash);
    result.push(asset);
  }
  return result;
}

/**
 * Splits a potentially large list of base64/dataUrl pages into upload chunks constrained by both
 * max page count per request and max estimated payload bytes so 100+ page graphic novels never
 * exceed server JSON body limits.
 */
export function chunkPagesForUpload<T extends { dataUrl: string }>(
  pages: T[],
  maxPagesPerChunk = 5,
  maxBytesPerChunk = 12 * 1024 * 1024
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const page of pages) {
    const sizeEstimate = page.dataUrl.length;
    const wouldExceedCount = current.length >= Math.max(1, maxPagesPerChunk);
    const wouldExceedBytes = current.length > 0 && currentBytes + sizeEstimate > maxBytesPerChunk;

    if (wouldExceedCount || wouldExceedBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(page);
    currentBytes += sizeEstimate;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Parses a human page range specification such as "1-5, 8, 11-12" into a sorted unique list of 1-based page numbers.
 * Empty or invalid specs fall back cleanly to all pages if totalPages is provided.
 */
export function parsePageRangeSpec(spec: string, totalPages: number): number[] {
  const clean = spec.trim();
  if (!clean) {
    return Array.from({ length: Math.max(0, totalPages) }, (_, i) => i + 1);
  }

  const selected = new Set<number>();
  const parts = clean.split(/[,،\s]+/).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(1, Math.min(totalPages, Number(rangeMatch[1])));
      const end = Math.max(1, Math.min(totalPages, Number(rangeMatch[2])));
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let n = lo; n <= hi; n++) selected.add(n);
      continue;
    }
    const single = Number(part);
    if (Number.isInteger(single) && single >= 1 && single <= totalPages) {
      selected.add(single);
    }
  }

  return Array.from(selected).sort((a, b) => a - b);
}

/**
 * Orders pages consistently for reading-direction-aware PDF / archive export.
 * Sequential story order follows pageNumber ascending (1 -> N); when RTL manga viewers render
 * spreads or right-to-left sequences, spreads can be paired R-to-L or PDF ViewerPreferences Direction=R2L
 * while preserving exact narrative page order 1..N unless explicit spread reversal is requested.
 */
export function orderPagesForExport<T extends Pick<Page, 'pageNumber'>>(
  pages: T[],
  readingDirection: ReadingDirection,
  options?: { reverseSpreadPairsForRtl?: boolean }
): T[] {
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  if (readingDirection === 'rtl' && options?.reverseSpreadPairsForRtl) {
    // Useful for 2-up spread sheets where right page precedes left page visually
    const out: T[] = [];
    for (let i = 0; i < sorted.length; i += 2) {
      if (i + 1 < sorted.length) {
        out.push(sorted[i + 1], sorted[i]);
      } else {
        out.push(sorted[i]);
      }
    }
    return out;
  }
  return sorted;
}

export interface VerticalStripSlice {
  index: number;
  y: number;
  height: number;
}

/**
 * Computes balanced vertical slices for tall webtoon strips so long vertical scrolls
 * split cleanly without tiny leftover slivers. Normal comic pages remain unsliced.
 */
export function computeVerticalStripSlices(
  width: number,
  height: number,
  maxSliceHeight?: number
): VerticalStripSlice[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const tallThreshold = Math.max(2200, Math.round(safeWidth * 2.4));

  if (safeHeight <= tallThreshold) {
    return [{ index: 0, y: 0, height: safeHeight }];
  }

  const targetSlice =
    maxSliceHeight && maxSliceHeight > 400
      ? Math.floor(maxSliceHeight)
      : Math.max(1200, Math.min(2000, Math.round(safeWidth * 1.6)));

  const sliceCount = Math.max(2, Math.ceil(safeHeight / targetSlice));
  const baseHeight = Math.floor(safeHeight / sliceCount);
  const remainder = safeHeight - baseHeight * sliceCount;

  const slices: VerticalStripSlice[] = [];
  let cursorY = 0;
  for (let i = 0; i < sliceCount; i++) {
    const h = baseHeight + (i === sliceCount - 1 ? remainder : 0);
    slices.push({ index: i, y: cursorY, height: h });
    cursorY += h;
  }
  return slices;
}

