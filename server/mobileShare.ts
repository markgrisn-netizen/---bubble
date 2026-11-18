import crypto from 'crypto';
import JSZip from 'jszip';
import type { Chapter, ComicFormat, Page, ReadingDirection, TranslationStyle } from '../src/types/domain.ts';
import { sortPageFilenames } from '../src/utils/bubbleLayout.ts';
import { validateAndDecodeImageDataUrl } from './browserImport.ts';
import { appendLog, getDb, saveBase64Asset, saveDb } from './store.ts';

function inferMimeFromFilename(name: string): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

export interface MobileShareImportRequest {
  projectId?: string;
  newProjectConfig?: {
    title: string;
    comicFormat: ComicFormat;
    sourceLanguage: string;
    targetLanguage: string;
    readingDirection: ReadingDirection;
    translationStyle: TranslationStyle;
  };
  chapterTitle?: string;
  sourcePlatform?: 'android_share_intent' | 'android_webview' | 'web_share_target';
  images?: Array<{ dataUrl: string; filename?: string; width?: number; height?: number }>;
  archiveBase64?: string;
  archiveFilename?: string;
}

/**
 * Handles Android Share Intent (ACTION_SEND / ACTION_SEND_MULTIPLE) and Web Share Target
 * payloads containing single/multiple images or CBZ/ZIP comic archives, importing pages
 * straight into a Studio project without external link refetching.
 */
export async function importMobileSharePayload(
  payload: MobileShareImportRequest
): Promise<{ projectId: string; chapter: Chapter; pages: Page[] }> {
  const extractedPages: Array<{ dataUrl: string; width: number; height: number }> = [];

  if (Array.isArray(payload.images)) {
    for (const img of payload.images) {
      if (!img?.dataUrl) continue;
      const validated = validateAndDecodeImageDataUrl(img.dataUrl);
      extractedPages.push({
        dataUrl: validated.dataUrl,
        width: typeof img.width === 'number' && img.width > 0 ? Math.round(img.width) : 900,
        height: typeof img.height === 'number' && img.height > 0 ? Math.round(img.height) : 1200,
      });
    }
  }

  if (payload.archiveBase64) {
    const cleanB64 = payload.archiveBase64.replace(/^data:[^;]+;base64,/, '');
    const archiveBuf = Buffer.from(cleanB64, 'base64');
    const zip = await JSZip.loadAsync(archiveBuf);
    const entryNames = sortPageFilenames(
      Object.keys(zip.files).filter((name) => {
        const entry = zip.files[name];
        return !entry.dir && !name.startsWith('__MACOSX') && inferMimeFromFilename(name) !== null;
      })
    );

    for (const name of entryNames) {
      const mime = inferMimeFromFilename(name)!;
      const buf = await zip.files[name].async('nodebuffer');
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const validated = validateAndDecodeImageDataUrl(dataUrl);
      extractedPages.push({
        dataUrl: validated.dataUrl,
        width: 900,
        height: 1200,
      });
    }
  }

  if (extractedPages.length === 0) {
    throw new Error('لم يتم العثور على صور أو صفحات CBZ/ZIP صالحة في حزمة المشاركة.');
  }

  const db = getDb();
  const now = new Date().toISOString();
  let targetProject = payload.projectId
    ? db.projects.find((p) => p.id === payload.projectId)
    : undefined;

  if (!targetProject) {
    const cfg = payload.newProjectConfig;
    if (cfg && cfg.title?.trim()) {
      targetProject = {
        id: `proj-${crypto.randomBytes(4).toString('hex')}`,
        userId: db.user.id,
        title: cfg.title.trim(),
        comicFormat: cfg.comicFormat || 'superhero',
        sourceLanguage: cfg.sourceLanguage || 'en',
        targetLanguage: cfg.targetLanguage || 'ar',
        readingDirection: cfg.readingDirection || 'ltr',
        translationStyle: cfg.translationStyle || 'cinematic',
        storyMemory: {
          characters: [],
          locations: [],
          recurringNotes: '',
          chapterSummaries: [],
        },
        createdAt: now,
        updatedAt: now,
      };
      db.projects.unshift(targetProject);
    } else if (db.projects[0]) {
      targetProject = db.projects[0];
    } else {
      throw new Error('لا يوجد مشروع مستهدف للاستيراد.');
    }
  }

  const chapterNum = db.chapters.filter((c) => c.projectId === targetProject!.id).length + 1;
  const chapter: Chapter = {
    id: `ch-${crypto.randomBytes(4).toString('hex')}`,
    projectId: targetProject.id,
    title: (
      payload.chapterTitle ||
      payload.archiveFilename?.replace(/\.(cbz|zip|pdf)$/i, '') ||
      `Mobile Share #${chapterNum}`
    ).trim(),
    chapterNumber: chapterNum,
    pageCount: extractedPages.length,
    status: 'draft',
    lastReadPage: 1,
    createdAt: now,
    updatedAt: now,
  };

  const createdPages: Page[] = extractedPages.map((p, idx) => {
    const saved = saveBase64Asset(p.dataUrl, `mobile_share_p${idx + 1}`);
    return {
      id: `pg-${crypto.randomBytes(4).toString('hex')}`,
      chapterId: chapter.id,
      pageNumber: idx + 1,
      originalImage: saved.url,
      status: 'pending',
      width: p.width,
      height: p.height,
      rotation: 0,
      manualStrokes: [],
      panels: [],
      regions: [],
    };
  });

  if (!targetProject.coverImage && createdPages[0]) {
    targetProject.coverImage = createdPages[0].originalImage;
  }
  targetProject.updatedAt = now;
  db.chapters.push(chapter);
  db.pages.push(...createdPages);
  saveDb();

  appendLog(
    'info',
    'CHAPTER_MOBILE_SHARE_IMPORTED',
    `Imported ${createdPages.length} page(s) via ${payload.sourcePlatform || 'android_share_intent'} into "${chapter.title}"`,
    { projectId: targetProject.id, chapterId: chapter.id }
  );

  return { projectId: targetProject.id, chapter, pages: createdPages };
}
