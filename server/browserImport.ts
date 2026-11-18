import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Chapter, Page } from '../src/types/domain.ts';
import { appendLog, ensureDataDirs, getDb, saveBase64Asset, saveDb } from './store.ts';

export type CaptureMethod =
  | 'dom_image'
  | 'canvas_capture'
  | 'visible_tab_crop'
  | 'visible_tab_full'
  | 'auto_collect';

export interface BrowserCapturedPageRecord {
  id: string;
  pageNumber: number;
  imageUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  capturedAt: string;
  captureMethod: CaptureMethod;
  sha256: string;
  byteSize: number;
}

export interface BrowserImportSession {
  id: string;
  tokenHash: string;
  projectId?: string;
  newProjectConfig?: {
    title: string;
    comicFormat: 'manga' | 'manhwa' | 'manhua' | 'comic' | 'webtoon';
    sourceLanguage: string;
    targetLanguage: string;
    readingDirection: 'rtl' | 'ltr' | 'vertical';
    translationStyle:
      | 'natural_pro'
      | 'faithful'
      | 'cinematic'
      | 'literary'
      | 'simplified'
      | 'literal'
      | 'character_voice';
  };
  chapterTitle: string;
  targetUrl?: string;
  status: 'waiting' | 'collecting' | 'completed' | 'expired';
  pages: BrowserCapturedPageRecord[];
  chapterId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const SESSIONS_FILE = path.resolve(process.cwd(), 'data', 'browser_sessions.json');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB per image
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

let sessionCache: BrowserImportSession[] | null = null;

function loadSessions(): BrowserImportSession[] {
  ensureDataDirs();
  if (sessionCache) return sessionCache;
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')) as BrowserImportSession[];
      if (Array.isArray(parsed)) {
        sessionCache = parsed;
        return sessionCache;
      }
    } catch {
      // Fallback to empty array if corrupted
    }
  }
  sessionCache = [];
  return sessionCache;
}

function saveSessions(): void {
  ensureDataDirs();
  if (!sessionCache) return;
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessionCache, null, 2), 'utf-8');
  fs.renameSync(tmp, SESSIONS_FILE);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface ValidatedImageBuffer {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  buffer: Buffer;
  dataUrl: string;
  sha256: string;
}

/**
 * Validates that an uploaded data URL is genuinely PNG, JPEG, or WebP by checking magic bytes
 * (not just the declared MIME string) and enforcing per-page size limits.
 */
export function validateAndDecodeImageDataUrl(dataUrl: string): ValidatedImageBuffer {
  if (typeof dataUrl !== 'string') {
    throw new Error('صيغة بيانات الصورة غير صالحة.');
  }
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    throw new Error('يُسمح فقط بصور PNG أو JPEG أو WebP بصيغة Base64 صالحة.');
  }

  const rawBuffer = Buffer.from(match[2], 'base64');
  if (rawBuffer.length === 0) {
    throw new Error('ملف الصورة فارغ.');
  }
  if (rawBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error('تجاوز حجم الصورة الحد الأقصى المسموح (15 MB).');
  }

  // Magic-byte verification
  const isPng =
    rawBuffer.length >= 8 &&
    rawBuffer[0] === 0x89 &&
    rawBuffer[1] === 0x50 &&
    rawBuffer[2] === 0x4e &&
    rawBuffer[3] === 0x47;
  const isJpeg =
    rawBuffer.length >= 3 &&
    rawBuffer[0] === 0xff &&
    rawBuffer[1] === 0xd8 &&
    rawBuffer[2] === 0xff;
  const isWebp =
    rawBuffer.length >= 12 &&
    rawBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    rawBuffer.subarray(8, 12).toString('ascii') === 'WEBP';

  let verifiedMime: ValidatedImageBuffer['mime'];
  if (isPng) verifiedMime = 'image/png';
  else if (isJpeg) verifiedMime = 'image/jpeg';
  else if (isWebp) verifiedMime = 'image/webp';
  else {
    throw new Error('محتوى الملف لا يطابق توقيع صورة PNG أو JPEG أو WebP صالحة.');
  }

  const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');
  return {
    mime: verifiedMime,
    buffer: rawBuffer,
    dataUrl: `data:${verifiedMime};base64,${rawBuffer.toString('base64')}`,
    sha256,
  };
}

export function createBrowserImportSession(opts: {
  projectId?: string;
  newProjectConfig?: BrowserImportSession['newProjectConfig'];
  chapterTitle?: string;
  targetUrl?: string;
}): {
  session: Omit<BrowserImportSession, 'tokenHash'>;
  pairingToken: string;
} {
  const sessions = loadSessions();
  const now = Date.now();
  const pairingToken = crypto.randomBytes(24).toString('hex');
  const session: BrowserImportSession = {
    id: `bsess-${crypto.randomBytes(5).toString('hex')}`,
    tokenHash: hashToken(pairingToken),
    projectId: opts.projectId,
    newProjectConfig: opts.newProjectConfig,
    chapterTitle: (opts.chapterTitle || 'فصل من المتصفح').trim(),
    targetUrl: opts.targetUrl?.trim() || undefined,
    status: 'waiting',
    pages: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };

  sessions.unshift(session);
  // Keep latest 50 sessions
  if (sessions.length > 50) sessions.length = 50;
  saveSessions();

  const { tokenHash: _hidden, ...publicView } = session;
  return { session: publicView, pairingToken };
}

export function getBrowserImportSessionPublic(
  sessionId: string
): Omit<BrowserImportSession, 'tokenHash'> | null {
  const sessions = loadSessions();
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) return null;
  if (found.status !== 'completed' && new Date(found.expiresAt).getTime() < Date.now()) {
    found.status = 'expired';
    saveSessions();
  }
  const { tokenHash: _hidden, ...publicView } = found;
  return publicView;
}

export function verifyBrowserSessionAuth(sessionId: string, bearerToken?: string): BrowserImportSession {
  const sessions = loadSessions();
  const found = sessions.find((s) => s.id === sessionId);
  if (!found) {
    throw new Error('جلسة الاستيراد من المتصفح غير موجودة.');
  }
  if (new Date(found.expiresAt).getTime() < Date.now()) {
    found.status = 'expired';
    saveSessions();
    throw new Error('انتهت صلاحية جلسة الربط. يرجى إنشاء جلسة جديدة من التطبيق.');
  }
  if (!bearerToken || hashToken(bearerToken.trim()) !== found.tokenHash) {
    throw new Error('رمز المصادقة (Pairing Token) غير صالح أو مفقود.');
  }
  return found;
}

export interface IncomingBrowserPagePayload {
  dataUrl: string;
  pageNumber?: number;
  sourceUrl?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
  captureMethod?: CaptureMethod;
}

export function appendPagesToBrowserSession(
  sessionId: string,
  bearerToken: string,
  incomingPages: IncomingBrowserPagePayload[],
  opts?: { replaceExisting?: boolean }
): {
  session: Omit<BrowserImportSession, 'tokenHash'>;
  addedCount: number;
} {
  const session = verifyBrowserSessionAuth(sessionId, bearerToken);
  if (session.status === 'completed') {
    throw new Error('تم إكمال هذه الجلسة وإدخالها إلى الاستوديو مسبقاً.');
  }

  if (!Array.isArray(incomingPages) || incomingPages.length === 0) {
    throw new Error('يجب إرسال صفحة واحدة على الأقل.');
  }

  if (opts?.replaceExisting) {
    session.pages = [];
  }

  let addedCount = 0;
  for (let i = 0; i < incomingPages.length; i++) {
    const item = incomingPages[i];
    const validated = validateAndDecodeImageDataUrl(item.dataUrl);

    // Strip any query auth tokens if needed; keep clean reference URL only
    let safeRefUrl = '';
    if (item.sourceUrl) {
      try {
        const u = new URL(item.sourceUrl);
        safeRefUrl = `${u.origin}${u.pathname}`;
      } catch {
        safeRefUrl = '';
      }
    }

    const saved = saveBase64Asset(validated.dataUrl, `browser_${session.id}_p${session.pages.length + 1}`);
    const pageNum =
      typeof item.pageNumber === 'number' && item.pageNumber > 0
        ? Math.floor(item.pageNumber)
        : session.pages.length + 1;

    session.pages.push({
      id: `bpg-${crypto.randomBytes(4).toString('hex')}`,
      pageNumber: pageNum,
      imageUrl: saved.url,
      sourceUrl: safeRefUrl,
      width: typeof item.width === 'number' && item.width > 0 ? Math.round(item.width) : 900,
      height: typeof item.height === 'number' && item.height > 0 ? Math.round(item.height) : 1200,
      capturedAt: item.capturedAt || new Date().toISOString(),
      captureMethod: item.captureMethod || 'visible_tab_full',
      sha256: validated.sha256,
      byteSize: validated.buffer.length,
    });
    addedCount++;
  }

  // Sort strictly by pageNumber and normalize sequence
  session.pages.sort((a, b) => a.pageNumber - b.pageNumber);
  session.pages.forEach((p, idx) => {
    p.pageNumber = idx + 1;
  });
  session.status = 'collecting';
  session.updatedAt = new Date().toISOString();
  saveSessions();

  const { tokenHash: _hidden, ...publicView } = session;
  return { session: publicView, addedCount };
}

export function completeBrowserImportSession(
  sessionId: string,
  opts: { bearerToken?: string; allowLocalOwner?: boolean; chapterTitleOverride?: string }
): {
  session: Omit<BrowserImportSession, 'tokenHash'>;
  chapter: Chapter;
  pages: Page[];
  projectId: string;
} {
  const sessions = loadSessions();
  const session = opts.allowLocalOwner
    ? sessions.find((s) => s.id === sessionId)
    : verifyBrowserSessionAuth(sessionId, opts.bearerToken);

  if (!session) {
    throw new Error('جلسة الاستيراد من المتصفح غير موجودة.');
  }

  if (session.status === 'completed' && session.chapterId) {
    const db = getDb();
    const existingChapter = db.chapters.find((c) => c.id === session.chapterId);
    if (existingChapter) {
      const existingPages = db.pages
        .filter((p) => p.chapterId === existingChapter.id)
        .sort((a, b) => a.pageNumber - b.pageNumber);
      const { tokenHash: _hidden, ...publicView } = session;
      return {
        session: publicView,
        chapter: existingChapter,
        pages: existingPages,
        projectId: existingChapter.projectId,
      };
    }
  }

  if (session.pages.length === 0) {
    throw new Error('لم يتم استلام أي صفحات في هذه الجلسة بعد.');
  }

  const db = getDb();
  const now = new Date().toISOString();
  let targetProject = session.projectId
    ? db.projects.find((p) => p.id === session.projectId)
    : undefined;

  if (!targetProject) {
    const cfg = session.newProjectConfig;
    if (cfg && cfg.title?.trim()) {
      targetProject = {
        id: `proj-${crypto.randomBytes(4).toString('hex')}`,
        userId: db.user.id,
        title: cfg.title.trim(),
        comicFormat: cfg.comicFormat || 'manga',
        sourceLanguage: cfg.sourceLanguage || 'ja',
        targetLanguage: cfg.targetLanguage || 'ar',
        readingDirection: cfg.readingDirection || 'rtl',
        translationStyle: cfg.translationStyle || 'natural_pro',
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
      throw new Error('لا يوجد مشروع مستهدف لاستيراد الفصل.');
    }
  }

  const existingChaptersCount = db.chapters.filter((c) => c.projectId === targetProject!.id).length;
  const chapter: Chapter = {
    id: `ch-${crypto.randomBytes(4).toString('hex')}`,
    projectId: targetProject.id,
    title: (opts.chapterTitleOverride || session.chapterTitle || `الفصل ${existingChaptersCount + 1}`).trim(),
    chapterNumber: existingChaptersCount + 1,
    pageCount: session.pages.length,
    status: 'draft',
    lastReadPage: 1,
    sourceUrl: session.targetUrl || session.pages[0]?.sourceUrl,
    createdAt: now,
    updatedAt: now,
  };

  const createdPages: Page[] = session.pages.map((bp, idx) => ({
    id: `pg-${crypto.randomBytes(4).toString('hex')}`,
    chapterId: chapter.id,
    pageNumber: idx + 1,
    originalImage: bp.imageUrl,
    status: 'pending',
    width: bp.width,
    height: bp.height,
    rotation: 0,
    manualStrokes: [],
    panels: [],
    regions: [],
  }));

  if (!targetProject.coverImage && createdPages[0]) {
    targetProject.coverImage = createdPages[0].originalImage;
  }
  targetProject.updatedAt = now;
  db.chapters.push(chapter);
  db.pages.push(...createdPages);
  saveDb();

  session.status = 'completed';
  session.chapterId = chapter.id;
  session.updatedAt = now;
  saveSessions();

  appendLog(
    'info',
    'CHAPTER_BROWSER_IMPORTED',
    `Imported ${createdPages.length} page(s) via Browser Companion into "${chapter.title}"`,
    { projectId: targetProject.id, chapterId: chapter.id }
  );

  const { tokenHash: _hidden, ...publicView } = session;
  return {
    session: publicView,
    chapter,
    pages: createdPages,
    projectId: targetProject.id,
  };
}
