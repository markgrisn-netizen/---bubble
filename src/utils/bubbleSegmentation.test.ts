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

test('narrow vertical manga bubble & tiny oval do not inflate getSafeWidthAtBandY and audit catches per-line x shifts', () => {
  const W = 120;
  const H = 220;
  const full = makeRgbaCanvas(W, H, 180, 180, 180);

  // Draw a narrow vertical manga oval (rx=16 -> ~30px wide interior, ry=75 -> 150px tall)
  const cx = 60;
  const cy = 110;
  const rx = 16;
  const ry = 75;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const p = (y * W + x) * 4;
      if (d <= 0.85) {
        full[p] = 255;
        full[p + 1] = 255;
        full[p + 2] = 255;
      } else if (d <= 1.08) {
        full[p] = 15;
        full[p + 1] = 15;
        full[p + 2] = 15;
      }
    }
  }

  const region = {
    regionType: 'dialogue' as const,
    boundingBox: {
      x: (44 / W) * 1000,
      y: (40 / H) * 1000,
      width: (32 / W) * 1000,
      height: (140 / H) * 1000,
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
  // Near top rim, true interior is < 14px wide; getSafeWidthAtBandY must return width <= rightX - leftX + 1
  const tipSpan = getSafeWidthAtBandY(seg, cy - 64, 10, 0.08);
  assert.ok(tipSpan.width <= tipSpan.rightX - tipSpan.leftX + 1.01);
  assert.ok(tipSpan.width < 20, `Expected narrow top span (<20px), got ${tipSpan.width}`);

  cleanRoiBufferInPlace(roi, seg, 'telea_biharmonic', bounds.pxPoly);

  // Passing an out-of-bounds shifted line X should trigger text_out_of_bounds
  const badAudit = auditCleanedAndRenderedRegion({
    beforeRoiData: before,
    afterRoiData: roi,
    seg,
    imgW: W,
    imgH: H,
    textCenterPx: seg.centroidPx,
    textLines: [{ x: cx + 18, y: cy, width: 16, height: 10 }],
    overflowed: false,
  });
  assert.equal(badAudit.textOutOfBounds, true);
  assert.ok(badAudit.issues.includes('text_out_of_bounds'));

  // Properly centered narrow line inside span passes cleanly
  const okAudit = auditCleanedAndRenderedRegion({
    beforeRoiData: before,
    afterRoiData: roi,
    seg,
    imgW: W,
    imgH: H,
    textCenterPx: seg.centroidPx,
    textLines: [{ x: cx, y: cy, width: 18, height: 12 }],
    overflowed: false,
  });
  assert.equal(okAudit.textOutOfBounds, false);
  assert.equal(okAudit.passed, true);
});

test('dark jagged starburst with top white border neck excludes isolated top sliver from core textSafeBoxPx', () => {
  const W = 260;
  const H = 260;
  // Simulate dark outer night sky around a white-outlined dark starburst with a thin dark gutter sliver above a narrow spike neck
  const full = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    full[i * 4] = 8;
    full[i * 4 + 1] = 8;
    full[i * 4 + 2] = 10;
    full[i * 4 + 3] = 255;
  }
  const paintRect = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        const p = (y * W + x) * 4;
        full[p] = r;
        full[p + 1] = g;
        full[p + 2] = b;
      }
    }
  };
  // White starburst perimeter enclosing dark main chamber (y: 95..190) plus narrow top spike (y: 65..94) and isolated 3px sliver (y: 58..60)
  paintRect(40, 54, 220, 195, 250, 250, 250);
  paintRect(44, 58, 216, 60, 8, 8, 10); // isolated 3px sliver inside outer white rim
  paintRect(115, 65, 145, 95, 8, 8, 10); // narrow 31px top spike neck
  paintRect(50, 96, 210, 188, 8, 8, 10); // true wide dark chamber

  const region = {
    regionType: 'dialogue' as const,
    boundingBox: {
      x: (42 / W) * 1000,
      y: (56 / H) * 1000,
      width: (176 / W) * 1000,
      height: (136 / H) * 1000,
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
    'dialogue',
    bounds.localBoxPx,
    bounds.pxPoly
  );

  assert.equal(seg.hasClosedBubble, true);
  // textSafeBoxPx must anchor inside the true main chamber (y >= 95), never dragged up to y=58 by the 3px sliver
  assert.ok(
    seg.textSafeBoxPx.y >= 94,
    `Expected textSafeBoxPx.y >= 94 (inside main chamber), got ${seg.textSafeBoxPx.y}`
  );
});

test('letters and punctuation touching top & bottom inner rims of light and dark bubbles are 100% cleaned while keeping border ink intact', () => {
  // Light oval bubble where dark letters touch inner top & bottom rim
  {
    const W = 200;
    const H = 160;
    const full = makeRgbaCanvas(W, H, 70, 110, 160);
    const cx = 100;
    const cy = 80;
    const rx = 55;
    const ry = 42;

    const borderPixels: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        const p = (y * W + x) * 4;
        if (d <= 0.85) {
          full[p] = 253;
          full[p + 1] = 253;
          full[p + 2] = 253;
        } else if (d <= 1.08) {
          full[p] = 10;
          full[p + 1] = 10;
          full[p + 2] = 10;
          borderPixels.push(p);
        }
      }
    }

    // Draw dark vertical strokes + anti-aliased gray halo touching top inner border (y=42..47) and bottom inner border (y=112..118)
    const inkCoords: Array<[number, number, number]> = [];
    for (let y = 42; y <= 55; y++) {
      for (let x = 96; x <= 104; x++) {
        const isHalo = x === 96 || x === 104;
        inkCoords.push([x, y, isHalo ? 185 : 15]);
      }
    }
    for (let y = 106; y <= 118; y++) {
      for (let x = 96; x <= 104; x++) {
        const isHalo = x === 96 || x === 104;
        inkCoords.push([x, y, isHalo ? 185 : 15]);
      }
    }
    for (const [x, y, val] of inkCoords) {
      const p = (y * W + x) * 4;
      full[p] = val;
      full[p + 1] = val;
      full[p + 2] = val;
    }

    const region = {
      regionType: 'dialogue' as const,
      boundingBox: {
        x: (70 / W) * 1000,
        y: (42 / H) * 1000,
        width: (60 / W) * 1000,
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

    // Every inked letter & halo pixel inside the interior must be cleaned near white (>240)
    for (const [x, y] of inkCoords) {
      const lx = x - bounds.roiX;
      const ly = y - bounds.roiY;
      const p = (ly * bounds.roiW + lx) * 4;
      assert.ok(roi[p] > 240, `Residual dark pixel left at (${x}, ${y}): rgb=${roi[p]}`);
    }

    // Outer border ink pixels inside ROI must remain dark (<40)
    for (const pFull of borderPixels) {
      const px = (pFull / 4) % W;
      const py = Math.floor(pFull / 4 / W);
      if (px >= bounds.roiX && px < bounds.roiX + bounds.roiW && py >= bounds.roiY && py < bounds.roiY + bounds.roiH) {
        const d = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
        if (d >= 0.94) {
          const pRoi = ((py - bounds.roiY) * bounds.roiW + (px - bounds.roiX)) * 4;
          assert.ok(roi[pRoi] < 40, `Border pixel damaged at (${px}, ${py}): rgb=${roi[pRoi]}`);
        }
      }
    }
  }

  // Dark bubble with white letters touching top/bottom rim
  {
    const W = 180;
    const H = 140;
    const full = makeRgbaCanvas(W, H, 230, 230, 230);
    for (let y = 25; y <= 115; y++) {
      for (let x = 35; x <= 145; x++) {
        const p = (y * W + x) * 4;
        const isBorder = x <= 38 || x >= 142 || y <= 28 || y >= 112;
        full[p] = isBorder ? 245 : 22;
        full[p + 1] = isBorder ? 245 : 24;
        full[p + 2] = isBorder ? 245 : 28;
      }
    }
    // White lettering touching top & bottom inner border (y=29..36 and y=104..111)
    for (let x = 86; x <= 90; x++) {
      for (let y = 29; y <= 38; y++) {
        const p = (y * W + x) * 4;
        full[p] = 250;
        full[p + 1] = 250;
        full[p + 2] = 250;
      }
      for (let y = 102; y <= 111; y++) {
        const p = (y * W + x) * 4;
        full[p] = 250;
        full[p + 1] = 250;
        full[p + 2] = 250;
      }
    }

    const region = {
      regionType: 'dialogue' as const,
      boundingBox: {
        x: (50 / W) * 1000,
        y: (30 / H) * 1000,
        width: (80 / W) * 1000,
        height: (80 / H) * 1000,
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

    // Check top & bottom border-touching white stroke pixels are dark again (<50)
    for (const checkY of [30, 110]) {
      const p = ((checkY - bounds.roiY) * bounds.roiW + (88 - bounds.roiX)) * 4;
      assert.ok(roi[p] < 50, `Expected white stroke at y=${checkY} cleaned, got ${roi[p]}`);
    }
  }
});

test('partially open outline (perimEsc > 0.26) with clipped OCR box cleans exclamation marks extending below localBox', () => {
  const W = 220;
  const H = 220;
  // White manga page outside open bubble edge
  const full = makeRgbaCanvas(W, H, 252, 252, 252);

  // Draw black bubble walls on left, right, and top, leaving an open gap at the bottom/sides (>26% perimeter escape)
  for (let y = 30; y <= 180; y++) {
    for (let x = 50; x <= 170; x++) {
      const isTopArc = y <= 34 && x >= 60 && x <= 160;
      const isLeftWall = x >= 50 && x <= 54 && y >= 32 && y <= 155;
      const isRightWall = x >= 166 && x <= 170 && y >= 32 && y <= 155;
      if (isTopArc || isLeftWall || isRightWall) {
        const p = (y * W + x) * 4;
        full[p] = 12;
        full[p + 1] = 12;
        full[p + 2] = 12;
      }
    }
  }

  // Draw '!!' dots at y=160..168, BELOW a tight OCR localBox ending at y=156
  for (let y = 160; y <= 167; y++) {
    for (let x = 104; x <= 116; x++) {
      if (x <= 108 || x >= 112) {
        const p = (y * W + x) * 4;
        full[p] = 14;
        full[p + 1] = 14;
        full[p + 2] = 14;
      }
    }
  }

  const region = {
    regionType: 'dialogue' as const,
    boundingBox: {
      x: (60 / W) * 1000,
      y: (42 / H) * 1000,
      width: (100 / W) * 1000,
      height: (114 / H) * 1000, // ends at y=156, clipping the !! dots at y=160..167
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
  assert.ok(seg.perimeterEscapeRatio > 0.26, `Expected open perimeter escape > 0.26, got ${seg.perimeterEscapeRatio}`);

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

  // Confirm the !! dots at y=163 (below localBox y=156) were completely whitened
  for (const checkX of [106, 114]) {
    const p = ((163 - bounds.roiY) * bounds.roiW + (checkX - bounds.roiX)) * 4;
    assert.ok(roi[p] > 240, `Exclamation mark dot at (${checkX}, 163) left uncleaned: ${roi[p]}`);
  }
  // Confirm side outline wall at x=52, y=100 remained black (<30)
  const pWall = ((100 - bounds.roiY) * bounds.roiW + (52 - bounds.roiX)) * 4;
  assert.ok(roi[pWall] < 30, `Left wall outline damaged: ${roi[pWall]}`);
});

test('borderless outside region wipes clipped ascender/descender tips and soft gray halos within openPad without touching exterior scene', () => {
  const W = 180;
  const H = 140;
  // Light sky-blue background
  const full = makeRgbaCanvas(W, H, 180, 210, 235);

  // Clipped ascender tip at y=41..46 (just above OCR box y=45) and descender at y=84..89 (just below OCR box y=85) + gray halo
  for (let y = 41; y <= 89; y++) {
    for (let x = 86; x <= 94; x++) {
      const isCore = x >= 88 && x <= 92;
      const p = (y * W + x) * 4;
      full[p] = isCore ? 20 : 150;
      full[p + 1] = isCore ? 20 : 180;
      full[p + 2] = isCore ? 25 : 205;
    }
  }
  // Distant scene landmark well outside openPad (e.g. y=18) must remain untouched
  for (let x = 80; x <= 100; x++) {
    const p = (18 * W + x) * 4;
    full[p] = 240;
    full[p + 1] = 60;
    full[p + 2] = 60;
  }

  const region = {
    regionType: 'outside' as const,
    boundingBox: {
      x: (50 / W) * 1000,
      y: (45 / H) * 1000,
      width: (80 / W) * 1000,
      height: (40 / H) * 1000, // y: 45..85
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

  cleanRoiBufferInPlace(roi, seg, 'telea_biharmonic', bounds.pxPoly);

  // Clipped ascender at y=42 and descender at y=88 should be restored close to sky-blue (r~180, g~210, b~235)
  for (const checkY of [42, 88]) {
    const p = ((checkY - bounds.roiY) * bounds.roiW + (90 - bounds.roiX)) * 4;
    assert.ok(
      Math.abs(roi[p] - 180) < 25 && Math.abs(roi[p + 2] - 235) < 25,
      `Clipped stroke at y=${checkY} not cleaned cleanly: rgb(${roi[p]},${roi[p + 1]},${roi[p + 2]})`
    );
  }
});


