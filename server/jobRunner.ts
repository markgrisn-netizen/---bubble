import crypto from 'crypto';
import type { AiProviderId, TranslationJob } from '../src/types/domain.ts';
import { appendLog, getDb, saveDb } from './store.ts';
import {
  analyzeComicPageWithProvider,
  normalizeAiProviderId,
  translateRegionsWithProvider,
} from './aiProviders.ts';
import {
  mergeStoryMemoryUpdate,
  partitionPagesIntoBatches,
  selectBatchJobPageStates,
  type StoryMemoryDeltaInput,
} from './batchTranslation.ts';

const activeRunners = new Set<string>();

export interface CreateBatchJobOptions {
  retryOnlyFailed?: boolean;
  pageIds?: string[];
  forceRetranslate?: boolean;
  batchSize?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientJobError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|503|502|rate.?limit|overloaded|UNAVAILABLE|timeout|ECONNRESET/i.test(msg);
}

async function runWithTransientBackoff<T>(
  fn: () => Promise<T>,
  shouldAbort: () => boolean,
  maxAttempts = 3
): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    if (shouldAbort()) {
      throw new Error('Job paused or cancelled');
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (!isTransientJobError(err) || attempt >= maxAttempts || shouldAbort()) {
        throw err;
      }
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

export function createTranslationJob(
  chapterId: string,
  optionsOrRetry: boolean | CreateBatchJobOptions = false
): TranslationJob {
  const options: CreateBatchJobOptions =
    typeof optionsOrRetry === 'boolean' ? { retryOnlyFailed: optionsOrRetry } : optionsOrRetry || {};

  const db = getDb();
  const chapter = db.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error('Chapter not found');

  const pages = db.pages
    .filter((p) => p.chapterId === chapterId)
    .sort((a, b) => a.pageNumber - b.pageNumber);

  const { pageStates, queuedPageIds } = selectBatchJobPageStates(pages, {
    retryOnlyFailed: options.retryOnlyFailed,
    selectedPageIds: options.pageIds,
    forceRetranslate: options.forceRetranslate,
  });

  const batchSize = Math.max(1, Math.min(2, options.batchSize || 2));
  const batches = partitionPagesIntoBatches(queuedPageIds, batchSize);
  const completedInitial = Object.values(pageStates).filter((s) => s === 'skipped').length;
  const settings = db.user.settings;
  const activeProvider = normalizeAiProviderId(settings.provider);

  const job: TranslationJob = {
    id: `job-${crypto.randomBytes(4).toString('hex')}`,
    projectId: chapter.projectId,
    chapterId,
    chapterTitle: chapter.title,
    status: queuedPageIds.length === 0 ? 'completed' : 'queued',
    totalPages: pages.length,
    completedPages: completedInitial,
    failedPages: 0,
    progress:
      pages.length > 0 ? Math.round((completedInitial / pages.length) * 100) : 100,
    batchSize,
    currentBatch: batches.length > 0 ? 1 : 0,
    totalBatches: batches.length,
    activeProvider,
    activeModel:
      settings.providers?.[activeProvider]?.translationModel || settings.translationModel,
    selectedPageIds: options.pageIds,
    forceRetranslate: options.forceRetranslate,
    pageStates,
    createdAt: new Date().toISOString(),
    completedAt: queuedPageIds.length === 0 ? new Date().toISOString() : undefined,
  };

  db.jobs.unshift(job);
  chapter.status = queuedPageIds.length === 0 ? 'completed' : 'processing';
  saveDb();

  appendLog(
    'info',
    'JOB_CREATED',
    `Started 2-page batch job for ${chapter.title} (${queuedPageIds.length} pages across ${batches.length} batches)`,
    {
      projectId: chapter.projectId,
      chapterId,
    }
  );

  if (queuedPageIds.length > 0) {
    scheduleJobExecution(job.id);
  }
  return job;
}

export function controlJob(
  jobId: string,
  action: 'pause' | 'resume' | 'cancel' | 'retry_failed'
): TranslationJob {
  const db = getDb();
  const job = db.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error('Job not found');

  if (action === 'pause') {
    if (job.status === 'running' || job.status === 'queued') {
      job.status = 'paused';
      saveDb();
    }
  } else if (action === 'cancel') {
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    saveDb();
  } else if (action === 'resume') {
    if (job.status === 'paused') {
      job.status = 'queued';
      saveDb();
      scheduleJobExecution(job.id);
    }
  } else if (action === 'retry_failed') {
    for (const [pageId, state] of Object.entries(job.pageStates)) {
      if (state === 'failed') {
        job.pageStates[pageId] = 'queued';
      }
    }
    job.failedPages = 0;
    job.status = 'queued';
    job.errorMessage = undefined;
    saveDb();
    scheduleJobExecution(job.id);
  }

  return job;
}

function scheduleJobExecution(jobId: string): void {
  if (activeRunners.has(jobId)) return;
  activeRunners.add(jobId);

  void (async () => {
    try {
      const db = getDb();
      const job = db.jobs.find((j) => j.id === jobId);
      if (!job) return;

      const project = db.projects.find((p) => p.id === job.projectId);
      const chapter = db.chapters.find((c) => c.id === job.chapterId);
      if (!project || !chapter) {
        job.status = 'failed';
        job.errorMessage = 'Project or chapter no longer exists.';
        saveDb();
        return;
      }

      job.status = 'running';
      saveDb();

      const batchSize = Math.max(1, Math.min(2, job.batchSize || 2));
      const allPagesOrdered = db.pages
        .filter((p) => p.chapterId === job.chapterId)
        .sort((a, b) => a.pageNumber - b.pageNumber);

      const queuedPageIds = allPagesOrdered
        .filter((p) => job.pageStates[p.id] === 'queued')
        .map((p) => p.id);

      const batches = partitionPagesIntoBatches(queuedPageIds, batchSize);
      job.totalBatches = batches.length;
      saveDb();

      const shouldForcePage = Boolean(
        job.forceRetranslate || (job.selectedPageIds && job.selectedPageIds.length > 0)
      );
      let lastRequestAt = 0;

      for (let bIdx = 0; bIdx < batches.length; bIdx++) {
        const batchIds = batches[bIdx];
        const freshJobBeforeBatch = getDb().jobs.find((j) => j.id === jobId);
        if (
          !freshJobBeforeBatch ||
          freshJobBeforeBatch.status === 'paused' ||
          freshJobBeforeBatch.status === 'cancelled'
        ) {
          return;
        }

        freshJobBeforeBatch.currentBatch = bIdx + 1;
        saveDb();

        const batchDeltas: StoryMemoryDeltaInput[] = [];
        const batchSummaries: string[] = [];

        // Execute pages sequentially inside this 2-page batch (no multi-page giant payload, immediate save per page)
        for (const pageId of batchIds) {
          const freshJob = getDb().jobs.find((j) => j.id === jobId);
          if (!freshJob || freshJob.status === 'paused' || freshJob.status === 'cancelled') {
            return;
          }

          const currentDb = getDb();
          const settings = currentDb.user.settings;
          const glossary = currentDb.glossary.filter((g) => g.projectId === project.id);
          const page = currentDb.pages.find((p) => p.id === pageId);
          if (!page) continue;

          const minIntervalMs =
            settings.rateLimitPerMinute > 0
              ? Math.max(250, Math.floor(60000 / Math.max(1, settings.rateLimitPerMinute)))
              : 400;
          const elapsed = Date.now() - lastRequestAt;
          if (lastRequestAt > 0 && elapsed < minIntervalMs) {
            await sleep(minIntervalMs - elapsed);
          }

          const isAborted = () => {
            const st = getDb().jobs.find((j) => j.id === jobId)?.status;
            return st === 'paused' || st === 'cancelled';
          };

          freshJob.pageStates[pageId] = 'running';
          freshJob.currentPageNumber = page.pageNumber;
          freshJob.activeProvider = normalizeAiProviderId(settings.provider);
          freshJob.activeModel =
            settings.providers?.[freshJob.activeProvider]?.translationModel ||
            settings.translationModel;
          page.status = 'analyzing';
          saveDb();

          try {
            let visionProviderUsed: AiProviderId | undefined =
              page.lastTranslationMeta?.visionProviderUsed;
            let visionModelUsed: string | undefined =
              page.lastTranslationMeta?.visionModelUsed;

            if (page.regions.length === 0) {
              lastRequestAt = Date.now();
              const analyzed = await runWithTransientBackoff(
                () =>
                  analyzeComicPageWithProvider(page, project.readingDirection, settings, {
                    targetLanguage: project.targetLanguage,
                    comicFormat: project.comicFormat,
                  }),
                isAborted
              );
              page.panels = analyzed.panels;
              page.regions = analyzed.regions;
              visionProviderUsed = analyzed.providerUsed;
              visionModelUsed = analyzed.modelUsed;
            }

            if (isAborted()) return;

            page.status = 'translating';
            saveDb();

            const prevPage = currentDb.pages.find(
              (p) => p.chapterId === page.chapterId && p.pageNumber === page.pageNumber - 1
            );
            const previousPageContext = prevPage?.regions.length
              ? prevPage.regions
                  .slice(-8)
                  .map(
                    (r) =>
                      `${r.speaker || r.regionType}: "${r.originalText}" -> "${r.translatedText || ''}"`
                  )
                  .join('\n')
              : undefined;

            const toTranslate = shouldForcePage
              ? page.regions
              : page.regions.filter((r) => !r.translatedText.trim());

            if (toTranslate.length > 0) {
              lastRequestAt = Date.now();
              const tr = await runWithTransientBackoff(
                () =>
                  translateRegionsWithProvider(
                    toTranslate,
                    project,
                    project.storyMemory,
                    glossary,
                    project.translationStyle,
                    project.targetLanguage,
                    settings,
                    previousPageContext
                  ),
                isAborted
              );

              for (const item of tr.translations) {
                const target = page.regions.find((r) => r.id === item.id);
                if (target) {
                  target.translatedText = item.translatedText;
                  target.alternatives = item.alternatives || [];
                  if (item.speaker) target.speaker = item.speaker;
                  target.translationStatus = 'translated';
                }
              }

              if (tr.memoryUpdate) batchDeltas.push(tr.memoryUpdate);
              if (tr.summaryAddition) batchSummaries.push(tr.summaryAddition);

              freshJob.activeProvider = tr.providerUsed;
              freshJob.activeModel = tr.modelUsed;

              page.lastTranslationMeta = {
                providerUsed: tr.providerUsed,
                modelUsed: tr.modelUsed,
                visionProviderUsed,
                visionModelUsed,
                fallbackUsed: tr.fallbackUsed,
                updatedAt: new Date().toISOString(),
              };
            }

            page.status = 'completed';
            page.errorMessage = undefined;
            freshJob.pageStates[pageId] = 'completed';
            freshJob.completedPages = Object.values(freshJob.pageStates).filter(
              (s) => s === 'completed' || s === 'skipped'
            ).length;
            freshJob.failedPages = Object.values(freshJob.pageStates).filter(
              (s) => s === 'failed'
            ).length;
          } catch (err) {
            if (isAborted()) {
              page.status = 'pending';
              freshJob.pageStates[pageId] = 'queued';
              saveDb();
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            page.status = 'error';
            page.errorMessage = msg;
            freshJob.pageStates[pageId] = 'failed';
            freshJob.failedPages = Object.values(freshJob.pageStates).filter(
              (s) => s === 'failed'
            ).length;
            freshJob.errorMessage = msg;
            appendLog('error', 'PAGE_PROCESS_FAILED', `Page ${page.pageNumber}: ${msg}`, {
              projectId: project.id,
              chapterId: chapter.id,
              pageId: page.id,
            });
          }

          const doneCount = Object.values(freshJob.pageStates).filter(
            (s) => s === 'completed' || s === 'skipped' || s === 'failed'
          ).length;
          freshJob.progress =
            freshJob.totalPages > 0 ? Math.round((doneCount / freshJob.totalPages) * 100) : 100;
          saveDb();
        }

        // Persist updated Story Memory after completing this 2-page batch before starting the next batch
        if (batchDeltas.length > 0 || batchSummaries.length > 0) {
          let updatedMem = project.storyMemory;
          for (const d of batchDeltas) {
            updatedMem = mergeStoryMemoryUpdate(updatedMem, d, []);
          }
          if (batchSummaries.length > 0) {
            updatedMem = mergeStoryMemoryUpdate(updatedMem, undefined, batchSummaries);
          }
          project.storyMemory = updatedMem;
          project.updatedAt = new Date().toISOString();
          saveDb();
        }
      }

      const finalJob = getDb().jobs.find((j) => j.id === jobId);
      if (!finalJob) return;

      if (finalJob.status !== 'paused' && finalJob.status !== 'cancelled') {
        finalJob.status =
          finalJob.failedPages > 0 && finalJob.completedPages === 0 ? 'failed' : 'completed';
        finalJob.completedAt = new Date().toISOString();
        chapter.status = finalJob.failedPages > 0 ? 'partial' : 'completed';
        chapter.updatedAt = new Date().toISOString();
        saveDb();
        appendLog(
          finalJob.failedPages > 0 ? 'warn' : 'info',
          'JOB_FINISHED',
          `2-page batch job finished for ${chapter.title}: ${finalJob.completedPages}/${finalJob.totalPages} completed`,
          { projectId: project.id, chapterId: chapter.id }
        );
      }
    } finally {
      activeRunners.delete(jobId);
    }
  })();
}
