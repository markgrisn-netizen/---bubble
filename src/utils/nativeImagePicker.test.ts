import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS,
  buildDuplicatePreventedMessage,
  filterAndDeduplicatePickedAssets,
} from './nativeImagePicker';

test('NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS enforces native Android Photo Picker contract', () => {
  assert.equal(NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS.type, 'file');
  assert.equal(NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS.accept, 'image/*');
  assert.equal(NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS.multiple, true);
});

test('filterAndDeduplicatePickedAssets preserves order, appends second batch cleanly, and blocks duplicates', () => {
  const batch1 = [
    { filename: 'p01.jpg', contentHash: 'hash-1' },
    { filename: 'p02.jpg', contentHash: 'hash-2' },
    { filename: 'p02-copy.jpg', contentHash: 'hash-2' },
  ];
  const res1 = filterAndDeduplicatePickedAssets([], batch1);
  assert.deepEqual(
    res1.accepted.map((a) => a.filename),
    ['p01.jpg', 'p02.jpg']
  );
  assert.equal(res1.skippedDuplicateCount, 1);
  assert.deepEqual(res1.duplicateFilenames, ['p02-copy.jpg']);

  // Second batch appended later without deleting first batch
  const existingHashes = res1.accepted.map((a) => a.contentHash);
  const batch2 = [
    { filename: 'p01-again.jpg', contentHash: 'hash-1' },
    { filename: 'p03.png', contentHash: 'hash-3' },
    { filename: 'p04.webp', contentHash: 'hash-4' },
  ];
  const res2 = filterAndDeduplicatePickedAssets(existingHashes, batch2);
  assert.deepEqual(
    res2.accepted.map((a) => a.filename),
    ['p03.png', 'p04.webp']
  );
  assert.equal(res2.skippedDuplicateCount, 1);
  assert.deepEqual(res2.duplicateFilenames, ['p01-again.jpg']);

  const noticeAr = buildDuplicatePreventedMessage('ar', res2.accepted.length, res2.skippedDuplicateCount);
  assert.match(noticeAr, /منع تكرار/);
  assert.match(noticeAr, /2/);
});
