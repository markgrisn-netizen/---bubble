import type { AiSettings, Chapter, Page, Project } from '../types/domain';
import { api } from './api';
import { renderCompositePageToCanvas } from './inpainting';
import {
  imageSrcToInlineDataUrl,
  OfflineQuotaError,
  saveOfflineChapterBundle,
} from './offlineDb';
import {
  computeDownloadProgress,
  isQuotaExceededError,
  verifyOfflineChapterIntegrity,
} from './offlineUtils';

export type OfflineTaskStatus =
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface OfflineDownloadTask {
  taskId: string;
  kind: 'chapter' | 'project';
  projectId: string;
  chapterIds: string[];
  title: string;
  includeOriginals: boolean;
  inpaintingEngine: AiSettings['inpaintingEngine'];
  status: OfflineTaskStatus;
  totalPages: number;
  completedPages: number;
  progress: number;
  errorMessage?: string;
}

interface InternalTaskState {
  task: OfflineDownloadTask;
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentChapterIndex: number;
  currentPageIndex: number;
  chapterDataCache: Map<
    string,
    { project: Project; chapter: Chapter; sourcePages: Page[]; processedPages: Page[] }
  >;
}

const taskMap = new Map<string, InternalTaskState>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Ignore subscriber render errors
    }
  }
}

export function subscribeOfflineDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOfflineDownloadTasks(): OfflineDownloadTask[] {
  return Array.from(taskMap.values()).map((s) => ({ ...s.task }));
}

async function renderPageForOffline(
  page: Page,
  includeOriginals: boolean,
  inpaintingEngine: AiSettings['inpaintingEngine']
): Promise<Page> {
  const canvas = document.createElement('canvas');
  await renderCompositePageToCanvas(canvas, page, {
    showOriginalOnly: false,
    showText: true,
    inpaintingEngine,
  });

  const processedImage = canvas.toDataURL('image/jpeg', 0.88);
  let originalImage = '';
  if (includeOriginals) {
    try {
      originalImage = await imageSrcToInlineDataUrl(page.originalImage);
    } catch {
      originalImage = '';
    }
  }

  return {
    ...page,
    width: canvas.width || page.width,
    height: canvas.height || page.height,
    processedImage,
    originalImage,
  };
}

async function runTaskLoop(state: InternalTaskState): Promise<void> {
  state.task.status = 'downloading';
  state.pauseRequested = false;
  state.cancelRequested = false;
  state.task.errorMessage = undefined;
  notifyListeners();

  try {
    // Ensure chapter metadata & totalPages are initialized once
    if (state.task.totalPages === 0) {
      let total = 0;
      for (const cid of state.task.chapterIds) {
        if (state.cancelRequested) {
          state.task.status = 'cancelled';
          notifyListeners();
          return;
        }
        const data = await api.getChapter(cid);
        state.chapterDataCache.set(cid, {
          project: data.project,
          chapter: data.chapter,
          sourcePages: data.pages,
          processedPages: [],
        });
        total += data.pages.length;
      }
      state.task.totalPages = total;
      state.task.progress = computeDownloadProgress(state.task.completedPages, total);
      notifyListeners();
    }

    for (let cIdx = state.currentChapterIndex; cIdx < state.task.chapterIds.length; cIdx++) {
      state.currentChapterIndex = cIdx;
      const cid = state.task.chapterIds[cIdx];
      let cached = state.chapterDataCache.get(cid);
      if (!cached) {
        const data = await api.getChapter(cid);
        cached = {
          project: data.project,
          chapter: data.chapter,
          sourcePages: data.pages,
          processedPages: [],
        };
        state.chapterDataCache.set(cid, cached);
      }

      const startPageIdx = cIdx === state.currentChapterIndex ? state.currentPageIndex : 0;
      for (let pIdx = startPageIdx; pIdx < cached.sourcePages.length; pIdx++) {
        if (state.cancelRequested) {
          state.task.status = 'cancelled';
          taskMap.delete(state.task.taskId);
          notifyListeners();
          return;
        }
        if (state.pauseRequested) {
          state.currentPageIndex = pIdx;
          state.task.status = 'paused';
          notifyListeners();
          return;
        }

        const rendered = await renderPageForOffline(
          cached.sourcePages[pIdx],
          state.task.includeOriginals,
          state.task.inpaintingEngine
        );
        cached.processedPages.push(rendered);
        state.currentPageIndex = pIdx + 1;
        state.task.completedPages += 1;
        state.task.progress = computeDownloadProgress(
          state.task.completedPages,
          state.task.totalPages
        );
        notifyListeners();
      }

      const integrity = verifyOfflineChapterIntegrity(
        cached.sourcePages.length,
        cached.processedPages
      );
      if (!integrity.valid) {
        throw new Error(`Offline chapter verification failed (${integrity.reason})`);
      }

      await saveOfflineChapterBundle({
        project: cached.project,
        chapter: cached.chapter,
        pages: cached.processedPages,
        includeOriginals: state.task.includeOriginals,
        complete: true,
      });

      state.currentPageIndex = 0;
    }

    state.task.status = 'completed';
    state.task.progress = 100;
    notifyListeners();
  } catch (err) {
    if (err instanceof OfflineQuotaError || isQuotaExceededError(err)) {
      state.task.status = 'error';
      state.task.errorMessage = 'QUOTA_EXCEEDED';
    } else {
      state.task.status = 'error';
      state.task.errorMessage = err instanceof Error ? err.message : String(err);
    }
    notifyListeners();
  }
}

export function startChapterOfflineDownload(params: {
  projectId: string;
  chapterId: string;
  title: string;
  includeOriginals?: boolean;
  inpaintingEngine?: AiSettings['inpaintingEngine'];
}): string {
  const taskId = `ch:${params.chapterId}`;
  const state: InternalTaskState = {
    task: {
      taskId,
      kind: 'chapter',
      projectId: params.projectId,
      chapterIds: [params.chapterId],
      title: params.title,
      includeOriginals: Boolean(params.includeOriginals),
      inpaintingEngine: params.inpaintingEngine || 'telea_biharmonic',
      status: 'downloading',
      totalPages: 0,
      completedPages: 0,
      progress: 0,
    },
    pauseRequested: false,
    cancelRequested: false,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    chapterDataCache: new Map(),
  };
  taskMap.set(taskId, state);
  void runTaskLoop(state);
  return taskId;
}

export function startProjectOfflineDownload(params: {
  projectId: string;
  chapterIds: string[];
  title: string;
  includeOriginals?: boolean;
  inpaintingEngine?: AiSettings['inpaintingEngine'];
}): string {
  const taskId = `proj:${params.projectId}`;
  const state: InternalTaskState = {
    task: {
      taskId,
      kind: 'project',
      projectId: params.projectId,
      chapterIds: params.chapterIds,
      title: params.title,
      includeOriginals: Boolean(params.includeOriginals),
      inpaintingEngine: params.inpaintingEngine || 'telea_biharmonic',
      status: 'downloading',
      totalPages: 0,
      completedPages: 0,
      progress: 0,
    },
    pauseRequested: false,
    cancelRequested: false,
    currentChapterIndex: 0,
    currentPageIndex: 0,
    chapterDataCache: new Map(),
  };
  taskMap.set(taskId, state);
  void runTaskLoop(state);
  return taskId;
}

export function pauseOfflineDownload(taskId: string): void {
  const state = taskMap.get(taskId);
  if (!state || state.task.status !== 'downloading') return;
  state.pauseRequested = true;
}

export function resumeOfflineDownload(taskId: string): void {
  const state = taskMap.get(taskId);
  if (!state || (state.task.status !== 'paused' && state.task.status !== 'error')) return;
  void runTaskLoop(state);
}

export function cancelOfflineDownload(taskId: string): void {
  const state = taskMap.get(taskId);
  if (!state) return;
  if (state.task.status === 'downloading') {
    state.cancelRequested = true;
  } else {
    taskMap.delete(taskId);
    notifyListeners();
  }
}

export function clearFinishedOfflineDownload(taskId: string): void {
  const state = taskMap.get(taskId);
  if (state && (state.task.status === 'completed' || state.task.status === 'error' || state.task.status === 'cancelled')) {
    taskMap.delete(taskId);
    notifyListeners();
  }
}
