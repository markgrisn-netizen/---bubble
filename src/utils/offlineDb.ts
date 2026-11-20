import type { Chapter, Page, Project, TranslationJob } from '../types/domain';
import { isQuotaExceededError } from './offlineUtils';
import { selectMatchingLocalAsset } from './persistenceUtils';

const DB_NAME = 'FaqqaOfflineDB';
const DB_VERSION = 4;
const STORE_CHAPTERS = 'offline_chapters';
const STORE_PROJECTS = 'offline_projects';
const STORE_DRAFTS = 'staged_picker_drafts';
const STORE_PAGE_ASSETS = 'page_assets';
const STORE_JOB_SNAPSHOTS = 'job_snapshots';

export class OfflineQuotaError extends Error {
  constructor(message = 'Device storage quota exceeded while saving offline data.') {
    super(message);
    this.name = 'OfflineQuotaError';
  }
}

export interface StagedPickerDraftItem {
  id: string;
  filename: string;
  dataUrl: string;
  width: number;
  height: number;
  contentHash: string;
  byteSize: number;
  rotation?: 0 | 90 | 180 | 270;
}

export interface StagedPickerDraft {
  key: string;
  pages: StagedPickerDraftItem[];
  updatedAt: string;
}

export interface StoredPageAsset {
  pageId: string;
  chapterId: string;
  projectId?: string;
  contentHash?: string;
  filename?: string;
  order: number;
  width: number;
  height: number;
  originalDataUrl: string;
  processedDataUrl?: string;
  serverUrl?: string;
  updatedAt: string;
}

export interface StoredChapterRecoverySnapshot {
  chapterId: string;
  projectId: string;
  project: Project;
  chapter: Chapter;
  pages: Page[];
  activeJob?: TranslationJob | null;
  activePageId?: string;
  lastUpdatedAt: string;
}

export interface OfflineChapterBundle {
  chapterId: string;
  projectId: string;
  project: Project;
  chapter: Chapter;
  pages: Page[]; // Pre-rendered processedImage (+ optional originalImage) dataUrls
  includeOriginals: boolean;
  totalBytes: number;
  complete: boolean;
  lastReadPage?: number;
  savedAt: string;
}

export interface OfflineProjectRecord {
  projectId: string;
  project: Project;
  chapterIds: string[];
  totalBytes: number;
  savedAt: string;
}

export interface OfflineStorageEstimate {
  usedBytes: number;
  quotaBytes: number;
  bundleBytes: number;
}

function estimateBundleBytes(pages: Page[]): number {
  let total = 0;
  for (const p of pages) {
    total += (p.processedImage?.length || 0) + (p.originalImage?.length || 0);
  }
  return total;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        db.createObjectStore(STORE_CHAPTERS, { keyPath: 'chapterId' });
      }
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_PAGE_ASSETS)) {
        const assetStore = db.createObjectStore(STORE_PAGE_ASSETS, { keyPath: 'pageId' });
        assetStore.createIndex('chapterId', 'chapterId', { unique: false });
        assetStore.createIndex('contentHash', 'contentHash', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_JOB_SNAPSHOTS)) {
        db.createObjectStore(STORE_JOB_SNAPSHOTS, { keyPath: 'chapterId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function imageSrcToInlineDataUrl(src: string): Promise<string> {
  if (!src) return '';
  if (src.startsWith('data:')) return src;
  const resp = await fetch(src);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image asset (${resp.status})`);
  }
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// =========================================================================
// Permanent Local Page Asset Store (survives reloads, backgrounding & /uploads resets)
// =========================================================================

export async function savePageAssetsBatch(assets: StoredPageAsset[]): Promise<void> {
  if (!assets.length || typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PAGE_ASSETS, 'readwrite');
      const store = tx.objectStore(STORE_PAGE_ASSETS);
      for (const item of assets) {
        if (!item.pageId || !item.originalDataUrl) continue;
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new OfflineQuotaError());
    });
  } catch {
    // Best-effort persistence: never crash primary UI if storage is restricted
  }
}

export async function getAllPageAssets(): Promise<StoredPageAsset[]> {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PAGE_ASSETS, 'readonly');
      const req = tx.objectStore(STORE_PAGE_ASSETS).getAll();
      req.onsuccess = () => resolve((req.result as StoredPageAsset[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getChapterPageAssets(chapterId: string): Promise<StoredPageAsset[]> {
  if (!chapterId || typeof indexedDB === 'undefined') return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PAGE_ASSETS, 'readonly');
      const store = tx.objectStore(STORE_PAGE_ASSETS);
      if (store.indexNames.contains('chapterId')) {
        const req = store.index('chapterId').getAll(chapterId);
        req.onsuccess = () => resolve((req.result as StoredPageAsset[]) || []);
        req.onerror = () => reject(req.error);
      } else {
        const req = store.getAll();
        req.onsuccess = () =>
          resolve(
            ((req.result as StoredPageAsset[]) || []).filter((a) => a.chapterId === chapterId)
          );
        req.onerror = () => reject(req.error);
      }
    });
  } catch {
    return [];
  }
}

export async function findLocalAssetForPage(
  page: Pick<Page, 'id' | 'chapterId' | 'contentHash' | 'originalImage'>
): Promise<StoredPageAsset | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const chapterAssets = await getChapterPageAssets(page.chapterId);
    const direct = selectMatchingLocalAsset(page, chapterAssets);
    if (direct) return direct;

    const allAssets = await getAllPageAssets();
    const globalMatch = selectMatchingLocalAsset(page, allAssets);
    if (globalMatch) return globalMatch;

    // Last fallback: check if chapter is saved in offline_chapters bundle
    const offline = await getOfflineChapter(page.chapterId).catch(() => null);
    if (offline) {
      const offMatch = offline.pages.find(
        (op) =>
          (op.id === page.id || (page.contentHash && op.contentHash === page.contentHash)) &&
          Boolean(op.originalImage && op.originalImage.startsWith('data:'))
      );
      if (offMatch) {
        return {
          pageId: page.id,
          chapterId: page.chapterId,
          projectId: offline.projectId,
          contentHash: offMatch.contentHash || page.contentHash,
          order: offMatch.pageNumber,
          width: offMatch.width,
          height: offMatch.height,
          originalDataUrl: offMatch.originalImage,
          processedDataUrl: offMatch.processedImage,
          serverUrl: page.originalImage,
          updatedAt: offline.savedAt,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function findLocalAssetByServerUrl(serverUrl: string): Promise<StoredPageAsset | null> {
  if (!serverUrl || typeof indexedDB === 'undefined') return null;
  try {
    const allAssets = await getAllPageAssets();
    const matched = allAssets.find(
      (a) => a.serverUrl === serverUrl && Boolean(a.originalDataUrl)
    );
    if (matched) return matched;
    return null;
  } catch {
    return null;
  }
}

export async function updatePageAssetProcessed(
  page: Pick<Page, 'id' | 'chapterId' | 'pageNumber' | 'width' | 'height' | 'contentHash' | 'originalImage'>,
  processedDataUrl: string
): Promise<void> {
  if (!processedDataUrl || typeof indexedDB === 'undefined') return;
  try {
    const existing = await findLocalAssetForPage(page);
    if (!existing) return;
    await savePageAssetsBatch([
      {
        ...existing,
        processedDataUrl,
        updatedAt: new Date().toISOString(),
      },
    ]);
  } catch {
    // Ignore non-critical processed preview update errors
  }
}

export async function deleteChapterPageAssets(chapterId: string): Promise<void> {
  if (!chapterId || typeof indexedDB === 'undefined') return;
  try {
    const items = await getChapterPageAssets(chapterId);
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_PAGE_ASSETS, STORE_JOB_SNAPSHOTS], 'readwrite');
      const assetStore = tx.objectStore(STORE_PAGE_ASSETS);
      for (const item of items) {
        assetStore.delete(item.pageId);
      }
      tx.objectStore(STORE_JOB_SNAPSHOTS).delete(chapterId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore cleanup errors
  }
}

// =========================================================================
// Chapter & Translation Job Auto-Save Snapshots
// =========================================================================

export async function saveChapterRecoverySnapshot(
  snapshot: StoredChapterRecoverySnapshot
): Promise<void> {
  if (!snapshot.chapterId || typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_JOB_SNAPSHOTS, 'readwrite');
      tx.objectStore(STORE_JOB_SNAPSHOTS).put(snapshot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort snapshot persistence
  }
}

export async function getChapterRecoverySnapshot(
  chapterId: string
): Promise<StoredChapterRecoverySnapshot | null> {
  if (!chapterId || typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_JOB_SNAPSHOTS, 'readonly');
      const req = tx.objectStore(STORE_JOB_SNAPSHOTS).get(chapterId);
      req.onsuccess = () => resolve((req.result as StoredChapterRecoverySnapshot) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function listChapterRecoverySnapshots(): Promise<StoredChapterRecoverySnapshot[]> {
  if (typeof indexedDB === 'undefined') return [];
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_JOB_SNAPSHOTS, 'readonly');
      const req = tx.objectStore(STORE_JOB_SNAPSHOTS).getAll();
      req.onsuccess = () => resolve((req.result as StoredChapterRecoverySnapshot[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

// =========================================================================
// Existing Offline Reading Bundle Store
// =========================================================================

export async function saveOfflineChapterBundle(params: {
  project: Project;
  chapter: Chapter;
  pages: Page[];
  includeOriginals: boolean;
  complete: boolean;
}): Promise<OfflineChapterBundle> {
  const { project, chapter, pages, includeOriginals, complete } = params;
  const totalBytes = estimateBundleBytes(pages);
  const now = new Date().toISOString();

  const existing = await getOfflineChapter(chapter.id).catch(() => null);
  const bundle: OfflineChapterBundle = {
    chapterId: chapter.id,
    projectId: project.id,
    project,
    chapter,
    pages,
    includeOriginals,
    totalBytes,
    complete,
    lastReadPage: existing?.lastReadPage ?? chapter.lastReadPage ?? 1,
    savedAt: now,
  };

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_CHAPTERS, STORE_PROJECTS], 'readwrite');
      const chStore = tx.objectStore(STORE_CHAPTERS);
      const prStore = tx.objectStore(STORE_PROJECTS);

      chStore.put(bundle);

      const getProjReq = prStore.get(project.id);
      getProjReq.onsuccess = () => {
        const prev = getProjReq.result as OfflineProjectRecord | undefined;
        const chapterIds = Array.from(new Set([...(prev?.chapterIds || []), chapter.id]));
        const nextProjectRec: OfflineProjectRecord = {
          projectId: project.id,
          project,
          chapterIds,
          totalBytes:
            (prev?.totalBytes || 0) - (existing?.totalBytes || 0) + bundle.totalBytes,
          savedAt: now,
        };
        prStore.put(nextProjectRec);
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new OfflineQuotaError());
    });
    return bundle;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      throw new OfflineQuotaError();
    }
    throw err;
  }
}

export async function saveChapterOffline(
  project: Project,
  chapter: Chapter,
  pages: Page[],
  includeOriginals = true
): Promise<OfflineChapterBundle> {
  const inlinedPages: Page[] = [];
  for (const p of pages) {
    let originalImage = p.originalImage;
    if (includeOriginals) {
      try {
        originalImage = await imageSrcToInlineDataUrl(p.originalImage);
      } catch {
        const localAsset = await findLocalAssetForPage(p);
        if (localAsset?.originalDataUrl) {
          originalImage = localAsset.originalDataUrl;
        }
      }
    }
    inlinedPages.push({ ...p, originalImage });
  }

  return saveOfflineChapterBundle({
    project,
    chapter,
    pages: inlinedPages,
    includeOriginals,
    complete: true,
  });
}

export async function getOfflineChapter(chapterId: string): Promise<OfflineChapterBundle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTERS, 'readonly');
    const req = tx.objectStore(STORE_CHAPTERS).get(chapterId);
    req.onsuccess = () => {
      const res = req.result as OfflineChapterBundle | undefined;
      if (res && !res.projectId && res.project) {
        res.projectId = res.project.id;
      }
      resolve(res || null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function listOfflineChapters(): Promise<OfflineChapterBundle[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly');
      const req = tx.objectStore(STORE_CHAPTERS).getAll();
      req.onsuccess = () => {
        const list = ((req.result as OfflineChapterBundle[]) || []).map((b) => ({
          ...b,
          projectId: b.projectId || b.project?.id || '',
        }));
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function listOfflineProjects(): Promise<OfflineProjectRecord[]> {
  try {
    const db = await openDb();
    const [projs, chapters] = await Promise.all([
      new Promise<OfflineProjectRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_PROJECTS, 'readonly');
        const req = tx.objectStore(STORE_PROJECTS).getAll();
        req.onsuccess = () => resolve((req.result as OfflineProjectRecord[]) || []);
        req.onerror = () => reject(req.error);
      }),
      listOfflineChapters(),
    ]);

    const byProject = new Map<string, OfflineProjectRecord>();
    for (const p of projs) {
      byProject.set(p.projectId, { ...p, chapterIds: [], totalBytes: 0 });
    }
    for (const ch of chapters) {
      const pid = ch.projectId || ch.project.id;
      const rec = byProject.get(pid) || {
        projectId: pid,
        project: ch.project,
        chapterIds: [],
        totalBytes: 0,
        savedAt: ch.savedAt,
      };
      rec.chapterIds.push(ch.chapterId);
      rec.totalBytes += ch.totalBytes || estimateBundleBytes(ch.pages);
      if (ch.savedAt > rec.savedAt) rec.savedAt = ch.savedAt;
      byProject.set(pid, rec);
    }

    return Array.from(byProject.values()).filter((p) => p.chapterIds.length > 0);
  } catch {
    return [];
  }
}

export async function listOfflineChapterIds(): Promise<string[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly');
      const req = tx.objectStore(STORE_CHAPTERS).getAllKeys();
      req.onsuccess = () => resolve((req.result as string[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function updateOfflineChapterLastReadPage(
  chapterId: string,
  lastReadPage: number
): Promise<void> {
  try {
    const existing = await getOfflineChapter(chapterId);
    if (!existing) return;
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite');
      const updated: OfflineChapterBundle = {
        ...existing,
        lastReadPage,
        chapter: {
          ...existing.chapter,
          lastReadPage,
        },
      };
      tx.objectStore(STORE_CHAPTERS).put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort offline progress persistence
  }
}

export async function removeOfflineChapter(chapterId: string): Promise<void> {
  const existing = await getOfflineChapter(chapterId).catch(() => null);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAPTERS, STORE_PROJECTS], 'readwrite');
    tx.objectStore(STORE_CHAPTERS).delete(chapterId);
    if (existing?.projectId) {
      const prStore = tx.objectStore(STORE_PROJECTS);
      const req = prStore.get(existing.projectId);
      req.onsuccess = () => {
        const rec = req.result as OfflineProjectRecord | undefined;
        if (!rec) return;
        const nextIds = rec.chapterIds.filter((id) => id !== chapterId);
        if (nextIds.length === 0) {
          prStore.delete(existing.projectId);
        } else {
          prStore.put({
            ...rec,
            chapterIds: nextIds,
            totalBytes: Math.max(0, rec.totalBytes - (existing.totalBytes || 0)),
          });
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeOfflineProject(projectId: string): Promise<void> {
  const chapters = await listOfflineChapters();
  const targetChapterIds = chapters
    .filter((c) => (c.projectId || c.project.id) === projectId)
    .map((c) => c.chapterId);

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CHAPTERS, STORE_PROJECTS], 'readwrite');
    const chStore = tx.objectStore(STORE_CHAPTERS);
    const prStore = tx.objectStore(STORE_PROJECTS);
    for (const cid of targetChapterIds) {
      chStore.delete(cid);
    }
    prStore.delete(projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOfflineStorageEstimate(): Promise<OfflineStorageEstimate> {
  const chapters = await listOfflineChapters();
  const bundleBytes = chapters.reduce(
    (sum, c) => sum + (c.totalBytes || estimateBundleBytes(c.pages)),
    0
  );
  let usedBytes = bundleBytes;
  let quotaBytes = 0;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === 'number') usedBytes = est.usage;
      if (typeof est.quota === 'number') quotaBytes = est.quota;
    }
  } catch {
    // Fallback cleanly when StorageManager estimate is unavailable
  }
  return { usedBytes, quotaBytes, bundleBytes };
}

export async function saveStagedPickerDraft(
  key: string,
  pages: StagedPickerDraftItem[]
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DRAFTS, 'readwrite');
      if (pages.length === 0) {
        tx.objectStore(STORE_DRAFTS).delete(key);
      } else {
        tx.objectStore(STORE_DRAFTS).put({
          key,
          pages,
          updatedAt: new Date().toISOString(),
        } satisfies StagedPickerDraft);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort resilience layer
  }
}

export async function loadStagedPickerDraft(key: string): Promise<StagedPickerDraftItem[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_DRAFTS, 'readonly');
      const req = tx.objectStore(STORE_DRAFTS).get(key);
      req.onsuccess = () => {
        const res = req.result as StagedPickerDraft | undefined;
        resolve(Array.isArray(res?.pages) ? res.pages : []);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function clearStagedPickerDraft(key: string): Promise<void> {
  await saveStagedPickerDraft(key, []);
}
