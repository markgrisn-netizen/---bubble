import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAlignedAnchorOffsetX,
  computeContainRect,
  computeOpticalCenterOffsetX,
  computeRegionCenterNormalized,
  displayClientToNormalized,
  displayDeltaToNormalized,
  imagePxToNormalizedPoint,
  normalizedBoxToDisplayPx,
  normalizedBoxToImagePx,
  normalizedPointToDisplayPx,
  normalizedPointToImagePx,
} from './coordinateTransform';
import { computeNaturalFitSize } from './canvasViewport';

test('computeContainRect handles square, tall portrait, and wide landscape aspect ratios with centered offsets', () => {
  // Square image in wide box (letterbox left/right)
  const sq = computeContainRect(1000, 1000, 1200, 800);
  assert.equal(sq.contentWidth, 800);
  assert.equal(sq.contentHeight, 800);
  assert.equal(sq.offsetX, 200);
  assert.equal(sq.offsetY, 0);

  // Tall portrait image (800x2400) inside 900x900 box
  const tall = computeContainRect(800, 2400, 900, 900);
  assert.equal(tall.contentHeight, 900);
  assert.equal(tall.contentWidth, 300);
  assert.equal(tall.offsetX, 300);
  assert.equal(tall.offsetY, 0);

  // Wide landscape image (1920x600) inside 960x800 box
  const wide = computeContainRect(1920, 600, 960, 800);
  assert.equal(wide.contentWidth, 960);
  assert.equal(wide.contentHeight, 300);
  assert.equal(wide.offsetX, 0);
  assert.equal(wide.offsetY, 250);
});

test('normalized <-> image pixel and display pixel transforms round-trip accurately under zoom, pan, and resize', () => {
  const cases = [
    { natW: 1000, natH: 1000, boxW: 1000, boxH: 700, left: 120, top: 80 },
    { natW: 896, natH: 1200, boxW: 810, boxH: 760, left: 260, top: 110 },
    { natW: 800, natH: 2400, boxW: 640, boxH: 900, left: 400, top: 45 },
    { natW: 1920, natH: 600, boxW: 1100, boxH: 680, left: 180, top: 140 },
  ];

  const targets = [
    { x: 188, y: 112 },
    { x: 500, y: 500 },
    { x: 790, y: 128 },
    { x: 312, y: 845 },
  ];

  for (const c of cases) {
    for (const zoom of [0.65, 1, 1.75]) {
      const scaledBoxW = c.boxW * zoom;
      const scaledBoxH = c.boxH * zoom;
      // Simulate CSS translate pan offset
      const rect = {
        left: c.left + 37,
        top: c.top - 19,
        width: scaledBoxW,
        height: scaledBoxH,
      };

      for (const pt of targets) {
        const imgPx = normalizedPointToImagePx(pt, c.natW, c.natH);
        const backNorm = imagePxToNormalizedPoint(imgPx, c.natW, c.natH);
        assert.ok(Math.abs(backNorm.x - pt.x) < 1e-6);
        assert.ok(Math.abs(backNorm.y - pt.y) < 1e-6);

        const dispPt = normalizedPointToDisplayPx(pt, c.natW, c.natH, scaledBoxW, scaledBoxH);
        const clientX = rect.left + dispPt.x;
        const clientY = rect.top + dispPt.y;
        const roundTrip = displayClientToNormalized(clientX, clientY, rect, c.natW, c.natH);
        assert.equal(roundTrip.x, pt.x);
        assert.equal(roundTrip.y, pt.y);
      }

      // Delta consistency check
      const contain = computeContainRect(c.natW, c.natH, scaledBoxW, scaledBoxH);
      const { dx, dy } = displayDeltaToNormalized(
        contain.contentWidth * 0.25,
        contain.contentHeight * 0.1,
        rect,
        c.natW,
        c.natH
      );
      assert.ok(Math.abs(dx - 250) < 1e-6);
      assert.ok(Math.abs(dy - 100) < 1e-6);
    }
  }
});

test('normalizedBoxToImagePx and normalizedBoxToDisplayPx match contain rect inset cleanly', () => {
  const box = { x: 100, y: 200, width: 300, height: 150 };
  const imgBox = normalizedBoxToImagePx(box, 896, 1200);
  assert.ok(Math.abs(imgBox.x - 89.6) < 1e-6);
  assert.ok(Math.abs(imgBox.width - 268.8) < 1e-6);

  // 896x1200 in 1200x1200 -> scale=1, contentWidth=896, offsetX=(1200-896)/2=152
  const disp = normalizedBoxToDisplayPx(box, 896, 1200, 1200, 1200);
  assert.ok(Math.abs(disp.x - (152 + 89.6)) < 1e-6);
  assert.ok(Math.abs(disp.y - 240) < 1e-6);
  assert.ok(Math.abs(disp.width - 268.8) < 1e-6);
  assert.ok(Math.abs(disp.height - 180) < 1e-6);
});

test('computeNaturalFitSize preserves exact aspect ratio across zoom without drift', () => {
  const fit = computeNaturalFitSize({
    naturalWidth: 896,
    naturalHeight: 1200,
    containerWidth: 960,
    containerHeight: 740,
    zoom: 1.45,
  });
  const natRatio = 896 / 1200;
  const dispRatio = fit.displayWidth / fit.displayHeight;
  assert.ok(Math.abs(natRatio - dispRatio) < 0.005);
  assert.ok(fit.fitScale <= 1);
});

test('computeRegionCenterNormalized uses polygon centroid and falls back to boundingBox center', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  const rectPoly = [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 200 },
    { x: 100, y: 200 },
  ];
  const c1 = computeRegionCenterNormalized(box, rectPoly);
  assert.equal(c1.x, 200);
  assert.equal(c1.y, 150);

  const c2 = computeRegionCenterNormalized(box);
  assert.equal(c2.x, 200);
  assert.equal(c2.y, 150);
});

test('computeOpticalCenterOffsetX centers asymmetric ink bounds cleanly without over-shifting', () => {
  // Symmetric glyph -> 0 shift
  assert.equal(computeOpticalCenterOffsetX(14, 14, 24), 0);

  // Heavy right overhang (right=18, left=10) -> shift left by -4px so ink centers on 0
  assert.equal(computeOpticalCenterOffsetX(10, 18, 24), -4);

  // Extreme overhang gets clamped to 0.25 * fontSize
  assert.equal(computeOpticalCenterOffsetX(2, 40, 20), -5);
  assert.equal(computeOpticalCenterOffsetX(40, 2, 20), 5);
});

test('computeAlignedAnchorOffsetX respects center, right, and left padding symmetrically', () => {
  assert.equal(computeAlignedAnchorOffsetX(200, 'center', 10), 0);
  assert.equal(computeAlignedAnchorOffsetX(200, 'right', 10), 80);
  assert.equal(computeAlignedAnchorOffsetX(200, 'left', 10), -80);
});
