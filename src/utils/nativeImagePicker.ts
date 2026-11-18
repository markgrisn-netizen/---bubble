export interface PickableAssetLike {
  filename: string;
  contentHash?: string;
}

/**
 * Exact HTML file-input contract required to trigger Android Chrome & WebView's
 * native Photo Picker bottom sheet (Photos / Albums / Search / Multi-select)
 * instead of the generic file/document manager or camera capture.
 */
export const NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS = {
  type: 'file' as const,
  accept: 'image/*',
  multiple: true as const,
};

export interface DeduplicatePickedResult<T extends PickableAssetLike> {
  accepted: T[];
  skippedDuplicateCount: number;
  duplicateFilenames: string[];
}

/**
 * Filters newly picked assets against both existing project/staged SHA-256 hashes
 * and duplicates inside the same picked batch, preserving exact selection order.
 */
export function filterAndDeduplicatePickedAssets<T extends PickableAssetLike>(
  existingHashes: Iterable<string>,
  incomingAssets: T[]
): DeduplicatePickedResult<T> {
  const seen = new Set<string>();
  for (const h of existingHashes) {
    if (h) seen.add(h);
  }

  const accepted: T[] = [];
  const duplicateFilenames: string[] = [];

  for (const asset of incomingAssets) {
    const hash = asset.contentHash?.trim();
    if (hash && seen.has(hash)) {
      duplicateFilenames.push(asset.filename);
      continue;
    }
    if (hash) {
      seen.add(hash);
    }
    accepted.push(asset);
  }

  return {
    accepted,
    skippedDuplicateCount: duplicateFilenames.length,
    duplicateFilenames,
  };
}

/**
 * Formats a clear user-facing notice whenever duplicate images are blocked or
 * mixed results occur so duplicates are never silently skipped or duplicated.
 */
export function buildDuplicatePreventedMessage(
  lang: 'ar' | 'en',
  addedCount: number,
  skippedDuplicateCount: number
): string {
  if (skippedDuplicateCount <= 0) return '';
  if (lang === 'ar') {
    if (addedCount === 0) {
      return `تم منع تكرار ${skippedDuplicateCount} ${
        skippedDuplicateCount === 1 ? 'صورة مكررة' : 'صور مكررة'
      } لأنها مضافة مسبقاً في المشروع.`;
    }
    return `تمت إضافة ${addedCount} ${addedCount === 1 ? 'صورة جديدة' : 'صور جديدة'}، وتم منع تكرار ${skippedDuplicateCount} ${
      skippedDuplicateCount === 1 ? 'صورة موجودة مسبقاً' : 'صور موجودة مسبقاً'
    }.`;
  }
  if (addedCount === 0) {
    return `Prevented ${skippedDuplicateCount} duplicate image(s) already present in this chapter.`;
  }
  return `Added ${addedCount} new image(s) and prevented ${skippedDuplicateCount} duplicate(s).`;
}
