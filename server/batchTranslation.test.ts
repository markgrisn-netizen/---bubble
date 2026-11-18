import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatConciseStoryMemoryForPrompt,
  mergeStoryMemoryUpdate,
  partitionPagesIntoBatches,
  selectBatchJobPageStates,
} from './batchTranslation.ts';
import {
  annotateDuplicatesByHash,
  chunkPagesForUpload,
  deduplicateByHash,
  orderPagesForExport,
  parsePageRangeSpec,
} from '../src/utils/pageBatchUtils.ts';
import type { Page } from '../src/types/domain.ts';

function makeDummyPage(pageNumber: number, status: Page['status'] = 'pending', translated = false): Page {
  return {
    id: `pg-${pageNumber}`,
    chapterId: 'ch-1',
    pageNumber,
    originalImage: `data:image/png;base64,AAA${pageNumber}`,
    status,
    width: 896,
    height: 1200,
    rotation: 0,
    manualStrokes: [],
    panels: [],
    regions: [
      {
        id: `reg-${pageNumber}`,
        pageId: `pg-${pageNumber}`,
        regionType: 'dialogue',
        boundingBox: { x: 100, y: 100, width: 200, height: 100 },
        boundingPolygon: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 200 },
          { x: 100, y: 200 },
        ],
        originalText: `Line ${pageNumber}`,
        translatedText: translated ? `ترجمة ${pageNumber}` : '',
        alternatives: [],
        sourceLanguage: 'en',
        confidence: 0.95,
        readingOrder: 1,
        fontSettings: {
          fontFamily: 'Cairo',
          fontSize: 22,
          fontWeight: '700',
          color: '#111827',
          align: 'center',
          lineHeight: 1.35,
          padding: 8,
          rotation: 0,
          direction: 'rtl',
          autoFit: true,
          offsetX: 0,
          offsetY: 0,
        },
        cleanMode: 'auto',
        sfxMode: 'keep',
        approvalStatus: 'pending',
        translationStatus: translated ? 'translated' : 'untranslated',
      },
    ],
  };
}

test('partitionPagesIntoBatches splits open-ended page counts into 2-page batches with single-page odd tail', () => {
  const b3 = partitionPagesIntoBatches(['p1', 'p2', 'p3'], 2);
  assert.deepEqual(b3, [['p1', 'p2'], ['p3']]);

  const b20 = partitionPagesIntoBatches(
    Array.from({ length: 20 }, (_, i) => i + 1),
    2
  );
  assert.equal(b20.length, 10);
  assert.deepEqual(b20[0], [1, 2]);
  assert.deepEqual(b20[9], [19, 20]);

  const b50 = partitionPagesIntoBatches(
    Array.from({ length: 50 }, (_, i) => i + 1),
    2
  );
  assert.equal(b50.length, 25);

  const b120 = partitionPagesIntoBatches(
    Array.from({ length: 120 }, (_, i) => i + 1),
    2
  );
  assert.equal(b120.length, 60);
  assert.deepEqual(b120[59], [119, 120]);
});

test('selectBatchJobPageStates skips completed pages on resume, retries failed only, and respects explicit 2-page selection', () => {
  const pages: Page[] = [
    makeDummyPage(1, 'completed', true),
    makeDummyPage(2, 'error', false),
    makeDummyPage(3, 'pending', false),
    makeDummyPage(4, 'completed', true),
  ];

  // Normal resume skips completed pages 1 & 4
  const resumePlan = selectBatchJobPageStates(pages);
  assert.deepEqual(resumePlan.queuedPageIds, ['pg-2', 'pg-3']);
  assert.equal(resumePlan.pageStates['pg-1'], 'skipped');
  assert.equal(resumePlan.pageStates['pg-4'], 'skipped');

  // Retry failed only queues pg-2
  const retryPlan = selectBatchJobPageStates(pages, { retryOnlyFailed: true });
  assert.deepEqual(retryPlan.queuedPageIds, ['pg-2']);

  // Force retranslate specific 2-page batch queues [pg-1, pg-2]
  const batchPlan = selectBatchJobPageStates(pages, {
    selectedPageIds: ['pg-1', 'pg-2'],
    forceRetranslate: true,
  });
  assert.deepEqual(batchPlan.queuedPageIds, ['pg-1', 'pg-2']);
});

test('mergeStoryMemoryUpdate accumulates & deduplicates structured memory across batches without unbounded prompt bloat', () => {
  let mem = mergeStoryMemoryUpdate(
    undefined,
    {
      characters: [{ name: 'Vanguard', translatedName: 'فانغارد', speechStyle: 'firm' }],
      locations: ['Neo-Cairo', 'Orbital Dock'],
      loreTerms: ['Aether Core'],
      relationships: ['Vanguard trusts Dr. Lin'],
      keyFacts: ['Reactor core destabilized'],
      translationDecisions: [{ original: 'Aether Core', translated: 'نواة الأثير' }],
      summaryAddition: 'Batch 1: Vanguard lands on Orbital Dock.',
    },
    []
  );

  mem = mergeStoryMemoryUpdate(
    mem,
    {
      characters: [
        { name: 'vanguard', translatedName: 'فانغارد', speechStyle: 'calm under pressure' },
        { name: 'Dr. Lin', translatedName: 'د. لين', relations: 'Chief Engineer' },
      ],
      locations: ['neo-cairo', 'Lower Spire'],
      loreTerms: ['aether core', 'Chrono-Lock'],
      relationships: ['Vanguard trusts Dr. Lin'],
      keyFacts: ['Chrono-Lock activated'],
      translationDecisions: [{ original: 'Chrono-Lock', translated: 'القفل الزمني' }],
      summaryAddition: 'Batch 2: Dr. Lin activates the Chrono-Lock.',
    },
    []
  );

  assert.equal(mem.characters.length, 2);
  assert.equal(mem.locations.length, 3);
  assert.equal(mem.loreTerms?.length, 2);
  assert.equal(mem.relationships?.length, 1);
  assert.equal(mem.keyFacts?.length, 2);
  assert.equal(mem.translationDecisions?.length, 2);

  const promptText = formatConciseStoryMemoryForPrompt(mem);
  assert.match(promptText, /Vanguard=>فانغارد/);
  assert.match(promptText, /Neo-Cairo/);
  assert.match(promptText, /نواة الأثير/);
});

test('pageBatchUtils handles SHA-256 duplicate detection, chunked uploads for 120 pages, range parsing, and export ordering', () => {
  const assets = [
    { id: '1', contentHash: 'hash-a', dataUrl: 'x'.repeat(1000) },
    { id: '2', contentHash: 'hash-b', dataUrl: 'x'.repeat(1000) },
    { id: '3', contentHash: 'hash-a', dataUrl: 'x'.repeat(1000) },
  ];
  const annotated = annotateDuplicatesByHash(assets);
  assert.equal(annotated[0].isDuplicate, false);
  assert.equal(annotated[2].isDuplicate, true);
  assert.equal(annotated[2].duplicateOfIndex, 0);

  const unique = deduplicateByHash(assets);
  assert.equal(unique.length, 2);

  // 120 pages split safely into <=5 per chunk
  const bigBatch = Array.from({ length: 120 }, (_, i) => ({
    dataUrl: `data:image/jpeg;base64,${'A'.repeat(2000)}_${i}`,
  }));
  const chunks = chunkPagesForUpload(bigBatch, 5, 10 * 1024 * 1024);
  assert.equal(chunks.length, 24);
  assert.equal(chunks.reduce((sum, c) => sum + c.length, 0), 120);

  // Page range parsing
  assert.deepEqual(parsePageRangeSpec('1-3, 8, 5-6', 10), [1, 2, 3, 5, 6, 8]);
  assert.deepEqual(parsePageRangeSpec('', 4), [1, 2, 3, 4]);

  // Export reading direction ordering
  const pgs = [1, 2, 3, 4].map((n) => ({ pageNumber: n }));
  assert.deepEqual(
    orderPagesForExport(pgs, 'ltr').map((p) => p.pageNumber),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    orderPagesForExport(pgs, 'rtl', { reverseSpreadPairsForRtl: true }).map((p) => p.pageNumber),
    [2, 1, 4, 3]
  );
});
