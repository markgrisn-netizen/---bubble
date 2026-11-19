import type { LanguageCode } from '../types/domain';

export function estimateChapterDownloadBytes(
  pageCount: number,
  includeOriginals: boolean
): number {
  const safeCount = Math.max(0, pageCount);
  const perPageCompositeBytes = 420 * 1024; // ~420 KB high-quality JPEG/WebP composite
  const perPageOriginalBytes = includeOriginals ? 380 * 1024 : 0;
  return safeCount * (perPageCompositeBytes + perPageOriginalBytes);
}

export function formatBytesLabel(bytes: number, lang: LanguageCode): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) {
    return `${safe} ${lang === 'ar' ? 'بايت' : 'B'}`;
  }
  const kb = safe / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(0)} ${lang === 'ar' ? 'ك.ب' : 'KB'}`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} ${lang === 'ar' ? 'م.ب' : 'MB'}`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} ${lang === 'ar' ? 'ج.ب' : 'GB'}`;
}

export function computeDownloadProgress(completedPages: number, totalPages: number): number {
  if (totalPages <= 0) return 0;
  const pct = Math.round((completedPages / totalPages) * 100);
  return Math.max(0, Math.min(100, pct));
}

export function verifyOfflineChapterIntegrity(
  expectedPageCount: number,
  pages: Array<{ id: string; processedImage?: string; originalImage?: string }>
): { valid: boolean; reason?: string } {
  if (expectedPageCount <= 0 || pages.length < expectedPageCount) {
    return { valid: false, reason: 'incomplete_page_count' };
  }
  for (const p of pages) {
    const hasProcessed = Boolean(p.processedImage && p.processedImage.startsWith('data:image/'));
    const hasOriginal = Boolean(p.originalImage && p.originalImage.startsWith('data:image/'));
    if (!hasProcessed && !hasOriginal) {
      return { valid: false, reason: `missing_image_data:${p.id}` };
    }
  }
  return { valid: true };
}

export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { name?: string; code?: number; message?: string };
  if (
    anyErr.name === 'OfflineQuotaError' ||
    anyErr.name === 'QuotaExceededError' ||
    anyErr.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    anyErr.code === 22 ||
    anyErr.code === 1014
  ) {
    return true;
  }
  const msg = String(anyErr.message || '').toLowerCase();
  return msg.includes('quota') || msg.includes('storage') && msg.includes('full');
}
