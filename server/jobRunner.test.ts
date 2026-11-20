import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { Chapter, Page, Project, TextRegion, TranslationJob } from '../src/types/domain';
import { getDb, saveDb } from './store';
import {
  createTranslationJob,
  ensureActiveRunnersAlive,
  isJobRunnerActive,
  setJobRunnerHooksForTests,
} from './jobRunner';

const DB_FILE = path.resolve(process.cwd(), 'data', 'db.json');
let originalDbRaw: string | null = null;

function makeRegion(id: string, pageId: string, originalText: string): TextRegion {
  return {
    id,
    pageId,
    regionType: 'dialogue',
    boundingBox: { x: 100, y: 100, width: 200, height: 120 },
    boundingPolygon: [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 220 },
      { x: 100, y: 220 },
    ],
    originalText,
    translatedText: '',
    alternatives: [],
    sourceLanguage: 'en',
    confidence: 0.99,
    readingOrder: 1,
    fontSettings: {
      fontFamily: 'Cairo',
      fontSize: 16,
      fontWeight: '700',
      color: '#111111',
      align: 'center',
      lineHeight: 1.35,
      padding: 6,
      rotation: 0,
      direction: 'rtl',
      autoFit: true,
      offsetX: 0,
      offsetY: 0,
    },
    cleanMode: 'auto',
    sfxMode: 'keep',
    approvalStatus: 'approved',
    translationStatus: 'untranslated',
  };
}

function makeTestPage(id: string, chapterId: string, pageNumber: number, status: Page['status']): Page {
  return {
    id,
    chapterId,
    pageNumber,
    originalImage: `/uploads/${id}.webp`,
    status,
    width: 900,
    height: 1200,
    rotation: 0,
    manualStrokes: [],
    panels: [],
    regions: [],
  };
}

async function waitForJobSettled(jobId: string, timeoutMs = 4000): Promise<TranslationJob> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = getDb().jobs.find((j) => j.id === jobId);
    if (
      job &&
      (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
      !isJobRunnerActive(jobId)
    ) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to settle`);
}

before(() => {
  if (fs.existsSync(DB_FILE)) {
    originalDbRaw = fs.readFileSync(DB_FILE, 'utf-8');
  }
  getDb();
});

after(() => {
  setJobRunnerHooksForTests(undefined);
  if (originalDbRaw !== null) {
    const parsed = JSON.parse(originalDbRaw);
    const db = getDb();
    db.user = parsed.user;
    db.projects = parsed.projects;
    db.chapters = parsed.chapters;
    db.pages = parsed.pages;
    db.glossary = parsed.glossary;
    db.glossarySuggestions = parsed.glossarySuggestions;
    db.jobs = parsed.jobs;
    db.logs = parsed.logs;
    saveDb();
  }
});

test('orphaned running job auto-resumes via ensureActiveRunnersAlive without repeating completed pages', async () => {
  const db = getDb();
  const projectId = 'proj-test-orphan';
  const chapterId = 'ch-test-orphan';

  const project: Project = {
    id: projectId,
    userId: db.user.id,
    title: 'Orphan Recovery Test',
    comicFormat: 'superhero',
    sourceLanguage: 'en',
    targetLanguage: 'ar',
    readingDirection: 'ltr',
    translationStyle: 'cinematic',
    storyMemory: {
      characters: [],
      locations: [],
      recurringNotes: '',
      chapterSummaries: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const chapter: Chapter = {
    id: chapterId,
    projectId,
    title: 'Test Chapter 1',
    chapterNumber: 1,
    pageCount: 3,
    status: 'processing',
    lastReadPage: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const p1 = makeTestPage('pg-test-1', chapterId, 1, 'completed');
  p1.regions = [makeRegion('reg-t-1', p1.id, 'Done')];
  p1.regions[0].translatedText = 'تم';

  // Page 2 had OCR completed before interruption (regions already persisted!)
  const p2 = makeTestPage('pg-test-2', chapterId, 2, 'translating');
  p2.regions = [makeRegion('reg-t-2', p2.id, 'Watch out!')];

  // Page 3 has not started yet
  const p3 = makeTestPage('pg-test-3', chapterId, 3, 'pending');

  const jobId = 'job-test-orphan-1';
  const orphanJob: TranslationJob = {
    id: jobId,
    projectId,
    chapterId,
    chapterTitle: chapter.title,
    status: 'running',
    totalPages: 3,
    completedPages: 1,
    failedPages: 0,
    progress: 33,
    batchSize: 2,
    currentBatch: 1,
    totalBatches: 1,
    pageStates: {
      [p1.id]: 'skipped',
      [p2.id]: 'running', // interrupted mid-flight
      [p3.id]: 'queued',
    },
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  db.projects.unshift(project);
  db.chapters.unshift(chapter);
  db.pages.push(p1, p2, p3);
  db.jobs.unshift(orphanJob);

  const analyzedIds: string[] = [];
  const translatedPageIds: string[] = [];

  setJobRunnerHooksForTests({
    verifyAssetExists: () => true,
    analyzePage: async (page) => {
      analyzedIds.push(page.id);
      return {
        panels: [{ id: `panel-${page.id}`, box: { x: 0, y: 0, width: 1000, height: 1000 }, readingOrder: 1 }],
        regions: [makeRegion(`reg-${page.id}`, page.id, 'Hello hero')],
        providerUsed: 'gemini',
        modelUsed: 'mock-vision',
      };
    },
    translateRegions: async (regions) => {
      for (const r of regions) translatedPageIds.push(r.pageId);
      return {
        translations: regions.map((r) => ({
          id: r.id,
          translatedText: 'مرحباً أيها البطل',
          alternatives: [],
        })),
        providerUsed: 'gemini',
        modelUsed: 'mock-text',
        fallbackUsed: false,
      };
    },
  });

  const restarted = ensureActiveRunnersAlive(chapterId);
  assert.deepEqual(restarted, [jobId]);

  const settled = await waitForJobSettled(jobId);
  assert.equal(settled.status, 'completed');
  assert.equal(settled.completedPages, 3);
  assert.equal(settled.failedPages, 0);
  // P1 skipped, P2 already had regions so OCR wasn't repeated, only P3 analyzed!
  assert.deepEqual(analyzedIds, ['pg-test-3']);
  assert.deepEqual(translatedPageIds, ['pg-test-2', 'pg-test-3']);
  assert.equal(p2.status, 'completed');
  assert.equal(p3.status, 'completed');
});

test('missing image isolates failure to affected page and verification gate blocks empty translation', async () => {
  const db = getDb();
  const projectId = 'proj-test-isolated';
  const chapterId = 'ch-test-isolated';

  db.projects.unshift({
    id: projectId,
    userId: db.user.id,
    title: 'Isolation Test',
    comicFormat: 'superhero',
    sourceLanguage: 'en',
    targetLanguage: 'ar',
    readingDirection: 'ltr',
    translationStyle: 'cinematic',
    storyMemory: { characters: [], locations: [], recurringNotes: '', chapterSummaries: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.chapters.unshift({
    id: chapterId,
    projectId,
    title: 'Isolation Chapter',
    chapterNumber: 1,
    pageCount: 3,
    status: 'draft',
    lastReadPage: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const pMissing = makeTestPage('pg-iso-missing', chapterId, 1, 'pending');
  const pEmptyTr = makeTestPage('pg-iso-empty', chapterId, 2, 'pending');
  const pHealthy = makeTestPage('pg-iso-ok', chapterId, 3, 'pending');
  db.pages.push(pMissing, pEmptyTr, pHealthy);

  setJobRunnerHooksForTests({
    verifyAssetExists: (src) => src !== pMissing.originalImage,
    analyzePage: async (page) => ({
      panels: [],
      regions: [makeRegion(`reg-${page.id}`, page.id, 'Sample speech')],
      providerUsed: 'gemini',
      modelUsed: 'mock-vision',
    }),
    translateRegions: async (regions) => {
      if (regions[0]?.pageId === pEmptyTr.id) {
        // Simulate empty LLM output — verification gate must reject marking completed!
        return {
          translations: regions.map((r) => ({ id: r.id, translatedText: '   ', alternatives: [] })),
          providerUsed: 'gemini',
          modelUsed: 'mock-text',
          fallbackUsed: false,
        };
      }
      return {
        translations: regions.map((r) => ({
          id: r.id,
          translatedText: 'نص مترجم سليم',
          alternatives: [],
        })),
        providerUsed: 'gemini',
        modelUsed: 'mock-text',
        fallbackUsed: false,
      };
    },
  });

  const job = createTranslationJob(chapterId, { batchSize: 2 });
  const settled = await waitForJobSettled(job.id);

  assert.equal(pMissing.status, 'error');
  assert.match(pMissing.errorMessage || '', /SOURCE_IMAGE_MISSING/);

  // pEmptyTr must keep its OCR regions saved, but fail rather than fake completion
  assert.equal(pEmptyTr.status, 'error');
  assert.equal(pEmptyTr.regions.length, 1);

  // pHealthy still succeeds in the same batch!
  assert.equal(pHealthy.status, 'completed');
  assert.equal(settled.completedPages, 1);
  assert.equal(settled.failedPages, 2);
});
