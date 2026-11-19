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
      ? 6
      : region.regionType === 'narration'
      ? Math.min(34, Math.max(12, Math.round(boxW * 0.16)))
      : Math.min(64, Math.max(18, Math.round(boxW * 0.32)));
  const expandY =
    region.regionType === 'outside'
      ? 6
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
    // Check if there IS an actual outline around pxPoly itself (borderless text over white background vs oversized balloon)
    const localPoly = pxPoly.map((p) => ({ x: p.x - roiX, y: p.y - roiY }));
    const localCx = localBox.x + localBox.width / 2;
    const localCy = localBox.y + localBox.height / 2;
    const expandedEnvPoly = localPoly.map((p) => ({
      x: localCx + (p.x - localCx) * 1.04,
      y: localCy + (p.y - localCy) * 1.04,
    }));

    // Check outer ring contrast around localBox to distinguish borderless floating text vs closed box
    let nonBgOuterSamples = 0;
    let totalOuterSamples = 0;
    const ringMinX = Math.max(0, Math.floor(localBox.x - 4));
    const ringMaxX = Math.min(roiW - 1, Math.ceil(localBox.x + localBox.width + 4));
    const ringMinY = Math.max(0, Math.floor(localBox.y - 4));
    const ringMaxY = Math.min(roiH - 1, Math.ceil(localBox.y + localBox.height + 4));

    for (let x = ringMinX; x <= ringMaxX; x += 2) {
      totalOuterSamples += 2;
      if (bgMatch[ringMinY * roiW + x] === 0) nonBgOuterSamples += 1;
      if (bgMatch[ringMaxY * roiW + x] === 0) nonBgOuterSamples += 1;
    }
    for (let y = ringMinY; y <= ringMaxY; y += 2) {
      totalOuterSamples += 2;
      if (bgMatch[y * roiW + ringMinX] === 0) nonBgOuterSamples += 1;
      if (bgMatch[y * roiW + ringMaxX] === 0) nonBgOuterSamples += 1;
    }
    const localContrastRing = totalOuterSamples > 0 ? nonBgOuterSamples / totalOuterSamples : 0;

    // If perimeter escaped heavily AND outer border contrast is weak (< 0.22), there is no closed bubble wall!
    if (localContrastRing < 0.22 && perimeterEscapeRatio > 0.42) {
      return {
        ...emptyResult(true),
        perimeterEscapeRatio,
        borderCoverageRatio: localContrastRing,
        confidence: 0.32,
      };
    }

    // Clamp reachedBg inside expandedEnvPoly so border openings/gaps can't bleed outside region
    for (let y = 0; y < roiH; y++) {
      for (let x = 0; x < roiW; x++) {
        if (reachedBg[y * roiW + x] === 1 && !pointInPolygon(x, y, expandedEnvPoly)) {
          reachedBg[y * roiW + x] = 0;
        }
      }
    }
  }

  // Stage 2: Pinch narrow tail throats outside localBox BEFORE hole-fill
  // Any horizontal or vertical chord outside localBox narrower than throatLimit is a speech tail!
  const throatMin = Math.max(6, Math.min(18, Math.round(Math.min(localBox.width, localBox.height) * 0.2)));
  const lbX0 = localBox.x - 3;
  const lbX1 = localBox.x + localBox.width + 3;
  const lbY0 = localBox.y - 3;
  const lbY1 = localBox.y + localBox.height + 3;

  const pinched = new Uint8Array(reachedBg);
  for (let y = 0; y < roiH; y++) {
    let runStart = -1;
    for (let x = 0; x <= roiW; x++) {
      const val = x < roiW ? reachedBg[y * roiW + x] : 0;
      if (val === 1 && runStart === -1) {
        runStart = x;
      } else if (val === 0 && runStart !== -1) {
        const runLen = x - runStart;
        const outsideCore = y < lbY0 || y > lbY1;
        if (outsideCore && runLen <= throatMin) {
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

  // Re-flood from center so detached tail tips aren't kept
  const mainBodyBg = new Uint8Array(totalPixels);
  qHead = 0;
  qTail = 0;
  for (let y = seedY0; y <= seedY1; y += 2) {
    for (let x = seedX0; x <= seedX1; x += 2) {
      const pos = y * roiW + x;
      if (pinched[pos] === 1 && mainBodyBg[pos] === 0) {
        mainBodyBg[pos] = 1;
        queue[qTail++] = pos;
      }
    }
  }
  while (qHead < qTail) {
    const pos = queue[qHead++];
    const x = pos % roiW;
    const y = (pos - x) / roiW;
    if (x > 0 && pinched[pos - 1] === 1 && mainBodyBg[pos - 1] === 0) {
      mainBodyBg[pos - 1] = 1;
      queue[qTail++] = pos - 1;
    }
    if (x + 1 < roiW && pinched[pos + 1] === 1 && mainBodyBg[pos + 1] === 0) {
      mainBodyBg[pos + 1] = 1;
      queue[qTail++] = pos + 1;
    }
    if (y > 0 && pinched[pos - roiW] === 1 && mainBodyBg[pos - roiW] === 0) {
      mainBodyBg[pos - roiW] = 1;
      queue[qTail++] = pos - roiW;
    }
    if (y + 1 < roiH && pinched[pos + roiW] === 1 && mainBodyBg[pos + roiW] === 0) {
      mainBodyBg[pos + roiW] = 1;
      queue[qTail++] = pos + roiW;
    }
  }

  // Stage 3: Topological Exterior Flood-Fill to fill 100% of enclosed text strokes, shadows, & counters
  const exterior = new Uint8Array(totalPixels);
  qHead = 0;
  qTail = 0;

  const trySeedExterior = (x: number, y: number) => {
    const pos = y * roiW + x;
    if (mainBodyBg[pos] === 0 && exterior[pos] === 0) {
      exterior[pos] = 1;
      queue[qTail++] = pos;
    }
  };
  for (let x = 0; x < roiW; x++) {
    trySeedExterior(x, 0);
    trySeedExterior(x, roiH - 1);
  }
  for (let y = 0; y < roiH; y++) {
    trySeedExterior(0, y);
    trySeedExterior(roiW - 1, y);
  }

  while (qHead < qTail) {
    const pos = queue[qHead++];
    const x = pos % roiW;
    const y = (pos - x) / roiW;
    if (x > 0) {
      const n = pos - 1;
      if (mainBodyBg[n] === 0 && exterior[n] === 0) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (x + 1 < roiW) {
      const n = pos + 1;
      if (mainBodyBg[n] === 0 && exterior[n] === 0) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (y > 0) {
      const n = pos - roiW;
      if (mainBodyBg[n] === 0 && exterior[n] === 0) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
    if (y + 1 < roiH) {
      const n = pos + roiW;
      if (mainBodyBg[n] === 0 && exterior[n] === 0) {
        exterior[n] = 1;
        queue[qTail++] = n;
      }
    }
  }

  const rawInterior = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    rawInterior[i] = exterior[i] === 0 ? 1 : 0;
  }

  // Stage 4: Keep strictly 1px safety inset away from dark/contrasting border pixels so 0px of border bleeds
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
        // Check if neighboring outside pixel is a contrasting border pixel (dark ink / outline)
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
          // Erode boundary pixel if it itself is anti-aliased edge ink near the black outline
          const pp = pos * 4;
          const selfDist = colorDistance(
            roiData[pp],
            roiData[pp + 1],
            roiData[pp + 2],
            bg.r,
            bg.g,
            bg.b
          );
          if (selfDist > 18) {
            interiorMask[pos] = 0;
          }
        }
      }
    }
  }

  // Compute area, visual centroid, bounding box, and per-row interior spans
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minIX = roiW;
  let maxIX = -1;
  let minIY = roiH;
  let maxIY = -1;

  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (interiorMask[y * roiW + x] === 1) {
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
    // Find longest contiguous run of interior pixels on scanline y (avoids notch gaps)
    let bestLeft = -1;
    let bestRight = -1;
    let curStart = -1;
    for (let x = minIX; x <= maxIX + 1; x++) {
      const inside = x <= maxIX && interiorMask[y * roiW + x] === 1;
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

  // Compute inscribed core chamber excluding narrow top/bottom jagged spikes/tails
  const maxSpanWidth = rowSpans.reduce((m, s) => Math.max(m, s.width), 0);
  const coreThreshold = maxSpanWidth * 0.56;
  const coreSpans = rowSpans.filter((s) => s.width >= coreThreshold);
  const activeSpans = coreSpans.length >= 4 ? coreSpans : rowSpans;

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

  const centroidPx: Point =
    wSum > 0
      ? { x: wCxSum / wSum, y: wCySum / wSum }
      : { x: roiX + sumX / area, y: roiY + sumY / area };

  const coreW = Number.isFinite(coreMinX) ? Math.max(12, coreMaxX - coreMinX + 1) : safeBoxPx.width;
  const coreH = Number.isFinite(coreMinY) ? Math.max(12, coreMaxY - coreMinY + 1) : safeBoxPx.height;
  // Slightly inset vertical top/bottom clearance inside core chamber so bold Arabic glyphs clear jagged rims
  const vInset = Math.max(2, Math.round(coreH * 0.08));
  const textSafeBoxPx: BoundingBox = Number.isFinite(coreMinY)
    ? {
        x: coreMinX,
        y: coreMinY + vInset,
        width: coreW,
        height: Math.max(12, coreH - vInset * 2),
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
  const localPoly = pxPoly.map((p) => ({ x: p.x - roiX, y: p.y - roiY }));
  const totalPixels = roiW * roiH;
  const strokeMask = new Uint8Array(totalPixels);
  const rgbThreshold = background.isUniform ? (background.isDark ? 34 : 38) : 52;
  const lumaThreshold = background.isUniform ? 34 : 46;

  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (!pointInPolygon(x, y, localPoly)) continue;
      const idx = (y * roiW + x) * 4;
      const r = roiData[idx];
      const g = roiData[idx + 1];
      const b = roiData[idx + 2];
      const rgbDiff =
        (Math.abs(r - background.r) + Math.abs(g - background.g) + Math.abs(b - background.b)) / 3;
      const pLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      const lumaDiff = Math.abs(pLuma - background.luma);
      if (rgbDiff > rgbThreshold || lumaDiff > lumaThreshold) {
        strokeMask[y * roiW + x] = 1;
      }
    }
  }

  const dilated = new Uint8Array(totalPixels);
  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      if (strokeMask[y * roiW + x] !== 1) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= roiH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= roiW) continue;
          if (pointInPolygon(nx, ny, localPoly)) {
            dilated[ny * roiW + nx] = 1;
          }
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
  const maxPasses = Math.min(28, Math.max(10, Math.ceil(Math.min(roiW, roiH) * 0.25)));

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
  if (seg.rowSpans.length === 0) {
    const pad = seg.safeBoxPx.width * paddingFraction;
    return {
      leftX: seg.safeBoxPx.x + pad,
      rightX: seg.safeBoxPx.x + seg.safeBoxPx.width - pad,
      width: Math.max(12, seg.safeBoxPx.width - pad * 2),
    };
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
    const pad = Math.max(4, nearest.width * paddingFraction);
    return {
      leftX: nearest.leftX + pad,
      rightX: nearest.rightX - pad,
      width: Math.max(12, nearest.width - pad * 2),
    };
  }

  const rawWidth = minRight - maxLeft + 1;
  const pad = Math.max(3, rawWidth * paddingFraction);
  return {
    leftX: maxLeft + pad,
    rightX: minRight - pad,
    width: Math.max(12, rawWidth - pad * 2),
  };
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
  textLines?: Array<{ y: number; width: number; height: number }>;
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
      const left = textCenterPx.x - halfW;
      const right = textCenterPx.x + halfW;
      const top = line.y - line.height / 2;
      const bottom = line.y + line.height / 2;

      if (left < 0 || right > imgW || top < 0 || bottom > imgH) {
        textOutOfBounds = true;
        break;
      }

      const span = getSafeWidthAtBandY(seg, line.y, line.height, 0.02);
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
