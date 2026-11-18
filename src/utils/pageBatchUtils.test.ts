import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkPagesForUpload,
  computeVerticalStripSlices,
  deduplicateByHash,
  orderPagesForExport,
  parsePageRangeSpec,
} from './pageBatchUtils.ts';

describe('pageBatchUtils & tall webtoon slicing', () => {
  it('leaves standard comic pages unsliced', () => {
    const slices = computeVerticalStripSlices(1000, 1500);
    assert.deepEqual(slices, [{ index: 0, y: 0, height: 1500 }]);
  });

  it('splits tall webtoon strips into balanced contiguous slices', () => {
    const slices = computeVerticalStripSlices(800, 5000);
    assert.equal(slices.length, 4);
    assert.equal(slices[0].y, 0);
    const totalCovered = slices.reduce((sum, s) => sum + s.height, 0);
    assert.equal(totalCovered, 5000);
    for (let i = 1; i < slices.length; i++) {
      assert.equal(slices[i].y, slices[i - 1].y + slices[i - 1].height);
    }
  });

  it('parses custom page ranges cleanly', () => {
    assert.deepEqual(parsePageRangeSpec('3-5, 1, 8, 99', 10), [1, 3, 4, 5, 8]);
  });

  it('deduplicates assets by SHA-256 contentHash', () => {
    const deduped = deduplicateByHash([
      { id: '1', contentHash: 'aaa' },
      { id: '2', contentHash: 'bbb' },
      { id: '3', contentHash: 'aaa' },
    ]);
    assert.deepEqual(
      deduped.map((d) => d.id),
      ['1', '2']
    );
  });

  it('chunks upload payloads and orders RTL spread pairs', () => {
    const chunks = chunkPagesForUpload(
      [
        { dataUrl: '12345' },
        { dataUrl: '12345' },
        { dataUrl: '12345' },
      ],
      2,
      100
    );
    assert.equal(chunks.length, 2);

    const rtlOrdered = orderPagesForExport(
      [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }],
      'rtl',
      { reverseSpreadPairsForRtl: true }
    );
    assert.deepEqual(
      rtlOrdered.map((p) => p.pageNumber),
      [2, 1, 3]
    );
  });
});
