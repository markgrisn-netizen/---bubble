import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNaturalFitSize } from './canvasViewport';

test('1. Large comic image fits comfortably inside desktop viewport without exceeding bounds', () => {
  const res = computeNaturalFitSize({
    naturalWidth: 2000,
    naturalHeight: 3000,
    containerWidth: 900,
    containerHeight: 720,
    paddingX: 24,
    paddingY: 24,
    zoom: 1,
  });
  assert.ok(res.displayWidth <= 900 - 48);
  assert.ok(res.displayHeight <= 720 - 48);
  assert.equal(res.displayHeight, 672);
  assert.equal(res.displayWidth, 448);
});

test('2. Small comic image stays at natural 1:1 size without forced upscaling', () => {
  const res = computeNaturalFitSize({
    naturalWidth: 320,
    naturalHeight: 440,
    containerWidth: 900,
    containerHeight: 720,
    paddingX: 24,
    paddingY: 24,
    zoom: 1,
  });
  assert.equal(res.fitScale, 1);
  assert.equal(res.displayWidth, 320);
  assert.equal(res.displayHeight, 440);
});

test('3. Tall portrait comic page fits vertically inside viewport without forced overflow', () => {
  const res = computeNaturalFitSize({
    naturalWidth: 800,
    naturalHeight: 2400,
    containerWidth: 900,
    containerHeight: 700,
    paddingX: 20,
    paddingY: 20,
    zoom: 1,
  });
  assert.ok(res.displayHeight <= 700 - 40);
  assert.ok(res.displayWidth <= 900 - 40);
  const aspectRatioDiff = Math.abs(res.displayWidth / res.displayHeight - 800 / 2400);
  assert.ok(aspectRatioDiff < 0.01);
});

test('4. Wide landscape comic spread fits horizontally without overflowing screen', () => {
  const res = computeNaturalFitSize({
    naturalWidth: 2200,
    naturalHeight: 1100,
    containerWidth: 848,
    containerHeight: 720,
    paddingX: 24,
    paddingY: 24,
    zoom: 1,
  });
  assert.equal(res.displayWidth, 800);
  assert.equal(res.displayHeight, 400);
  assert.ok(res.displayHeight <= 720 - 48);
});

test('5. Mobile viewport prevents horizontal overflow for large or wide images', () => {
  const res = computeNaturalFitSize({
    naturalWidth: 1200,
    naturalHeight: 1800,
    containerWidth: 390,
    containerHeight: 540,
    paddingX: 12,
    paddingY: 12,
    zoom: 1,
  });
  assert.ok(res.displayWidth <= 390 - 24);
  assert.ok(res.displayHeight <= 540 - 24);
});

test('6. Manual zoom scales cleanly and resetting zoom to 1 restores exact natural fit size', () => {
  const base = computeNaturalFitSize({
    naturalWidth: 1000,
    naturalHeight: 1500,
    containerWidth: 900,
    containerHeight: 700,
    zoom: 1,
  });
  const zoomedIn = computeNaturalFitSize({
    naturalWidth: 1000,
    naturalHeight: 1500,
    containerWidth: 900,
    containerHeight: 700,
    zoom: 1.5,
  });
  const reset = computeNaturalFitSize({
    naturalWidth: 1000,
    naturalHeight: 1500,
    containerWidth: 900,
    containerHeight: 700,
    zoom: 1,
  });
  assert.ok(zoomedIn.displayWidth > base.displayWidth);
  assert.ok(zoomedIn.displayHeight > base.displayHeight);
  assert.equal(reset.displayWidth, base.displayWidth);
  assert.equal(reset.displayHeight, base.displayHeight);
});
