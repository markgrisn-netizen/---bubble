import type { LanguageCode, Page, PageStatus, TranslationJob } from '../types/domain';

export function isServerUploadUrl(src?: string | null): boolean {
  return Boolean(src && src.startsWith('/uploads/'));
}

export function extractUploadFilename(src?: string | null): string {
  if (!src || !src.startsWith('/uploads/')) return '';
  return src.slice('/uploads/'.length).split('?')[0];
}

export function shouldAttemptLocalAssetRecovery(page: Page, failedLoad = false): boolean {
  if (page.assetMissing) return true;
  if (failedLoad && (!page.originalImage || isServerUploadUrl(page.originalImage))) return true;
  if (!page.originalImage) return true;
  return false;
}

export interface LocalAssetCandidate {
  pageId: string;
  contentHash?: string;
  originalDataUrl: string;
  processedDataUrl?: string;
  serverUrl?: string;
  width?: number;
  height?: number;
}

export function selectMatchingLocalAsset<T extends LocalAssetCandidate>(
  page: Pick<Page, 'id' | 'contentHash' | 'originalImage'>,
  assets: T[]
): T | null {
  const byId = assets.find((a) => a.pageId === page.id && Boolean(a.originalDataUrl));
  if (byId) return byId;

  if (page.contentHash) {
    const byHash = assets.find(
      (a) => a.contentHash === page.contentHash && Boolean(a.originalDataUrl)
    );
    if (byHash) return byHash;
  }

  if (page.originalImage && isServerUploadUrl(page.originalImage)) {
    const byUrl = assets.find(
      (a) => a.serverUrl === page.originalImage && Boolean(a.originalDataUrl)
    );
    if (byUrl) return byUrl;
  }

  return null;
}

export function isJobHeartbeatStale(
  job: Pick<TranslationJob, 'status' | 'lastHeartbeatAt' | 'createdAt'>,
  nowMs = Date.now(),
  staleThresholdMs = 20_000
): boolean {
  if (job.status !== 'running' && job.status !== 'queued') return false;
  const rawTs = job.lastHeartbeatAt || job.createdAt;
  const parsed = Date.parse(rawTs);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed >= staleThresholdMs;
}

export function partitionChapterPagesByCompletion(pages: Page[]): {
  completed: Page[];
  incomplete: Page[];
  failed: Page[];
  firstIncompletePageNumber: number | null;
} {
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const completed: Page[] = [];
  const incomplete: Page[] = [];
  const failed: Page[] = [];

  for (const p of sorted) {
    if (p.status === 'completed') {
      completed.push(p);
    } else if (p.status === 'error') {
      failed.push(p);
      incomplete.push(p);
    } else {
      incomplete.push(p);
    }
  }

  return {
    completed,
    incomplete,
    failed,
    firstIncompletePageNumber: incomplete[0]?.pageNumber ?? null,
  };
}

export function formatPageStageLabel(lang: LanguageCode, status: PageStatus): string {
  if (lang === 'ar') {
    switch (status) {
      case 'pending':
        return 'في الانتظار';
      case 'analyzing':
        return 'قيد المعالجة (OCR)';
      case 'analyzed':
        return 'اكتمل OCR';
      case 'translating':
        return 'جاري الترجمة';
      case 'rendering':
        return 'تجهيز الصفحة';
      case 'cleaned':
        return 'تم التنظيف';
      case 'completed':
        return 'مكتمل';
      case 'error':
        return 'فشل';
      default:
        return status;
    }
  }
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'analyzing':
      return 'Processing (OCR)';
    case 'analyzed':
      return 'OCR Completed';
    case 'translating':
      return 'Translating';
    case 'rendering':
      return 'Rendering';
    case 'cleaned':
      return 'Cleaned';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Failed';
    default:
      return status;
  }
}
