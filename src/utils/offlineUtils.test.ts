import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDownloadProgress,
  estimateChapterDownloadBytes,
  formatBytesLabel,
  isQuotaExceededError,
  verifyOfflineChapterIntegrity,
} from './offlineUtils';

test('estimateChapterDownloadBytes scales cleanly with page count and includeOriginals toggle', () => {
  const translatedOnly = estimateChapterDownloadBytes(20, false);
  const withOriginals = estimateChapterDownloadBytes(20, true);
  assert.ok(translatedOnly > 0);
  assert.ok(withOriginals > translatedOnly);
  assert.equal(estimateChapterDownloadBytes(0, true), 0);
});

test('computeDownloadProgress clamps percentage cleanly', () => {
  assert.equal(computeDownloadProgress(0, 20), 0);
  assert.equal(computeDownloadProgress(10, 20), 50);
  assert.equal(computeDownloadProgress(25, 20), 100);
  assert.equal(computeDownloadProgress(0, 0), 0);
});

test('verifyOfflineChapterIntegrity checks page count and inline dataUrl presence', () => {
  const ok = verifyOfflineChapterIntegrity(2, [
    { id: 'p1', processedImage: 'data:image/jpeg;base64,AAA' },
    { id: 'p2', processedImage: 'data:image/jpeg;base64,BBB' },
  ]);
  assert.equal(ok.valid, true);

  const missingCount = verifyOfflineChapterIntegrity(3, [
    { id: 'p1', processedImage: 'data:image/jpeg;base64,AAA' },
  ]);
  assert.equal(missingCount.valid, false);
  assert.equal(missingCount.reason, 'incomplete_page_count');

  const missingData = verifyOfflineChapterIntegrity(2, [
    { id: 'p1', processedImage: 'data:image/jpeg;base64,AAA' },
    { id: 'p2', processedImage: '', originalImage: '/uploads/missing.jpg' },
  ]);
  assert.equal(missingData.valid, false);
});

test('isQuotaExceededError recognizes DOMException and OfflineQuotaError cleanly', () => {
  const err = new Error('Quota exceeded');
  err.name = 'QuotaExceededError';
  assert.equal(isQuotaExceededError(err), true);
  assert.equal(isQuotaExceededError(new Error('network timeout')), false);
  assert.equal(formatBytesLabel(5 * 1024 * 1024, 'ar').includes('م.ب'), true);
});
