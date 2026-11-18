import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortRegionsByReadingOrder,
  sortPageFilenames,
  fitTextInRegion,
  parseGlossaryCsv,
  exportGlossaryCsv,
  findMatchingGlossaryTerms,
} from './bubbleLayout';
import type { GlossaryEntry } from '../types/domain';

test('sortRegionsByReadingOrder orders Manga RTL right-to-left within the same vertical band', () => {
  const leftBubble = { id: 'L', boundingBox: { x: 100, y: 120, width: 180, height: 140 } };
  const rightBubble = { id: 'R', boundingBox: { x: 700, y: 140, width: 180, height: 140 } };
  const bottomBubble = { id: 'B', boundingBox: { x: 500, y: 550, width: 200, height: 150 } };

  const sortedRtl = sortRegionsByReadingOrder([leftBubble, bottomBubble, rightBubble], 'rtl');
  assert.deepEqual(sortedRtl.map((r) => r.id), ['R', 'L', 'B']);

  const sortedLtr = sortRegionsByReadingOrder([rightBubble, bottomBubble, leftBubble], 'ltr');
  assert.deepEqual(sortedLtr.map((r) => r.id), ['L', 'R', 'B']);
});

test('sortPageFilenames sorts page numbers naturally instead of lexicographically', () => {
  const input = ['page_10.png', 'page_2.png', 'page_1.png', 'chapter1_09.webp'];
  const sorted = sortPageFilenames(input);
  assert.deepEqual(sorted, ['chapter1_09.webp', 'page_1.png', 'page_2.png', 'page_10.png']);
});

test('fitTextInRegion shrinks font size and wraps Arabic text so it stays inside small bubble bounds', () => {
  const approxMeasure = (str: string, size: number) => str.length * size * 0.55;
  const result = fitTextInRegion(
    'هذه جملة طويلة جداً داخل فقاعة حوار ضيقة ويجب أن تتكيف تلقائياً دون الخروج من الحدود',
    160,
    120,
    { fontSize: 24, lineHeight: 1.3, padding: 10, autoFit: true },
    approxMeasure
  );

  assert.ok(result.fontSize < 24, 'Expected auto-fit to shrink fontSize below 24');
  assert.ok(result.lines.length >= 2, 'Expected text to wrap across multiple lines');
  assert.equal(result.overflowed, false, 'Expected fitted text not to overflow box height');
});

test('glossary CSV round-trip and term matching work accurately', () => {
  const csv = [
    'original_term,translated_term,category,notes',
    'Wismerhill,ويسميرهيل,character,"Main protagonist"',
    '"Black Moon",القمر الأسود,place,"Empire name"',
  ].join('\n');

  const parsed = parseGlossaryCsv(csv);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].originalTerm, 'Wismerhill');
  assert.equal(parsed[0].translatedTerm, 'ويسميرهيل');
  assert.equal(parsed[1].category, 'place');

  const entries: GlossaryEntry[] = parsed.map((p, idx) => ({
    ...p,
    id: `g-${idx}`,
    projectId: 'p-1',
  }));
  const matched = findMatchingGlossaryTerms('Commander Wismerhill marches toward Black Moon.', entries);
  assert.equal(matched.length, 2);

  const reExported = exportGlossaryCsv(entries);
  assert.ok(reExported.includes('ويسميرهيل'));
  assert.ok(reExported.includes('القمر الأسود'));
});
