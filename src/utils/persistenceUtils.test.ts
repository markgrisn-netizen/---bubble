import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page, TranslationJob } from '../types/domain';
import {
  extractUploadFilename,
  formatPageStageLabel,
  isJobHeartbeatStale,
  isServerUploadUrl,
  partitionChapterPagesByCompletion,
  selectMatchingLocalAsset,
  shouldAttemptLocalAssetRecovery,
} from './persistenceUtils';

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    id: overrides.id || 'pg-1',
    chapterId: overrides.chapterId || 'ch-1',
    pageNumber: overrides.pageNumber ?? 1,
    originalImage: overrides.originalImage ?? '/uploads/test_p1.webp',
    status: overrides.status ?? 'pending',
    width: 900,
    height: 1200,
    rotation: 0,
    manualStrokes: [],
    panels: [],
    regions: [],
    ...overrides,
  };
}

test('isServerUploadUrl & extractUploadFilename parse /uploads paths accurately', () => {
  assert.equal(isServerUploadUrl('/uploads/abc_123.webp'), true);
  assert.equal(isServerUploadUrl('data:image/png;base64,AAA'), false);
  assert.equal(isServerUploadUrl('/src/assets/sample.jpg'), false);
  assert.equal(extractUploadFilename('/uploads/abc_123.webp?v=2'), 'abc_123.webp');
  assert.equal(extractUploadFilename('/src/assets/sample.jpg'), '');
});

test('shouldAttemptLocalAssetRecovery triggers on assetMissing or failed upload load', () => {
  assert.equal(shouldAttemptLocalAssetRecovery(makePage({ assetMissing: true }), false), true);
  assert.equal(shouldAttemptLocalAssetRecovery(makePage({ assetMissing: false }), false), false);
  assert.equal(shouldAttemptLocalAssetRecovery(makePage({ assetMissing: false }), true), true);
  assert.equal(
    shouldAttemptLocalAssetRecovery(makePage({ originalImage: 'data:image/png;base64,abc' }), true),
    false
  );
  assert.equal(shouldAttemptLocalAssetRecovery(makePage({ originalImage: '' }), false), true);
});

test('selectMatchingLocalAsset matches by pageId, then contentHash, then serverUrl', () => {
  const assets = [
    { pageId: 'pg-a', contentHash: 'hash-a', serverUrl: '/uploads/a.webp', originalDataUrl: 'data:image/png;base64,A' },
    { pageId: 'pg-b', contentHash: 'hash-b', serverUrl: '/uploads/b.webp', originalDataUrl: 'data:image/png;base64,B' },
  ];

  assert.equal(
    selectMatchingLocalAsset({ id: 'pg-b', contentHash: 'other', originalImage: '/uploads/none.webp' }, assets)?.originalDataUrl,
    'data:image/png;base64,B'
  );
  assert.equal(
    selectMatchingLocalAsset({ id: 'pg-new', contentHash: 'hash-a', originalImage: '/uploads/none.webp' }, assets)?.originalDataUrl,
    'data:image/png;base64,A'
  );
  assert.equal(
    selectMatchingLocalAsset({ id: 'pg-new2', contentHash: 'hash-none', originalImage: '/uploads/b.webp' }, assets)?.originalDataUrl,
    'data:image/png;base64,B'
  );
  assert.equal(
    selectMatchingLocalAsset({ id: 'pg-missing', contentHash: 'hash-missing', originalImage: '/uploads/none.webp' }, assets),
    null
  );
});

test('isJobHeartbeatStale detects stalled running or queued jobs after threshold', () => {
  const now = Date.parse('2026-11-19T12:00:30.000Z');
  const freshJob: Pick<TranslationJob, 'status' | 'lastHeartbeatAt' | 'createdAt'> = {
    status: 'running',
    lastHeartbeatAt: '2026-11-19T12:00:20.000Z',
    createdAt: '2026-11-19T11:59:00.000Z',
  };
  const stalledJob: Pick<TranslationJob, 'status' | 'lastHeartbeatAt' | 'createdAt'> = {
    status: 'running',
    lastHeartbeatAt: '2026-11-19T11:59:55.000Z',
    createdAt: '2026-11-19T11:58:00.000Z',
  };
  const completedOldJob: Pick<TranslationJob, 'status' | 'lastHeartbeatAt' | 'createdAt'> = {
    status: 'completed',
    lastHeartbeatAt: '2026-11-19T11:50:00.000Z',
    createdAt: '2026-11-19T11:49:00.000Z',
  };

  assert.equal(isJobHeartbeatStale(freshJob, now, 20_000), false);
  assert.equal(isJobHeartbeatStale(stalledJob, now, 20_000), true);
  assert.equal(isJobHeartbeatStale(completedOldJob, now, 20_000), false);
});

test('partitionChapterPagesByCompletion identifies completed, failed, and first incomplete page', () => {
  const pages = [
    makePage({ id: 'pg-3', pageNumber: 3, status: 'pending' }),
    makePage({ id: 'pg-1', pageNumber: 1, status: 'completed' }),
    makePage({ id: 'pg-2', pageNumber: 2, status: 'error' }),
  ];

  const partitioned = partitionChapterPagesByCompletion(pages);
  assert.deepEqual(
    partitioned.completed.map((p) => p.id),
    ['pg-1']
  );
  assert.deepEqual(
    partitioned.failed.map((p) => p.id),
    ['pg-2']
  );
  assert.deepEqual(
    partitioned.incomplete.map((p) => p.id),
    ['pg-2', 'pg-3']
  );
  assert.equal(partitioned.firstIncompletePageNumber, 2);
});

test('formatPageStageLabel returns localized stage labels for Arabic and English', () => {
  assert.equal(formatPageStageLabel('ar', 'analyzing'), 'قيد المعالجة (OCR)');
  assert.equal(formatPageStageLabel('ar', 'analyzed'), 'اكتمل OCR');
  assert.equal(formatPageStageLabel('ar', 'translating'), 'جاري الترجمة');
  assert.equal(formatPageStageLabel('ar', 'completed'), 'مكتمل');
  assert.equal(formatPageStageLabel('en', 'rendering'), 'Rendering');
});
