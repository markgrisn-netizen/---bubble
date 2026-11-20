import type { Page } from '../types/domain';
import { api } from './api';
import {
  findLocalAssetByServerUrl,
  findLocalAssetForPage,
  savePageAssetsBatch,
  type StoredPageAsset,
} from './offlineDb';
import { isServerUploadUrl, shouldAttemptLocalAssetRecovery } from './persistenceUtils';

const fallbackSrcCache = new Map<string, string>();
const inFlightPageRestore = new Map<string, Promise<Page | null>>();

export function getCachedRecoveredSrc(originalSrc: string): string | null {
  return fallbackSrcCache.get(originalSrc) || null;
}

export function registerLocalFallbackSrc(serverOrKey: string, dataUrl: string): void {
  if (!serverOrKey || !dataUrl) return;
  fallbackSrcCache.set(serverOrKey, dataUrl);
}

/**
 * Resolves a fallback Data URL from FaqqaOfflineDB if a /uploads/... asset fails or went missing.
 */
export async function tryResolveLocalDataUrlForUrl(src: string): Promise<string | null> {
  if (!src || src.startsWith('data:')) return null;
  const cached = fallbackSrcCache.get(src);
  if (cached) return cached;

  const asset = await findLocalAssetByServerUrl(src);
  if (asset?.originalDataUrl) {
    fallbackSrcCache.set(src, asset.originalDataUrl);
    return asset.originalDataUrl;
  }
  return null;
}

/**
 * Verifies if a page's image URL is reachable on the server. If missing/404, recovers from
 * IndexedDB (`FaqqaOfflineDB`) immediately for display AND re-syncs the file to `/api/pages/:id/restore-asset`.
 */
export async function verifyAndRecoverPageAsset(
  page: Page,
  options?: { forceProbe?: boolean }
): Promise<{ page: Page; recovered: boolean; dataUrl?: string }> {
  if (!page?.id) return { page, recovered: false };

  // Data URLs or static bundled assets do not need upload checks
  if (page.originalImage.startsWith('data:')) {
    return { page, recovered: false, dataUrl: page.originalImage };
  }

  let needsRecovery = Boolean(page.assetMissing);

  if (!needsRecovery && options?.forceProbe && isServerUploadUrl(page.originalImage)) {
    try {
      const headResp = await fetch(page.originalImage, { method: 'HEAD', cache: 'no-store' });
      if (!headResp.ok) {
        needsRecovery = true;
      }
    } catch {
      needsRecovery = true;
    }
  }

  if (!needsRecovery && !shouldAttemptLocalAssetRecovery(page, false)) {
    // Also opportunistically cache server asset locally in IndexedDB if we don't have it yet
    void ensurePageOriginalCachedLocally(page);
    return { page, recovered: false };
  }

  const existingInFlight = inFlightPageRestore.get(page.id);
  if (existingInFlight) {
    const restored = await existingInFlight;
    if (restored) {
      return { page: restored, recovered: true, dataUrl: fallbackSrcCache.get(restored.originalImage) };
    }
  }

  const runRecovery = (async (): Promise<Page | null> => {
    const localAsset = await findLocalAssetForPage(page);
    if (!localAsset?.originalDataUrl) {
      return null;
    }

    if (page.originalImage) {
      registerLocalFallbackSrc(page.originalImage, localAsset.originalDataUrl);
    }
    registerLocalFallbackSrc(page.id, localAsset.originalDataUrl);

    // Re-upload the lost image silently to restore server disk state without wiping regions/translations
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      try {
        const res = await api.restorePageAsset(page.id, {
          dataUrl: localAsset.originalDataUrl,
          width: localAsset.width || page.width,
          height: localAsset.height || page.height,
          contentHash: localAsset.contentHash || page.contentHash,
        });
        if (res?.page) {
          registerLocalFallbackSrc(res.page.originalImage, localAsset.originalDataUrl);
          await savePageAssetsBatch([
            {
              ...localAsset,
              serverUrl: res.page.originalImage,
              updatedAt: new Date().toISOString(),
            },
          ]);
          return { ...res.page, assetMissing: false };
        }
      } catch {
        // Offline or server busy — client still displays local IndexedDB copy immediately!
      }
    }

    return {
      ...page,
      originalImage: localAsset.originalDataUrl,
      assetMissing: false,
    };
  })();

  inFlightPageRestore.set(page.id, runRecovery);
  try {
    const restoredPage = await runRecovery;
    if (restoredPage) {
      return {
        page: restoredPage,
        recovered: true,
        dataUrl: fallbackSrcCache.get(restoredPage.originalImage) || fallbackSrcCache.get(page.id),
      };
    }
    return { page, recovered: false };
  } finally {
    inFlightPageRestore.delete(page.id);
  }
}

/**
 * Ensures any newly encountered server-hosted page gets cached in IndexedDB (`page_assets`)
 * if not yet present, protecting older chapters automatically upon viewing.
 */
export async function ensurePageOriginalCachedLocally(page: Page): Promise<void> {
  if (!page?.id || !page.originalImage || page.assetMissing) return;
  try {
    const existing = await findLocalAssetForPage(page);
    if (existing?.originalDataUrl) return;
    if (page.originalImage.startsWith('data:')) {
      await savePageAssetsBatch([
        {
          pageId: page.id,
          chapterId: page.chapterId,
          contentHash: page.contentHash,
          order: page.pageNumber,
          width: page.width || 900,
          height: page.height || 1200,
          originalDataUrl: page.originalImage,
          serverUrl: page.originalImage,
          updatedAt: new Date().toISOString(),
        },
      ]);
      return;
    }
    if (!isServerUploadUrl(page.originalImage)) return;
    const resp = await fetch(page.originalImage);
    if (!resp.ok) return;
    const blob = await resp.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    registerLocalFallbackSrc(page.originalImage, dataUrl);
    await savePageAssetsBatch([
      {
        pageId: page.id,
        chapterId: page.chapterId,
        contentHash: page.contentHash,
        order: page.pageNumber,
        width: page.width || 900,
        height: page.height || 1200,
        originalDataUrl: dataUrl,
        serverUrl: page.originalImage,
        updatedAt: new Date().toISOString(),
      },
    ]);
  } catch {
    // Best-effort background local backup
  }
}

/**
 * Persists a batch of freshly uploaded pages together with their local original Data URLs
 * immediately into `FaqqaOfflineDB` (`page_assets`), so images never depend solely on ephemeral server storage.
 */
export async function persistUploadedPagesToLocalAssets(params: {
  projectId: string;
  chapterId: string;
  uploadedPages: Page[];
  sourceAssets: Array<{ dataUrl: string; filename?: string; width?: number; height?: number; contentHash?: string }>;
}): Promise<void> {
  const { projectId, chapterId, uploadedPages, sourceAssets } = params;
  const records: StoredPageAsset[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < uploadedPages.length; i++) {
    const pg = uploadedPages[i];
    const matchedSrc =
      (pg.contentHash && sourceAssets.find((s) => s.contentHash && s.contentHash === pg.contentHash)) ||
      sourceAssets[i];
    const dataUrl = matchedSrc?.dataUrl || (pg.originalImage.startsWith('data:') ? pg.originalImage : '');
    if (!dataUrl) continue;

    registerLocalFallbackSrc(pg.originalImage, dataUrl);
    registerLocalFallbackSrc(pg.id, dataUrl);
    records.push({
      pageId: pg.id,
      chapterId,
      projectId,
      contentHash: pg.contentHash || matchedSrc?.contentHash,
      filename: matchedSrc?.filename,
      order: pg.pageNumber,
      width: pg.width || matchedSrc?.width || 900,
      height: pg.height || matchedSrc?.height || 1200,
      originalDataUrl: dataUrl,
      serverUrl: pg.originalImage,
      updatedAt: now,
    });
  }

  if (records.length > 0) {
    await savePageAssetsBatch(records);
  }
}
