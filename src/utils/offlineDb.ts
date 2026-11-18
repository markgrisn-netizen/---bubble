import type { Chapter, Page, Project } from '../types/domain';

const DB_NAME = 'PanelTranslateOfflineDB';
const DB_VERSION = 2;
const STORE_CHAPTERS = 'offline_chapters';
const STORE_DRAFTS = 'staged_picker_drafts';

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

export interface OfflineChapterBundle {
  chapterId: string;
  project: Project;
  chapter: Chapter;
  pages: Page[]; // Includes inline base64 originalImage for true offline viewing
  savedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        db.createObjectStore(STORE_CHAPTERS, { keyPath: 'chapterId' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function imageSrcToInlineDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  const resp = await fetch(src);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function saveChapterOffline(
  project: Project,
  chapter: Chapter,
  pages: Page[]
): Promise<OfflineChapterBundle> {
  const inlinedPages: Page[] = [];
  for (const p of pages) {
    let originalImage = p.originalImage;
    try {
      originalImage = await imageSrcToInlineDataUrl(p.originalImage);
    } catch {
      // Retain original URL if fetch fails
    }
    inlinedPages.push({ ...p, originalImage });
  }

  const bundle: OfflineChapterBundle = {
    chapterId: chapter.id,
    project,
    chapter,
    pages: inlinedPages,
    savedAt: new Date().toISOString(),
  };

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTERS, 'readwrite');
    tx.objectStore(STORE_CHAPTERS).put(bundle);
    tx.oncomplete = () => resolve(bundle);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOfflineChapter(chapterId: string): Promise<OfflineChapterBundle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTERS, 'readonly');
    const req = tx.objectStore(STORE_CHAPTERS).get(chapterId);
    req.onsuccess = () => resolve((req.result as OfflineChapterBundle) || null);
    req.onerror = () => reject(req.error);
  });
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

export async function removeOfflineChapter(chapterId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTERS, 'readwrite');
    tx.objectStore(STORE_CHAPTERS).delete(chapterId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
