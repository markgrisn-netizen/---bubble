import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditCleanedAndRenderedRegion,
  cleanRoiBufferInPlace,
  computeRegionRoiBounds,
  getSafeWidthAtBandY,
  segmentBubbleInterior,
} from './bubbleSegmentation';
import { fitTextInRegion } from './bubbleLayout';

function makeRgbaCanvas(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    buf[p] = r;
    buf[p + 1] = g;
    buf[p + 2] = b;
    buf[p + 3] = 255;
  }
  return buf;
}

function extractRoi(
  full: Uint8ClampedArray,
  fullW: number,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number
): Uint8ClampedArray {
  const roi = new Uint8ClampedArray(roiW * roiH * 4);
  for (let y = 0; y < roiH; y++) {
    for (let x = 0; x < roiW; x++) {
      const src = ((roiY + y) * fullW + (roiX + x)) * 4;
      const dst = (y * roiW + x) * 4;
      roi[dst] = full[src];
      roi[dst + 1] = full[src + 1];
      roi[dst + 2] = full[src + 2];
      roi[dst + 3] = full[src + 3];
    }
  }
  return roi;
}

test('oval white speech bubble with tail over colorful artwork cleans 100% of interior ink and changes 0px outside border', () => {
  const W = 220;
  const H = 200;
  // Vivid crimson character art background outside the balloon
  const full = makeRgbaCanvas(W, H, 210, 48, 52);

  const cx = 110;
  const cy = 85;
  const rx = 56;
  const ry = 36;

  // Draw black border + white interior + narrow tail pointing down-right
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const inTail =
        y >= cy + ry - 4 &&
        y <= cy + ry + 34 &&
        x >= cx + 10 + (y - (cy + ry)) * 0.45 &&
        x <= cx + 22 + (y - (cy + ry)) * 0.28;
      const inTailBorder =
        y >= cy + ry - 5 &&
        y <= cy + ry + 36 &&
        x >= cx + 7 + (y - (cy + ry)) * 0.45 &&
        x <= cx + 25 + (y - (cy + ry)) * 0.28;

      const p = (y * W + x) * 4;
      if (d <= 0.86 || inTail) {
        full[p] = 254;
        full[p + 1] = 254;
        full[p + 2] = 254;
      } else if (d <= 1.06 || inTailBorder) {
        full[p] = 12;
        full[p + 1] = 12;
        full[p + 2] = 12;
      }
    }
  }

  // Draw dark English glyph clusters + enclosed counter ('O' ring) + drop shadow inside balloon
  for (let y = 72; y <= 98; y++) {
    for (let x = 80; x <= 140; x++) {
      const isLetterBar = (x >= 84 && x <= 90) || (x >= 102 && x <= 122 && (y <= 77 || y >= 93 || x <= 107 || x >= 117));
      const isShadow = x >= 128 && x <= 135 && y >= 76 && y <= 94;
      if (isLetterBar || isShadow) {
        const p = (y * W + x) * 4;
        full[p] = isShadow ? 120 : 18;
        full[p + 1] = isShadow ? 120 : 18;
        full[p + 2] = isShadow ? 120 : 18;
      }
    }
  }

  // OCR box slightly tight around the English text
  const region = {
    regionType: 'dialogue' as const,
    boundingBox: {
      x: (76 / W) * 1000,
      y: (66 / H) * 1000,
      width: (70 / W) * 1000,
      height: (38 / H) * 1000,
    },
    boundingPolygon: [],
  };

  const bounds = computeRegionRoiBounds(region, W, H);
  const roi = extractRoi(full, W, bounds.roiX, bounds.roiY, bounds.roiW, bounds.roiH);
  const before = new Uint8ClampedArray(roi);

  const seg = segmentBubbleInterior(
    roi,
    bounds.roiW,
    bounds.roiH,
    bounds.roiX,
    bounds.roiY,
    'dialogue',
    bounds.localBoxPx,
    bounds.pxPoly
  );

  assert.equal(seg.hasClosedBubble, true);
  assert.ok(seg.confidence >= 0.6, `Expected high confidence, got ${seg.confidence}`);
  // Visual centroid should remain centered inside main balloon oval, NOT pulled down into tail
  assert.ok(Math.abs(seg.centroidPx.x - cx) < 6, `Centroid X shifted: ${seg.centroidPx.x} vs ${cx}`);
  assert.ok(Math.abs(seg.centroidPx.y - cy) < 6, `Centroid Y shifted: ${seg.centroidPx.y} vs ${cy}`);

  const cleanStats = cleanRoiBufferInPlace(roi, seg, 'telea_biharmonic', bounds.pxPoly);
  assert.equal(cleanStats.usedFullInteriorClean, true);

  const audit = auditCleanedAndRenderedRegion({
    beforeRoiData: before,
    afterRoiData: roi,
    seg,
    imgW: W,
    imgH: H,
  });

  assert.equal(audit.residualInkRatio, 0, 'Interior must be 100% whitened with 0 residual strokes');
  assert.equal(audit.exteriorChangedPixels, 0, 'Border, tail, and exterior artwork must have 0px altered');
  assert.equal(audit.passed, true);

  // Contour-aligned band width at center should exceed narrow top/bottom bands
  const midSpan = getSafeWidthAtBandY(seg, cy, 12);
  const topSpan = getSafeWidthAtBandY(seg, cy - 24, 12);
  assert.ok(midSpan.width > topSpan.width, `Expected midSpan (${midSpan.width}) > topSpan (${topSpan.width})`);
});

test('dark noir caption box cleans white lettering uniformly without bleaching outer border', () => {
  const W = 180;
  const H = 120;
  const full = makeRgbaCanvas(W, H, 180, 190, 200);

  // Black box border + dark charcoal fill (#202226)
  for (let y = 20; y <= 100; y++) {
    for (let x = 20; x <= 160; x++) {
      const p = (y * W + x) * 4;
      const isBorder = x <= 23 || x >= 157 || y <= 23 || y >= 97;
      full[p] = isBorder ? 245 : 32;
      full[p + 1] = isBorder ? 245 : 34;
      full[p + 2] = isBorder ? 245 : 38;
    }
  }
  // White lettering inside dark box
  for (let y = 48; y <= 72; y++) {
    for (let x = 45; x <= 135; x += 6) {
      const p = (y * W + x) * 4;
      full[p] = 252;
      full[p + 1] = 252;
      full[p + 2] = 252;
    }
  }

  const region = {
    regionType: 'narration' as const,
    boundingBox: {
      x: (32 / W) * 1000,
      y: (32 / H) * 1000,
      width: (116 / W) * 1000,
      height: (56 / H) * 1000,
    },
    boundingPolygon: [],
  };

  const bounds = computeRegionRoiBounds(region, W, H);
  const roi = extractRoi(full, W, bounds.roiX, bounds.roiY, bounds.roiW, bounds.roiH);
  const before = new Uint8ClampedArray(roi);

  const seg = segmentBubbleInterior(
    roi,
    bounds.roiW,
    bounds.roiH,
    bounds.roiX,
    bounds.roiY,
    'narration',
    bounds.localBoxPx,
    bounds.pxPoly
  );
  assert.equal(seg.hasClosedBubble, true);
  assert.equal(seg.background.isDark, true);

  cleanRoiBufferInPlace(roi, seg, 'telea_biharmonic', bounds.pxPoly);
  const audit = auditCleanedAndRenderedRegion({
    beforeRoiData: before,
    afterRoiData: roi,
    seg,
    imgW: W,
    imgH: H,
  });
  assert.equal(audit.residualInkRatio, 0);
  assert.equal(audit.exteriorChangedPixels, 0);
});

test('borderless outside region does NOT stamp a white block and preserves scene pixels', () => {
  const W = 160;
  const H = 120;
  // Textured blue/green background scene
  const full = makeRgbaCanvas(W, H, 65, 135, 175);
  for (let y = 46; y <= 66; y++) {
    for (let x = 44; x <= 110; x += 5) {
      const p = (y * W + x) * 4;
      full[p] = 250;
      full[p + 1] = 240;
      full[p + 2] = 20;
    }
  }

  const region = {
    regionType: 'outside' as const,
    boundingBox: {
      x: (40 / W) * 1000,
      y: (42 / H) * 1000,
      width: (80 / W) * 1000,
      height: (30 / H) * 1000,
    },
    boundingPolygon: [],
  };
  const bounds = computeRegionRoiBounds(region, W, H);
  const roi = extractRoi(full, W, bounds.roiX, bounds.roiY, bounds.roiW, bounds.roiH);
  const seg = segmentBubbleInterior(
    roi,
    bounds.roiW,
    bounds.roiH,
    bounds.roiX,
    bounds.roiY,
    'outside',
    bounds.localBoxPx,
    bounds.pxPoly
  );
  assert.equal(seg.hasClosedBubble, false);
  assert.equal(seg.lowConfidence, true);

  const cleanStats = cleanRoiBufferInPlace(roi, seg, 'telea_biharmonic', bounds.pxPoly);
  assert.equal(cleanStats.usedFullInteriorClean, false);
});

test('fitTextInRegion wraps against narrow contour bands and shrinks gracefully without overflow', () => {
  const mockMeasure = (str: string, size: number) => str.length * size * 0.56;
  const res = fitTextInRegion(
    'مرحباً أيها الصديق كيف حالك اليوم في المدينة الجديدة',
    180,
    130,
    { fontSize: 20, lineHeight: 1.35, padding: 10, autoFit: true, align: 'center' },
    mockMeasure,
    (idx, total) => (idx === 0 || idx === total - 1 ? 88 : 138)
  );
  assert.ok(res.fontSize >= 11 && res.fontSize <= 20);
  assert.equal(res.overflowed, false);
  assert.ok(res.lines.length >= 2);
});

test('jagged dark starburst bubble excludes top/bottom spikes from textSafeBoxPx while cleaning 100% of interior', () => {
  const W = 220;
  const H = 180;
  const full = makeRgbaCanvas(W, H, 240, 240, 240);
  const cx = 110;
  const cy = 90;

  // Draw black interior with sharp white jagged teeth protruding inward/outward at top & bottom
  for (let y = 26; y <= 154; y++) {
    for (let x = 34; x <= 186; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      // Central broad chamber (y: 52..128) + narrow pointed top/bottom horns (y: 30..52 and 128..150)
      const inBroadChamber = dy <= 38 && dx <= 64 * Math.sqrt(Math.max(0, 1 - (dy / 46) ** 2));
      const inTopSpike = y >= 28 && y < 56 && dx <= Math.max(2, (y - 26) * 0.45);
      const inBottomSpike = y > 124 && y <= 152 && dx <= Math.max(2, (154 - y) * 0.45);
      if (inBroadChamber || inTopSpike || inBottomSpike) {
        const p = (y * W + x) * 4;
        full[p] = 16;
        full[p + 1] = 16;
        full[p + 2] = 16;
      }
    }
  }
  // White English lettering inside dark chamber
  for (let y = 76; y <= 104; y++) {
    for (let x = 70; x <= 150; x += 6) {
      const p = (y * W + x) * 4;
      full[p] = 250;
      full[p + 1] = 250;
      full[p + 2] = 250;
    }
  }

  const region = {
    regionType: 'dialogue' as const,
    boundingBox: {
      x: (52 / W) * 1000,
      y: (52 / H) * 1000,
      width: (116 / W) * 1000,
      height: (76 / H) * 1000,
    },
    boundingPolygon: [],
  };
  const bounds = computeRegionRoiBounds(region, W, H);
  const roi = extractRoi(full, W, bounds.roiX, bounds.roiY, bounds.roiW, bounds.roiH);
  const before = new Uint8ClampedArray(roi);

  const seg = segmentBubbleInterior(
    roi,
    bounds.roiW,
    bounds.roiH,
    bounds.roiX,
    bounds.roiY,
    'dialogue',
    bounds.localBoxPx,
    bounds.pxPoly
  );

  assert.equal(seg.hasClosedBubble, true);
  assert.equal(seg.background.isDark, true);
  // textSafeBoxPx must be strictly smaller vertically than full safeBoxPx (excluding top/bottom spikes)
  assert.ok(seg.textSafeBoxPx.height < seg.safeBoxPx.height);
  assert.ok(seg.textSafeBoxPx.y > seg.safeBoxPx.y);
  assert.ok(Math.abs(seg.centroidPx.x - cx) < 5);
  assert.ok(Math.abs(seg.centroidPx.y - cy) < 5);

  cleanRoiBufferInPlace(roi, seg, 'telea_biharmonic', bounds.pxPoly);
  const audit = auditCleanedAndRenderedRegion({
    beforeRoiData: before,
    afterRoiData: roi,
    seg,
    imgW: W,
    imgH: H,
  });
  assert.equal(audit.residualInkRatio, 0);
  assert.equal(audit.exteriorChangedPixels, 0);
});
