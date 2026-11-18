import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCurrentPageFromScroll,
  computeReaderPageFrameSize,
  computeReadingProgressPercent,
  computeRenderWindow,
  DEFAULT_READER_PREFERENCES,
  getNextInfiniteVisibleCount,
  getPageSpacingPx,
  isLightBackgroundHex,
  normalizeReaderPreferences,
} from './readerUtils';

test('DEFAULT_READER_PREFERENCES defaults to Web reading mode, None spacing, and Fit Width', () => {
  assert.equal(DEFAULT_READER_PREFERENCES.mode, 'web');
  assert.equal(DEFAULT_READER_PREFERENCES.spacing, 'none');
  assert.equal(DEFAULT_READER_PREFERENCES.pageWidth, 'fit_width');
  assert.equal(DEFAULT_READER_PREFERENCES.brightness, 100);
  assert.equal(getPageSpacingPx('none'), 0);
  assert.equal(getPageSpacingPx('small'), 8);
  assert.equal(getPageSpacingPx('large'), 24);
});

test('normalizeReaderPreferences clamps brightness and validates fields safely', () => {
  const normalized = normalizeReaderPreferences({
    mode: 'infinite',
    spacing: 'large',
    pageWidth: 'fit_screen',
    backgroundColor: '#FAF5E8',
    brightness: 999,
  });
  assert.equal(normalized.mode, 'infinite');
  assert.equal(normalized.spacing, 'large');
  assert.equal(normalized.pageWidth, 'fit_screen');
  assert.equal(normalized.backgroundColor, '#FAF5E8');
  assert.equal(normalized.brightness, 130);
  assert.equal(isLightBackgroundHex('#FAF5E8'), true);
  assert.equal(isLightBackgroundHex('#111318'), false);
});

test('computeReaderPageFrameSize fills available mobile width without cropping in fit_width and fits viewport in fit_screen', () => {
  // Mobile 390px: page must fill full 390px without exceeding viewport width and preserve 2:3 aspect ratio
  const mobileFitWidth = computeReaderPageFrameSize({
    naturalWidth: 1000,
    naturalHeight: 1500,
    viewportWidth: 390,
    viewportHeight: 844,
    pageWidthMode: 'fit_width',
  });
  assert.equal(mobileFitWidth.width, 390);
  assert.equal(mobileFitWidth.height, 585);

  // Desktop 1440px fit_screen: height must not exceed viewportHeight - 24
  const desktopFitScreen = computeReaderPageFrameSize({
    naturalWidth: 1000,
    naturalHeight: 1500,
    viewportWidth: 1440,
    viewportHeight: 800,
    pageWidthMode: 'fit_screen',
  });
  assert.ok(desktopFitScreen.height <= 776);
  assert.ok(Math.abs(desktopFitScreen.width / desktopFitScreen.height - 1000 / 1500) < 0.02);
});

test('computeRenderWindow bounds active canvas window cleanly for 50+ page novels', () => {
  const w1 = computeRenderWindow([12, 13], 60, 4);
  assert.deepEqual(w1, { start: 8, end: 17 });

  const wStart = computeRenderWindow([0, 1], 60, 4);
  assert.deepEqual(wStart, { start: 0, end: 5 });

  const wEnd = computeRenderWindow([58, 59], 60, 4);
  assert.deepEqual(wEnd, { start: 54, end: 59 });
});

test('getNextInfiniteVisibleCount steps progressive loading cleanly without exceeding total', () => {
  assert.equal(getNextInfiniteVisibleCount(8, 55, 8), 16);
  assert.equal(getNextInfiniteVisibleCount(50, 55, 8), 55);
});

test('computeCurrentPageFromScroll and computeReadingProgressPercent track scroll accurately', () => {
  const activeIdx = computeCurrentPageFromScroll(
    [
      { index: 0, top: -900, bottom: -100 },
      { index: 1, top: -100, bottom: 500 },
      { index: 2, top: 500, bottom: 1100 },
    ],
    800
  );
  assert.equal(activeIdx, 1);

  assert.equal(computeReadingProgressPercent(500, 1800, 800, 1, 10, 'web'), 50);
  assert.equal(computeReadingProgressPercent(0, 800, 800, 4, 10, 'paginated'), 50);
});
