import type { BoundingBox, Point, RegionType, TextRegion } from '../types/domain';

export interface RgbaBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface CoreBackgroundEstimate {
  r: number;
  g: number;
  b: number;
  luma: number;
  isUniform: boolean;
  isDark: boolean;
  dominantFraction: number;
}

export interface BubbleRowSpan {
  y: number; // Relative to full image pixel Y
  leftX: number; // Leftmost safe interior X (full image px)
  rightX: number; // Rightmost safe interior X (full image px)
  width: number;
}

export interface BubbleSegmentationResult {
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
  /** 1 = safe bubble interior to clean/fit text inside, 0 = border/tail/outside artwork */
  interiorMask: Uint8Array;
  hasClosedBubble: boolean;
  confidence: number; // 0..1
  lowConfidence: boolean;
  background: CoreBackgroundEstimate;
  /** Visual centroid in full-image pixel coordinates */
  centroidPx: Point;
  /** Safe bounding box of full segmented interior in full-image pixel coordinates */
  safeBoxPx: BoundingBox;
  /** Inscribed central core bounding box excluding narrow spikes/horns for crisp text fitting */
  textSafeBoxPx: BoundingBox;
  /** Contour-aligned usable horizontal spans per pixel row (indexed by y - safeBoxPx.y) */
  rowSpans: BubbleRowSpan[];
  /** Extracted simplified contour polygon in normalized 0..1000 space */
  contourPolygonNorm: Point[];
  borderCoverageRatio: number;
  perimeterEscapeRatio: number;
}

export interface RegionQualityAudit {
  passed: boolean;
  confidence: number;
  issues: Array<
    | 'low_segmentation_confidence'
    | 'residual_source_ink'
    | 'exterior_leakage'
    | 'text_overflow'
    | 'text_out_of_bounds'
  >;
  residualInkRatio: number;
  exteriorChangedPixels: number;
  textOverflow: boolean;
  textOutOfBounds: boolean;
}

export function pointInPolygon(x: number, y: number, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-6) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function expandPolygonOutward(
  poly: Point[],
  pad: number | { top: number; bottom: number; left: number; right: number },
  clampW?: number,
  clampH?: number
): Point[] {
  if (poly.length === 0) return [];
  const pads =
    typeof pad === 'number' ? { top: pad, bottom: pad, left: pad, right: pad } : pad;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfW = Math.max(2, (maxX - minX) / 2);
  const halfH = Math.max(2, (maxY - minY) / 2);

  return poly.map((p) => {
    const nx = Math.max(-1, Math.min(1, (p.x - cx) / halfW));
    const ny = Math.max(-1, Math.min(1, (p.y - cy) / halfH));
    const pxPad = nx < 0 ? pads.left : pads.right;
    const pyPad = ny < 0 ? pads.top : pads.bottom;
    const ex = p.x + nx * pxPad;
    const ey = p.y + ny * pyPad;
    return {
      x: clampW !== undefined ? Math.max(0, Math.min(clampW - 1, ex)) : ex,
      y: clampH !== undefined ? Math.max(0, Math.min(clampH - 1, ey)) : ey,
    };
  });
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = Math.abs(r1 - r2);
  const dg = Math.abs(g1 - g2);
  const db = Math.abs(b1 - b2);
  const maxC = Math.max(dr, dg, db);
  const avgC = (dr + dg + db) / 3;
  return maxC * 0.55 + avgC * 0.45;
}

function isNeutralPaperOrDark(r: number, g: number, b: number): { luma: number; chroma: number } {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  return { luma, chroma };
}

/**
 * Estimates the balloon/box interior fill color by quantizing pixels inside an inset
 * core of the text region (where balloon fill occupies ~70-90% of pixels and text strokes ~10-30%).
 */
export function estimateInteriorFillColor(
  data: Uint8ClampedArray,
  bufW: number,
  bufH: number,
  sampleRect: { x: number; y: number; width: number; height: number }
): CoreBackgroundEstimate {
  const x0 = Math.max(0, Math.floor(sampleRect.x));
  const y0 = Math.max(0, Math.floor(sampleRect.y));
  const x1 = Math.min(bufW - 1, Math.ceil(sampleRect.x + sampleRect.width));
  const y1 = Math.min(bufH - 1, Math.ceil(sampleRect.y + sampleRect.height));

  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const stepX = Math.max(1, Math.floor(w / 32));
  const stepY = Math.max(1, Math.floor(h / 32));

  const bins = new Map<string, { count: number; rSum: number; gSum: number; bSum: number; score: number }>();
  let totalSamples = 0;

  for (let y = y0; y <= y1; y += stepY) {
    for (let x = x0; x <= x1; x += stepX) {
      const idx = (y * bufW + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      const { luma, chroma } = isNeutralPaperOrDark(r, g, b);
      // Slight bias toward paper-like bright tones if counts tie closely with bold dark text
      const paperBonus = luma > 200 && chroma < 35 ? 1.12 : 1.0;
      const existing = bins.get(key);
      if (existing) {
        existing.count += 1;
        existing.rSum += r;
        existing.gSum += g;
        existing.bSum += b;
        existing.score += paperBonus;
      } else {
        bins.set(key, { count: 1, rSum: r, gSum: g, bSum: b, score: paperBonus });
      }
      totalSamples += 1;
    }
  }

  let best: { count: number; rSum: number; gSum: number; bSum: number; score: number } | null = null;
  for (const bin of bins.values()) {
    if (!best || bin.score > best.score) best = bin;
  }

  if (!best || best.count === 0) {
    return {
      r: 255,
      g: 255,
      b: 255,
      luma: 255,
      isUniform: true,
      isDark: false,
      dominantFraction: 1,
    };
  }

  const r = Math.round(best.rSum / best.count);
  const g = Math.round(best.gSum / best.count);
  const b = Math.round(best.bSum / best.count);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const dominantFraction = totalSamples > 0 ? best.count / totalSamples : 1;
  return {
    r,
    g,
    b,
    luma,
    isUniform: dominantFraction >= 0.42,
    isDark: luma < 95,
    dominantFraction,
  };
}

/**
 * Computes normalized bounding box + expanded pixel ROI bounds for segmentation.
 */
export function computeRegionRoiBounds(
  region: Pick<TextRegion, 'boundingBox' | 'boundingPolygon' | 'regionType'>,
  imgW: number,
  imgH: number
): {
  localBoxPx: BoundingBox;
  pxPoly: Point[];
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
} {
  const poly =
    region.boundingPolygon && region.boundingPolygon.length >= 3
      ? region.boundingPolygon
      : [
          { x: region.boundingBox.x, y: region.boundingBox.y },
          { x: region.boundingBox.x + region.boundingBox.width, y: region.boundingBox.y },
          {
            x: region.boundingBox.x + region.boundingBox.width,
            y: region.boundingBox.y + region.boundingBox.height,
          },
          { x: region.boundingBox.x, y: region.boundingBox.y + region.boundingBox.height },
        ];

  const pxPoly = poly.map((p) => ({
    x: (p.x / 1000) * imgW,
    y: (p.y / 1000) * imgH,
  }));

  const polyMinX = Math.min(...pxPoly.map((p) => p.x));
  const polyMinY = Math.min(...pxPoly.map((p) => p.y));
  const polyMaxX = Math.max(...pxPoly.map((p) => p.x));
  const polyMaxY = Math.max(...pxPoly.map((p) => p.y));

  const boxW = Math.max(4, polyMaxX - polyMinX);
  const boxH = Math.max(4, polyMaxY - polyMinY);

  // Expand search window around OCR box so interior flood-fill finds the true balloon border
  // (critical when OCR returned only the tight text cluster instead of the outer balloon walls)
  const expandX =
    region.regionType === 'outside'
      ? 12
      : region.regionType === 'narration'
      ? Math.min(34, Math.max(12, Math.round(boxW * 0.16)))
      : Math.min(64, Math.max(18, Math.round(boxW * 0.32)));
  const expandY =
    region.regionType === 'outside'
      ? 12
      : region.regionType === 'narration'
      ? Math.min(30, Math.max(12, Math.round(boxH * 0.18)))
      : Math.min(64, Math.max(18, Math.round(boxH * 0.32)));

  const roiX = Math.max(0, Math.floor(polyMinX - expandX));
  const roiY = Math.max(0, Math.floor(polyMinY - expandY));
  const roiMaxX = Math.min(imgW - 1, Math.ceil(polyMaxX + expandX));
  const roiMaxY = Math.min(imgH - 1, Math.ceil(polyMaxY + expandY));

  return {
    localBoxPx: {
      x: polyMinX,
      y: polyMinY,
      width: boxW,
      height: boxH,
    },
    pxPoly,
    roiX,
    roiY,
    roiW: Math.max(1, roiMaxX - roiX + 1),
    roiH: Math.max(1, roiMaxY - roiY + 1),
  };
}

/**
 * True Computer Vision Speech Balloon & Caption Box Interior Segmentation:
 * 1. Estimates dominant interior fill color (light, cream, dark/noir, or colored box).
 * 2. Seeds multi-point flood-fill inside the text zone over interior-matching pixels, stopping at dark/colored borders.
 * 3. Runs topological exterior flood-fill from ROI edges on the complement mask so ALL interior letters,
 *    enclosed counters ('O', 'A', 'B'), shadows, and anti-aliased halos are absorbed into interiorMask while
 *    keeping the outer black border & artwork strictly excluded.
 * 4. Pinches narrow balloon tails outside the core box so tails remain intact and don't skew centering.
 * 5. Erodes 1px away from contrast boundaries so 0px of the black border or external artwork is ever modified.
 */
export function segmentBubbleInterior(
  roiData: Uint8ClampedArray,
  roiW: number,
  roiH: number,
  roiX: number,
  roiY: number,
  regionType: RegionType,
  globalBoxPx: BoundingBox,
  pxPoly: Point[]
): BubbleSegmentationResult {
  const localBox = {
    x: Math.max(0, Math.min(roiW - 1, globalBoxPx.x - roiX)),
    y: Math.max(0, Math.min(roiH - 1, globalBoxPx.y - roiY)),
    width: Math.max(4, Math.min(roiW, globalBoxPx.width)),
    height: Math.max(4, Math.min(roiH, globalBoxPx.height)),
  };

  const corePadX = localBox.width * 0.14;
  const corePadY = localBox.height * 0.14;
  const bg = estimateInteriorFillColor(roiData, roiW, roiH, {
    x: localBox.x + corePadX,
    y: localBox.y + corePadY,
    width: Math.max(4, localBox.width - corePadX * 2),
    height: Math.max(4, localBox.height - corePadY * 2),
  });

  const totalPixels = roiW * roiH;
  const emptyResult = (lowConfidence = true): BubbleSegmentationResult => ({
    roiX,
    roiY,
    roiW,
    roiH,
    interiorMask: new Uint8Array(totalPixels),
    hasClosedBubble: false,
    confidence: 0.25,
    lowConfidence,
    background: bg,
    centroidPx: {
      x: globalBoxPx.x + globalBoxPx.width / 2,
      y: globalBoxPx.y + globalBoxPx.height / 2,
    },
    safeBoxPx: { ...globalBoxPx },
    textSafeBoxPx: { ...globalBoxPx },
    rowSpans: [],
    contourPolygonNorm: [],
    borderCoverageRatio: 0,
    perimeterEscapeRatio: 1,
  });

  if (regionType === 'outside' || !bg.isUniform) {
    return emptyResult(true);
  }

  // Tolerance tuned to capture JPEG-compressed paper/dark balloon fill while halting cleanly at comic borders
  const bgTol = bg.isDark ? 34 : 36;
  const bgMatch = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const p = i * 4;
    const dist = colorDistance(roiData[p], roiData[p + 1], roiData[p + 2], bg.r, bg.g, bg.b);
    if (dist <= bgTol) {
      bgMatch[i] = 1;
    }
  }

  // Multi-point interior seed BFS inside localBox
  const reachedBg = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let qHead = 0;
  let qTail = 0;

  const seedX0 = Math.max(0, Math.floor(localBox.x + localBox.width * 0.08));
  const seedX1 = Math.min(roiW - 1, Math.ceil(localBox.x + localBox.width * 0.92));
  const seedY0 = Math.max(0, Math.floor(localBox.y + localBox.height * 0.08));
  const seedY1 = Math.min(roiH - 1, Math.ceil(localBox.y + localBox.height * 0.92));

  for (let y = seedY0; y <= seedY1; y += 2) {
    for (let x = seedX0; x <= seedX1; x += 2) {
      const pos = y * roiW + x;
      if (bgMatch[pos] === 1 && reachedBg[pos] === 0) {
        reachedBg[pos] = 1;
        queue[qTail++] = pos;
      }
    }
  }

  // Also ensure center pixel vicinity is seeded even on tiny boxes
  const cxSeed = Math.max(0, Math.min(roiW - 1, Math.round(localBox.x + localBox.width / 2)));
  const cySeed = Math.max(0, Math.min(roiH - 1, Math.round(localBox.y + localBox.height / 2)));
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const sx = cxSeed + dx;
      const sy = cySeed + dy;
      if (sx < 0 || sx >= roiW || sy < 0 || sy >= roiH) continue;
      const pos = sy * roiW + sx;
      if (bgMatch[pos] === 1 && reachedBg[pos] === 0) {
        reachedBg[pos] = 1;
        queue[qTail++] = pos;
      }
    }
  }

  while (qHead < qTail) {
    const pos = queue[qHead++];
    const x = pos % roiW;
    const y = (pos - x) / roiW;

    if (x > 0) {
      const n = pos - 1;
      if (reachedBg[n] === 0 && bgMatch[n] === 1) {
        reachedBg[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (x + 1 < roiW) {
      const n = pos + 1;
      if (reachedBg[n] === 0 && bgMatch[n] === 1) {
        reachedBg[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (y > 0) {
      const n = pos - roiW;
      if (reachedBg[n] === 0 && bgMatch[n] === 1) {
        reachedBg[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (y + 1 < roiH) {
      const n = pos + roiW;
      if (reachedBg[n] === 0 && bgMatch[n] === 1) {
        reachedBg[n] = 1;
        queue[qTail++] = n;
      }
    }
  }

  // Count how much of the ROI outer perimeter was reached by the interior fill
  let perimTotal = 0;
  let perimReached = 0;
  for (let x = 0; x < roiW; x++) {
    perimTotal += 2;
    if (reachedBg[x] === 1) perimReached += 1;
    if (reachedBg[(roiH - 1) * roiW + x] === 1) perimReached += 1;
  }
  for (let y = 1; y < roiH - 1; y++) {
    perimTotal += 2;
    if (reachedBg[y * roiW] === 1) perimReached += 1;
    if (reachedBg[y * roiW + (roiW - 1)] === 1) perimReached += 1;
  }
  const perimeterEscapeRatio = perimTotal > 0 ? perimReached / perimTotal : 1;

  // If flood-fill escaped overwhelmingly into open page margins/gutter/background (>26% perimeter),
  // restrict flood-fill cleanly to the provided polygon/box envelope so we don't leak into panel gutters!
  if (perimeterEscapeRatio > 0.26) {
    // Expand polygon uniformly in both X and Y regardless of aspect ratio
    const localPoly = pxPoly.map((p) => ({ x: p.x - roiX, y: p.y - roiY }));
    const baseExpand = Math.min(
      26,
      Math.max(14, Math.round(Math.min(localBox.width, localBox.height) * 0.14))
    );
    const maxRayScan = Math.min(
      52,
      Math.max(baseExpand + 8, Math.round(Math.min(localBox.width, localBox.height) * 0.3))
    );

    // Cast outward rays from all 4 sides of localBox up to maxRayScan to locate real bubble walls
    const xStart = Math.max(0, Math.floor(localBox.x));
    const xEnd = Math.min(roiW - 1, Math.ceil(localBox.x + localBox.width));
    const yStart = Math.max(0, Math.floor(localBox.y));
    const yEnd = Math.min(roiH - 1, Math.ceil(localBox.y + localBox.height));

    const sideStats: Array<{ hits: number; total: number; dists: number[] }> = [
      { hits: 0, total: 0, dists: [] }, // top
      { hits: 0, total: 0, dists: [] }, // bottom
      { hits: 0, total: 0, dists: [] }, // left
      { hits: 0, total: 0, dists: [] }, // right
    ];
    for (let x = xStart; x <= xEnd; x += 3) {
      sideStats[0].total += 1;
      for (let d = 1; d <= maxRayScan; d++) {
        const y = yStart - d;
        if (y < 0) break;
        if (bgMatch[y * roiW + x] === 0) {
          sideStats[0].hits += 1;
          sideStats[0].dists.push(d);
          break;
        }
      }
      sideStats[1].total += 1;
      for (let d = 1; d <= maxRayScan; d++) {
        const y = yEnd + d;
        if (y >= roiH) break;
        if (bgMatch[y * roiW + x] === 0) {
          sideStats[1].hits += 1;
          sideStats[1].dists.push(d);
          break;
        }
      }
    }
    for (let y = yStart; y <= yEnd; y += 3) {
      sideStats[2].total += 1;
      for (let d = 1; d <= maxRayScan; d++) {
        const x = xStart - d;
        if (x < 0) break;
        if (bgMatch[y * roiW + x] === 0) {
          sideStats[2].hits += 1;
          sideStats[2].dists.push(d);
          break;
        }
      }
      sideStats[3].total += 1;
      for (let d = 1; d <= maxRayScan; d++) {
        const x = xEnd + d;
        if (x >= roiW) break;
        if (bgMatch[y * roiW + x] === 0) {
          sideStats[3].hits += 1;
          sideStats[3].dists.push(d);
          break;
        }
      }
    }

    let totalRays = 0;
    let totalWallHits = 0;
    let sidesWithWall = 0;
    const sideExpand = [baseExpand, baseExpand, baseExpand, baseExpand];
    for (let i = 0; i < sideStats.length; i++) {
      const s = sideStats[i];
      totalRays += s.total;
      totalWallHits += s.hits;
      if (s.total > 0 && s.hits / s.total >= 0.25) {
        sidesWithWall += 1;
        if (s.dists.length > 0) {
          s.dists.sort((a, b) => a - b);
          // Stop right at the outer wall (p85 + 2) so open gaps don't flood around the outside of walls
          const p85 = s.dists[Math.min(s.dists.length - 1, Math.floor(s.dists.length * 0.85))];
          sideExpand[i] = Math.min(maxRayScan, Math.max(6, p85 + 2));
        }
      }
    }
    const wallHitRatio = totalRays > 0 ? totalWallHits / totalRays : 0;

    // On open top/bottom edges where walls are open (<25% hit), trace isolated foreground text/punctuation (e.g. !! below box)
    const innerX0 = Math.min(xEnd, xStart + Math.floor((xEnd - xStart) * 0.1));
    const innerX1 = Math.max(innerX0, xEnd - Math.floor((xEnd - xStart) * 0.1));
    const innerSpanW = Math.max(1, innerX1 - innerX0 + 1);
    for (const [sideIdx, dir, originY] of [
      [0, -1, yStart],
      [1, 1, yEnd],
    ] as const) {
      if (sideStats[sideIdx].total > 0 && sideStats[sideIdx].hits / sideStats[sideIdx].total < 0.25) {
        let gapRows = 0;
        let lastInkD = 0;
        for (let d = 1; d <= maxRayScan; d++) {
          const y = originY + dir * d;
          if (y < 0 || y >= roiH) break;
          let inkCols = 0;
          for (let x = innerX0; x <= innerX1; x++) {
            if (bgMatch[y * roiW + x] === 0) inkCols += 1;
          }
          const frac = inkCols / innerSpanW;
          if (frac >= 0.45) break; // Stop immediately before solid wall or panel artwork
          if (frac > 0.01) {
            lastInkD = d;
            gapRows = 0;
          } else {
            gapRows += 1;
            if (gapRows > 18) break;
          }
        }
        if (lastInkD > 0) {
          sideExpand[sideIdx] = Math.min(maxRayScan, Math.max(sideExpand[sideIdx], lastInkD + 8));
        }
      }
    }

    // Only reject as borderless if perimeter escaped heavily AND fewer than 2 sides show comic bubble walls
    if (perimeterEscapeRatio > 0.42 && (wallHitRatio < 0.2 || sidesWithWall < 2)) {
      return {
        ...emptyResult(true),
        perimeterEscapeRatio,
        borderCoverageRatio: wallHitRatio,
        confidence: 0.32,
      };
    }

    const expandedEnvPoly = expandPolygonOutward(localPoly, {
      top: sideExpand[0],
      bottom: sideExpand[1],
      left: sideExpand[2],
      right: sideExpand[3],
    });

    // Clamp reachedBg inside expandedEnvPoly so border openings/gaps can't bleed outside region
    for (let y = 0; y < roiH; y++) {
      for (let x = 0; x < roiW; x++) {
        if (reachedBg[y * roiW + x] === 1 && !pointInPolygon(x, y, expandedEnvPoly)) {
          reachedBg[y * roiW + x] = 0;
        }
      }
    }
  }

  // Stage 2: Separate cleaning fill (never pinches top/bottom text inside localBox) from layout tail-pinch fill
  const throatMin = Math.max(6, Math.min(18, Math.round(Math.min(localBox.width, localBox.height) * 0.2)));
  const lbX0 = localBox.x - 3;
  const lbX1 = localBox.x + localBox.width + 3;
  const lbY0 = localBox.y - 3;
  const lbY1 = localBox.y + localBox.height + 3;

  // Measure max horizontal fill chord for layout spike/tail pinching
  let maxRowRun = 0;
  for (let y = 0; y < roiH; y++) {
    let run = 0;
    for (let x = 0; x < roiW; x++) {
      if (reachedBg[y * roiW + x] === 1) {
        run += 1;
        if (run > maxRowRun) maxRowRun = run;
      } else {
        run = 0;
      }
    }
  }
  const innerNeckMax = Math.max(4, Math.min(throatMin, Math.round(maxRowRun * 0.28)));

  // 2A. Cleaning pinched mask: only pinch narrow external tail throats far outside localBox
  const cleanPadOut = 8;
  const cleanPinched = new Uint8Array(reachedBg);
  for (let y = 0; y < roiH; y++) {
    const farOutsideY = y < localBox.y - cleanPadOut || y > localBox.y + localBox.height + cleanPadOut;
    if (!farOutsideY) continue;
    let runStart = -1;
    for (let x = 0; x <= roiW; x++) {
      const val = x < roiW ? reachedBg[y * roiW + x] : 0;
      if (val === 1 && runStart === -1) {
        runStart = x;
      } else if (val === 0 && runStart !== -1) {
        if (x - runStart <= throatMin) {
          for (let k = runStart; k < x; k++) cleanPinched[y * roiW + k] = 0;
        }
        runStart = -1;
      }
    }
  }
  for (let x = 0; x < roiW; x++) {
    const farOutsideX = x < localBox.x - cleanPadOut || x > localBox.x + localBox.width + cleanPadOut;
    if (!farOutsideX) continue;
    let runStart = -1;
    for (let y = 0; y <= roiH; y++) {
      const val = y < roiH ? cleanPinched[y * roiW + x] : 0;
      if (val === 1 && runStart === -1) {
        runStart = y;
      } else if (val === 0 && runStart !== -1) {
        if (y - runStart <= throatMin) {
          for (let k = runStart; k < y; k++) cleanPinched[k * roiW + x] = 0;
        }
        runStart = -1;
      }
    }
  }

  // 2B. Layout pinched mask: keeps exact tail/spike neck pinching for centering & text wrapping
  const pinched = new Uint8Array(reachedBg);
  for (let y = 0; y < roiH; y++) {
    const inTailCapBand = y < localBox.y + localBox.height * 0.14 || y > localBox.y + localBox.height * 0.86;
    let runStart = -1;
    for (let x = 0; x <= roiW; x++) {
      const val = x < roiW ? reachedBg[y * roiW + x] : 0;
      if (val === 1 && runStart === -1) {
        runStart = x;
      } else if (val === 0 && runStart !== -1) {
        const runLen = x - runStart;
        const outsideCore = y < lbY0 || y > lbY1;
        if ((outsideCore && runLen <= throatMin) || (inTailCapBand && runLen <= innerNeckMax)) {
          for (let k = runStart; k < x; k++) pinched[y * roiW + k] = 0;
        }
        runStart = -1;
      }
    }
  }
  for (let x = 0; x < roiW; x++) {
    let runStart = -1;
    for (let y = 0; y <= roiH; y++) {
      const val = y < roiH ? pinched[y * roiW + x] : 0;
      if (val === 1 && runStart === -1) {
        runStart = y;
      } else if (val === 0 && runStart !== -1) {
        const runLen = y - runStart;
        const outsideCore = x < lbX0 || x > lbX1;
        if (outsideCore && runLen <= throatMin) {
          for (let k = runStart; k < y; k++) pinched[k * roiW + x] = 0;
        }
        runStart = -1;
      }
    }
  }

  const floodMainBody = (sourceMask: Uint8Array): Uint8Array => {
    const body = new Uint8Array(totalPixels);
    qHead = 0;
    qTail = 0;
    for (let y = seedY0; y <= seedY1; y += 2) {
      for (let x = seedX0; x <= seedX1; x += 2) {
        const pos = y * roiW + x;
        if (sourceMask[pos] === 1 && body[pos] === 0) {
          body[pos] = 1;
          queue[qTail++] = pos;
        }
      }
    }
    while (qHead < qTail) {
      const pos = queue[qHead++];
      const x = pos % roiW;
      const y = (pos - x) / roiW;
      if (x > 0 && sourceMask[pos - 1] === 1 && body[pos - 1] === 0) {
        body[pos - 1] = 1;
        queue[qTail++] = pos - 1;
      }
      if (x + 1 < roiW && sourceMask[pos + 1] === 1 && body[pos + 1] === 0) {
        body[pos + 1] = 1;
        queue[qTail++] = pos + 1;
      }
      if (y > 0 && sourceMask[pos - roiW] === 1 && body[pos - roiW] === 0) {
        body[pos - roiW] = 1;
        queue[qTail++] = pos - roiW;
      }
      if (y + 1 < roiH && sourceMask[pos + roiW] === 1 && body[pos + roiW] === 0) {
        body[pos + roiW] = 1;
        queue[qTail++] = pos + roiW;
      }
    }
    return body;
  };

  const cleanMainBg = floodMainBody(cleanPinched);
  const layoutMainBg = floodMainBody(pinched);

  // Seal narrow letter-to-border ink contact gaps inside/near localBox (plus expanded chamber collar) so exterior flood cannot enter letters/punctuation touching or near the rim
  const bridgePad = Math.min(44, Math.max(16, Math.round(Math.min(localBox.width, localBox.height) * 0.22)));
  const bridgeMinX = Math.max(0, Math.floor(localBox.x - bridgePad));
  const bridgeMaxX = Math.min(roiW - 1, Math.ceil(localBox.x + localBox.width + bridgePad));
  const bridgeMinY = Math.max(0, Math.floor(localBox.y - bridgePad));
  const bridgeMaxY = Math.min(roiH - 1, Math.ceil(localBox.y + localBox.height + bridgePad));
  const coreMaxBridge = bg.isDark
    ? 6
    : Math.min(16, Math.max(10, Math.round(localBox.width * 0.12)));
  const collarMaxBridge = bg.isDark ? 5 : 10;
  const bridgedCleanBg = new Uint8Array(cleanMainBg);

  for (let y = bridgeMinY; y <= bridgeMaxY; y++) {
    const inCoreY = y >= localBox.y - 4 && y <= localBox.y + localBox.height + 4;
    const maxGap = inCoreY ? coreMaxBridge : collarMaxBridge;
    let lastOneX = -1;
    for (let x = bridgeMinX; x <= bridgeMaxX; x++) {
      if (cleanMainBg[y * roiW + x] === 1) {
        if (lastOneX !== -1 && x - lastOneX > 1 && x - lastOneX - 1 <= maxGap) {
          for (let kx = lastOneX + 1; kx < x; kx++) {
            bridgedCleanBg[y * roiW + kx] = 1;
          }
        }
        lastOneX = x;
      }
    }
  }
  for (let x = bridgeMinX; x <= bridgeMaxX; x++) {
    const inCoreX = x >= localBox.x - 4 && x <= localBox.x + localBox.width + 4;
    const maxGap = inCoreX ? coreMaxBridge : collarMaxBridge;
    let lastOneY = -1;
    for (let y = bridgeMinY; y <= bridgeMaxY; y++) {
      if (cleanMainBg[y * roiW + x] === 1) {
        if (lastOneY !== -1 && y - lastOneY > 1 && y - lastOneY - 1 <= maxGap) {
          for (let ky = lastOneY + 1; ky < y; ky++) {
            bridgedCleanBg[ky * roiW + x] = 1;
          }
        }
        lastOneY = y;
      }
    }
  }
  // Diagonal 1D bridges inside [localBox - 6, localBox + 6] for glyphs touching curved corners
  const diagMinX = Math.max(0, Math.floor(localBox.x - 6));
  const diagMaxX = Math.min(roiW - 1, Math.ceil(localBox.x + localBox.width + 6));
  const diagMinY = Math.max(0, Math.floor(localBox.y - 6));
  const diagMaxY = Math.min(roiH - 1, Math.ceil(localBox.y + localBox.height + 6));
  const diagBridge = bg.isDark ? 5 : 10;
  for (const [dx, dy] of [[1, 1], [1, -1]] as const) {
    for (let sy = diagMinY; sy <= diagMaxY; sy++) {
      for (let sx = diagMinX; sx <= diagMaxX; sx++) {
        // Only start diagonals on perimeter of diag box to scan each line once
        const isEdge = sx === diagMinX || (dy === 1 ? sy === diagMinY : sy === diagMaxY);
        if (!isEdge) continue;
        let step = 0;
        let lastOneStep = -1;
        while (true) {
          const x = sx + step * dx;
          const y = sy + step * dy;
          if (x < diagMinX || x > diagMaxX || y < diagMinY || y > diagMaxY) break;
          if (cleanMainBg[y * roiW + x] === 1) {
            if (lastOneStep !== -1 && step - lastOneStep > 1 && step - lastOneStep - 1 <= diagBridge) {
              for (let k = lastOneStep + 1; k < step; k++) {
                const bx = sx + k * dx;
                const by = sy + k * dy;
                bridgedCleanBg[by * roiW + bx] = 1;
              }
            }
            lastOneStep = step;
          }
          step += 1;
        }
      }
    }
  }

  // Stage 3: Topological Exterior Flood-Fill to absorb 100% of enclosed text strokes, shadows, & counters
  const computeRawInterior = (bodyMask: Uint8Array): Uint8Array => {
    const ext = new Uint8Array(totalPixels);
    qHead = 0;
    qTail = 0;
    const trySeedExt = (x: number, y: number) => {
      const pos = y * roiW + x;
      if (bodyMask[pos] === 0 && ext[pos] === 0) {
        ext[pos] = 1;
        queue[qTail++] = pos;
      }
    };
    for (let x = 0; x < roiW; x++) {
      trySeedExt(x, 0);
      trySeedExt(x, roiH - 1);
    }
    for (let y = 0; y < roiH; y++) {
      trySeedExt(0, y);
      trySeedExt(roiW - 1, y);
    }
    while (qHead < qTail) {
      const pos = queue[qHead++];
      const x = pos % roiW;
      const y = (pos - x) / roiW;
      if (x > 0) {
        const n = pos - 1;
        if (bodyMask[n] === 0 && ext[n] === 0) {
          ext[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (x + 1 < roiW) {
        const n = pos + 1;
        if (bodyMask[n] === 0 && ext[n] === 0) {
          ext[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y > 0) {
        const n = pos - roiW;
        if (bodyMask[n] === 0 && ext[n] === 0) {
          ext[n] = 1;
          queue[qTail++] = n;
        }
      }
      if (y + 1 < roiH) {
        const n = pos + roiW;
        if (bodyMask[n] === 0 && ext[n] === 0) {
          ext[n] = 1;
          queue[qTail++] = n;
        }
      }
    }
    const raw = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      raw[i] = ext[i] === 0 ? 1 : 0;
    }
    return raw;
  };

  const rawInterior = computeRawInterior(bridgedCleanBg);
  const rawLayoutInterior = computeRawInterior(layoutMainBg);

  // Stage 4: Keep strong contrasting border ink protected while removing anti-aliased edge halos/remnants
  const interiorMask = new Uint8Array(rawInterior);
  let boundaryCount = 0;
  let contrastedBoundaryCount = 0;

  for (let y = 1; y < roiH - 1; y++) {
    for (let x = 1; x < roiW - 1; x++) {
      const pos = y * roiW + x;
      if (rawInterior[pos] === 0) continue;

      const touchesOutside =
        rawInterior[pos - 1] === 0 ||
        rawInterior[pos + 1] === 0 ||
        rawInterior[pos - roiW] === 0 ||
        rawInterior[pos + roiW] === 0;

      if (touchesOutside) {
        boundaryCount += 1;
        const neighbors = [pos - 1, pos + 1, pos - roiW, pos + roiW];
        let hasBorderContrast = false;
        for (const nPos of neighbors) {
          if (rawInterior[nPos] === 0) {
            const np = nPos * 4;
            const d = colorDistance(roiData[np], roiData[np + 1], roiData[np + 2], bg.r, bg.g, bg.b);
            if (d > bgTol * 1.15) {
              hasBorderContrast = true;
              break;
            }
          }
        }
        if (hasBorderContrast) {
          contrastedBoundaryCount += 1;
          const wasBridgedLetterStroke = bridgedCleanBg[pos] === 1 && cleanMainBg[pos] === 0;
          if (!wasBridgedLetterStroke) {
            const pp = pos * 4;
            const selfDist = colorDistance(
              roiData[pp],
              roiData[pp + 1],
              roiData[pp + 2],
              bg.r,
              bg.g,
              bg.b
            );
            if (selfDist > 78) {
              interiorMask[pos] = 0;
            }
          }
        }
      }
    }
  }

  // Absorb isolated 1px inward-protruding letter tips/halos (>= 3 orthogonal interior neighbors) without eroding convex borders
  const tipMinX = Math.max(1, bridgeMinX);
  const tipMaxX = Math.min(roiW - 2, bridgeMaxX);
  const tipMinY = Math.max(1, bridgeMinY);
  const tipMaxY = Math.min(roiH - 2, bridgeMaxY);
  for (let pass = 0; pass < 2; pass++) {
    const promote: number[] = [];
    for (let y = tipMinY; y <= tipMaxY; y++) {
      for (let x = tipMinX; x <= tipMaxX; x++) {
        const pos = y * roiW + x;
        if (interiorMask[pos] === 1) continue;
        const nCount =
          interiorMask[pos - 1] +
          interiorMask[pos + 1] +
          interiorMask[pos - roiW] +
          interiorMask[pos + roiW];
        if (nCount >= 3) {
          promote.push(pos);
        }
      }
    }
    if (promote.length === 0) break;
    for (const pos of promote) {
      interiorMask[pos] = 1;
    }
  }

  // Compute area, visual centroid, bounding box, and per-row interior spans using layout mask (tail/spike excluded)
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minIX = roiW;
  let maxIX = -1;
  let minIY = roiH;
  let maxIY = -1;

  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      const pos = y * roiW + x;
      if (interiorMask[pos] === 1 && rawLayoutInterior[pos] === 1) {
        area += 1;
        sumX += x;
        sumY += y;
        if (x < minIX) minIX = x;
        if (x > maxIX) maxIX = x;
        if (y < minIY) minIY = y;
        if (y > maxIY) maxIY = y;
      }
    }
  }

  const borderCoverageRatio = boundaryCount > 0 ? contrastedBoundaryCount / boundaryCount : 0;
  const boxArea = Math.max(16, localBox.width * localBox.height);
  if (area < Math.max(36, boxArea * 0.25)) {
    return {
      ...emptyResult(true),
      borderCoverageRatio,
      perimeterEscapeRatio,
      confidence: 0.3,
    };
  }

  const rowSpans: BubbleRowSpan[] = [];
  for (let y = minIY; y <= maxIY; y++) {
    // Find longest contiguous run of layout-interior pixels on scanline y (avoids notch gaps)
    let bestLeft = -1;
    let bestRight = -1;
    let curStart = -1;
    for (let x = minIX; x <= maxIX + 1; x++) {
      const pos = y * roiW + x;
      const inside = x <= maxIX && interiorMask[pos] === 1 && rawLayoutInterior[pos] === 1;
      if (inside && curStart === -1) {
        curStart = x;
      } else if (!inside && curStart !== -1) {
        if (x - 1 - curStart > bestRight - bestLeft) {
          bestLeft = curStart;
          bestRight = x - 1;
        }
        curStart = -1;
      }
    }
    if (bestLeft !== -1 && bestRight >= bestLeft) {
      rowSpans.push({
        y: roiY + y,
        leftX: roiX + bestLeft,
        rightX: roiX + bestRight,
        width: bestRight - bestLeft + 1,
      });
    }
  }

  const safeBoxPx: BoundingBox = {
    x: roiX + minIX,
    y: roiY + minIY,
    width: Math.max(1, maxIX - minIX + 1),
    height: Math.max(1, maxIY - minIY + 1),
  };

  // Compute inscribed core chamber excluding narrow top/bottom jagged spikes/tails and isolated boundary slivers
  const maxSpanWidth = rowSpans.reduce((m, s) => Math.max(m, s.width), 0);
  const coreThreshold = maxSpanWidth * 0.52;
  const rawCoreSpans = rowSpans.filter((s) => s.width >= coreThreshold);
  let activeSpans = rawCoreSpans;
  if (rawCoreSpans.length >= 2) {
    const runs: BubbleRowSpan[][] = [];
    let curRun: BubbleRowSpan[] = [rawCoreSpans[0]];
    for (let i = 1; i < rawCoreSpans.length; i++) {
      if (rawCoreSpans[i].y - rawCoreSpans[i - 1].y <= 3) {
        curRun.push(rawCoreSpans[i]);
      } else {
        runs.push(curRun);
        curRun = [rawCoreSpans[i]];
      }
    }
    runs.push(curRun);

    let bestRun = runs[0];
    let bestScore = -1;
    for (const r of runs) {
      const score = r.reduce((sum, s) => sum + s.width, 0);
      if (score > bestScore) {
        bestScore = score;
        bestRun = r;
      }
    }
    activeSpans = bestRun.length >= 4 ? bestRun : rawCoreSpans.length >= 4 ? rawCoreSpans : rowSpans;
  } else {
    activeSpans = rowSpans;
  }

  let wSum = 0;
  let wCxSum = 0;
  let wCySum = 0;
  let coreMinX = Infinity;
  let coreMaxX = -Infinity;
  let coreMinY = Infinity;
  let coreMaxY = -Infinity;

  for (const s of activeSpans) {
    const midX = (s.leftX + s.rightX) / 2;
    const weight = s.width * s.width;
    wSum += weight;
    wCxSum += midX * weight;
    wCySum += s.y * weight;
    if (s.leftX < coreMinX) coreMinX = s.leftX;
    if (s.rightX > coreMaxX) coreMaxX = s.rightX;
    if (s.y < coreMinY) coreMinY = s.y;
    if (s.y > coreMaxY) coreMaxY = s.y;
  }

  const weightedCentroid: Point =
    wSum > 0
      ? { x: wCxSum / wSum, y: wCySum / wSum }
      : { x: roiX + sumX / area, y: roiY + sumY / area };

  const coreW = Number.isFinite(coreMinX) ? Math.max(4, coreMaxX - coreMinX + 1) : safeBoxPx.width;
  const coreH = Number.isFinite(coreMinY) ? Math.max(4, coreMaxY - coreMinY + 1) : safeBoxPx.height;
  // Blend weighted Y centroid with core chamber midpoint so asymmetric ovals anchor naturally without top/bottom crowding
  const centroidPx: Point = Number.isFinite(coreMinY)
    ? {
        x: weightedCentroid.x,
        y: weightedCentroid.y * 0.35 + ((coreMinY + coreMaxY) / 2) * 0.65,
      }
    : weightedCentroid;

  // Slightly inset vertical top/bottom clearance inside core chamber so bold Arabic glyphs clear curved rims
  const vInset = Math.min(Math.floor(coreH * 0.2), Math.max(2, Math.round(coreH * 0.08)));
  const textSafeBoxPx: BoundingBox = Number.isFinite(coreMinY)
    ? {
        x: coreMinX,
        y: coreMinY + vInset,
        width: coreW,
        height: Math.max(4, coreH - vInset * 2),
      }
    : { ...safeBoxPx };

  // Confidence combines dominant background uniformity + border wall closure - perimeter leakage
  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.45 * bg.dominantFraction +
        0.45 * Math.min(1, borderCoverageRatio * 1.15) +
        0.1 * (1 - Math.min(1, perimeterEscapeRatio))
    )
  );
  const hasClosedBubble = confidence >= 0.45 && borderCoverageRatio >= 0.25;

  return {
    roiX,
    roiY,
    roiW,
    roiH,
    interiorMask,
    hasClosedBubble,
    confidence,
    lowConfidence: !hasClosedBubble,
    background: bg,
    centroidPx,
    safeBoxPx,
    textSafeBoxPx,
    rowSpans,
    contourPolygonNorm: [],
    borderCoverageRatio,
    perimeterEscapeRatio,
  };
}

/**
 * Cleans all text & shadows inside an already-segmented ROI buffer IN PLACE.
 * - When `seg.hasClosedBubble` is true: completely whitens/fills 100% of `seg.interiorMask`
 *   (or smooth radial interior blend for subtle gradients), touching ZERO pixels outside the mask.
 * - When `seg.hasClosedBubble` is false (borderless floating text): uses conservative
 *   stroke-only Telea harmonic diffusion inside `localPoly` so artwork/faces stay completely safe.
 */
export function cleanRoiBufferInPlace(
  roiData: Uint8ClampedArray,
  seg: BubbleSegmentationResult,
  engine: 'telea_biharmonic' | 'solid_interior' | 'manual_only',
  pxPoly: Point[]
): { cleanedPixelCount: number; usedFullInteriorClean: boolean } {
  if (engine === 'manual_only') {
    return { cleanedPixelCount: 0, usedFullInteriorClean: false };
  }

  const { roiW, roiH, roiX, roiY, interiorMask, background, hasClosedBubble } = seg;
  let cleanedPixelCount = 0;

  if (hasClosedBubble) {
    // Full interior whitening / solid-color restoration inside exact segmented mask
    for (let i = 0; i < interiorMask.length; i++) {
      if (interiorMask[i] === 1) {
        const p = i * 4;
        roiData[p] = background.r;
        roiData[p + 1] = background.g;
        roiData[p + 2] = background.b;
        roiData[p + 3] = 255;
        cleanedPixelCount += 1;
      }
    }
    return { cleanedPixelCount, usedFullInteriorClean: true };
  }

  // Conservative stroke-only fallback for borderless / open-background text ('outside' or low confidence)
  const localPolyRaw = pxPoly.map((p) => ({ x: p.x - roiX, y: p.y - roiY }));
  const openPad = Math.min(18, Math.max(8, Math.round(Math.min(roiW, roiH) * 0.12)));
  const localPoly = expandPolygonOutward(localPolyRaw, openPad, roiW, roiH);

  const totalPixels = roiW * roiH;
  const strokeMask = new Uint8Array(totalPixels);
  const coreRgbThresh = background.isUniform ? 26 : 36;
  const coreLumaThresh = background.isUniform ? 24 : 34;
  const haloRgbThresh = 12;
  const haloLumaThresh = 12;

  const coreQueue = new Int32Array(totalPixels);
  let cHead = 0;
  let cTail = 0;

  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (!pointInPolygon(x, y, localPoly)) continue;
      const pos = y * roiW + x;
      const idx = pos * 4;
      const r = roiData[idx];
      const g = roiData[idx + 1];
      const b = roiData[idx + 2];
      const rgbDiff =
        (Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b)) / 3;
      const pLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      const lumaDiff = Math.abs(pLuma - background.luma);
      if (rgbDiff > coreRgbThresh || lumaDiff > coreLumaThresh) {
        strokeMask[pos] = 1;
        coreQueue[cTail++] = pos;
      }
    }
  }

  // Connected-component trace: follow protruding ascenders/descenders seeded inside localPoly up to 12px into ROI margin
  const traceDist = new Int16Array(totalPixels).fill(-1);
  for (let i = 0; i < cTail; i++) traceDist[coreQueue[i]] = 0;
  while (cHead < cTail) {
    const pos = coreQueue[cHead++];
    const dist = traceDist[pos];
    if (dist >= 12) continue;
    const x = pos % roiW;
    const y = (pos - x) / roiW;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 1 || ny >= roiH - 1) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 1 || nx >= roiW - 1) continue;
        const npos = ny * roiW + nx;
        if (strokeMask[npos] === 1) continue;
        const idx = npos * 4;
        const r = roiData[idx];
        const g = roiData[idx + 1];
        const b = roiData[idx + 2];
        const rgbDiff =
          (Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b)) / 3;
        const pLuma = 0.299 * r + 0.587 * g + 0.114 * b;
        const lumaDiff = Math.abs(pLuma - background.luma);
        if (rgbDiff > coreRgbThresh || lumaDiff > coreLumaThresh) {
          strokeMask[npos] = 1;
          traceDist[npos] = pointInPolygon(nx, ny, localPoly) ? 0 : dist + 1;
          coreQueue[cTail++] = npos;
        }
      }
    }
  }

  // Hysteresis growth: absorb anti-aliased halo pixels attached to core ink strokes (including traced tips)
  const seedQueue = new Int32Array(totalPixels);
  let sHead = 0;
  let sTail = 0;
  const haloDist = new Int16Array(totalPixels).fill(-1);
  for (let i = 0; i < cTail; i++) {
    seedQueue[sTail++] = coreQueue[i];
    haloDist[coreQueue[i]] = 0;
  }
  while (sHead < sTail) {
    const pos = seedQueue[sHead++];
    const dist = haloDist[pos];
    if (dist >= 3) continue;
    const x = pos % roiW;
    const y = (pos - x) / roiW;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 1 || ny >= roiH - 1) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 1 || nx >= roiW - 1) continue;
        const npos = ny * roiW + nx;
        if (strokeMask[npos] === 1) continue;
        const idx = npos * 4;
        const r = roiData[idx];
        const g = roiData[idx + 1];
        const b = roiData[idx + 2];
        const rgbDiff =
          (Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b)) / 3;
        const pLuma = 0.299 * r + 0.587 * g + 0.114 * b;
        const lumaDiff = Math.abs(pLuma - background.luma);
        if (rgbDiff > haloRgbThresh || lumaDiff > haloLumaThresh) {
          strokeMask[npos] = 1;
          haloDist[npos] = dist + 1;
          seedQueue[sTail++] = npos;
        }
      }
    }
  }

  // 2px dilation disk to wipe residual drop-shadows and JPEG ringing around open text & traced stroke tips
  const dilated = new Uint8Array(totalPixels);
  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (strokeMask[y * roiW + x] !== 1) continue;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 1 || ny >= roiH - 1) continue;
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 3) continue;
          const nx = x + dx;
          if (nx < 1 || nx >= roiW - 1) continue;
          dilated[ny * roiW + nx] = 1;
        }
      }
    }
  }

  const known = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    known[i] = dilated[i] === 0 ? 1 : 0;
    if (dilated[i] === 1) cleanedPixelCount += 1;
  }

  const neighbors = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  const maxPasses = Math.min(36, Math.max(12, Math.ceil(Math.min(roiW, roiH) * 0.3)));

  for (let pass = 0; pass < maxPasses; pass++) {
    const newlyFilled: Array<{ pos: number; r: number; g: number; b: number }> = [];
    for (let y = 1; y < roiH - 1; y++) {
      for (let x = 1; x < roiW - 1; x++) {
        const pos = y * roiW + x;
        if (known[pos] === 1) continue;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let wSum = 0;
        for (let k = 0; k < neighbors.length; k++) {
          const npos = (y + neighbors[k][1]) * roiW + (x + neighbors[k][0]);
          if (known[npos] === 1) {
            const weight = k < 4 ? 1.0 : 0.707;
            const idx = npos * 4;
            rSum += roiData[idx] * weight;
            gSum += roiData[idx + 1] * weight;
            bSum += roiData[idx + 2] * weight;
            wSum += weight;
          }
        }
        if (wSum > 0) {
          newlyFilled.push({
            pos,
            r: Math.round(rSum / wSum),
            g: Math.round(gSum / wSum),
            b: Math.round(bSum / wSum),
          });
        }
      }
    }
    if (newlyFilled.length === 0) break;
    for (const item of newlyFilled) {
      const idx = item.pos * 4;
      roiData[idx] = item.r;
      roiData[idx + 1] = item.g;
      roiData[idx + 2] = item.b;
      roiData[idx + 3] = 255;
      known[item.pos] = 1;
    }
  }

  for (let i = 0; i < known.length; i++) {
    if (known[i] === 0) {
      const idx = i * 4;
      roiData[idx] = background.r;
      roiData[idx + 1] = background.g;
      roiData[idx + 2] = background.b;
      roiData[idx + 3] = 255;
    }
  }

  return { cleanedPixelCount, usedFullInteriorClean: false };
}

/**
 * Given a desired Y row (in full-image px) and band height, computes the safe inscribed horizontal
 * width inside the segmented balloon contour (minimum available span across the vertical slice of a text line).
 */
export function getSafeWidthAtBandY(
  seg: BubbleSegmentationResult,
  bandCenterY: number,
  bandHeight: number,
  paddingFraction = 0.08
): { leftX: number; rightX: number; width: number } {
  const clampSpan = (rawLeft: number, rawRight: number): { leftX: number; rightX: number; width: number } => {
    const rawW = Math.max(1, rawRight - rawLeft + 1);
    const pad = Math.min(rawW * 0.25, Math.max(1.5, rawW * paddingFraction));
    const leftX = rawLeft + pad;
    const rightX = Math.max(leftX, rawRight - pad);
    return {
      leftX,
      rightX,
      width: Math.max(4, rightX - leftX + 1),
    };
  };

  if (seg.rowSpans.length === 0) {
    return clampSpan(seg.safeBoxPx.x, seg.safeBoxPx.x + Math.max(1, seg.safeBoxPx.width - 1));
  }

  const y0 = Math.round(bandCenterY - bandHeight * 0.45);
  const y1 = Math.round(bandCenterY + bandHeight * 0.45);

  let minRight = Infinity;
  let maxLeft = -Infinity;
  let matched = 0;

  for (const span of seg.rowSpans) {
    if (span.y >= y0 && span.y <= y1) {
      if (span.leftX > maxLeft) maxLeft = span.leftX;
      if (span.rightX < minRight) minRight = span.rightX;
      matched += 1;
    }
  }

  if (matched === 0 || minRight <= maxLeft) {
    // Fallback to nearest span
    let nearest = seg.rowSpans[0];
    let bestD = Infinity;
    for (const span of seg.rowSpans) {
      const d = Math.abs(span.y - bandCenterY);
      if (d < bestD) {
        bestD = d;
        nearest = span;
      }
    }
    return clampSpan(nearest.leftX, nearest.rightX);
  }

  return clampSpan(maxLeft, minRight);
}

/**
 * Post-cleaning & post-layout Quality Verification Gate:
 * Audits that:
 * 1. Zero residual English ink/shadow exceeds threshold inside `seg.interiorMask` after cleaning.
 * 2. Zero pixels outside `seg.interiorMask` were modified between `beforeRoi` and `afterRoi`.
 * 3. Fitted text bounds stay strictly inside `seg.safeBoxPx` and image canvas boundaries.
 */
export function auditCleanedAndRenderedRegion(params: {
  beforeRoiData: Uint8ClampedArray;
  afterRoiData: Uint8ClampedArray;
  seg: BubbleSegmentationResult;
  imgW: number;
  imgH: number;
  textCenterPx?: Point;
  textLines?: Array<{ x?: number; y: number; width: number; height: number }>;
  overflowed?: boolean;
}): RegionQualityAudit {
  const {
    beforeRoiData,
    afterRoiData,
    seg,
    imgW,
    imgH,
    textCenterPx,
    textLines = [],
    overflowed = false,
  } = params;

  const issues: RegionQualityAudit['issues'] = [];
  if (seg.lowConfidence) {
    issues.push('low_segmentation_confidence');
  }

  let insideCount = 0;
  let residualInkCount = 0;
  let exteriorChangedPixels = 0;
  const bg = seg.background;

  for (let i = 0; i < seg.interiorMask.length; i++) {
    const p = i * 4;
    if (seg.interiorMask[i] === 1) {
      insideCount += 1;
      const dist = colorDistance(
        afterRoiData[p],
        afterRoiData[p + 1],
        afterRoiData[p + 2],
        bg.r,
        bg.g,
        bg.b
      );
      if (dist > 28) residualInkCount += 1;
    } else if (seg.hasClosedBubble) {
      const diff =
        Math.abs(afterRoiData[p] - beforeRoiData[p]) +
        Math.abs(afterRoiData[p + 1] - beforeRoiData[p + 1]) +
        Math.abs(afterRoiData[p + 2] - beforeRoiData[p + 2]);
      if (diff > 0) exteriorChangedPixels += 1;
    }
  }

  const residualInkRatio = insideCount > 0 ? residualInkCount / insideCount : 0;
  if (seg.hasClosedBubble && residualInkRatio > 0.01) {
    issues.push('residual_source_ink');
  }
  if (seg.hasClosedBubble && exteriorChangedPixels > 0) {
    issues.push('exterior_leakage');
  }

  let textOutOfBounds = false;
  if (textCenterPx && textLines.length > 0 && seg.hasClosedBubble) {
    for (const line of textLines) {
      const halfW = line.width / 2;
      const lineCenterX = line.x ?? textCenterPx.x;
      const left = lineCenterX - halfW;
      const right = lineCenterX + halfW;
      const top = line.y - line.height / 2;
      const bottom = line.y + line.height / 2;

      if (left < 0 || right > imgW || top < 0 || bottom > imgH) {
        textOutOfBounds = true;
        break;
      }

      const span = getSafeWidthAtBandY(seg, line.y, line.height, 0.01);
      if (left < span.leftX - 2 || right > span.rightX + 2) {
        textOutOfBounds = true;
        break;
      }
      const verticalBound = seg.textSafeBoxPx || seg.safeBoxPx;
      if (top < verticalBound.y - 3 || bottom > verticalBound.y + verticalBound.height + 3) {
        textOutOfBounds = true;
        break;
      }
    }
  }

  if (overflowed) issues.push('text_overflow');
  if (textOutOfBounds) issues.push('text_out_of_bounds');

  return {
    passed: issues.length === 0,
    confidence: seg.confidence,
    issues,
    residualInkRatio,
    exteriorChangedPixels,
    textOverflow: overflowed,
    textOutOfBounds,
  };
}
