import type {
  AiProviderId,
  AiSettings,
  BrowserBookmark,
  BrowserCapabilities,
  BrowserDiscoveredImage,
  BrowserHistoryEntry,
  BrowserPrivacyMode,
  BrowserTabSnapshot,
  Chapter,
  GlossaryCategory,
  GlossaryEntry,
  GlossaryScope,
  GlossarySuggestion,
  OperationLog,
  Page,
  Project,
  ProjectWithDetails,
  ProviderCatalogInfo,
  ProviderModelMeta,
  ProvidersDetailedStatusMap,
  ProvidersStatusMap,
  ProviderTestResult,
  TextRegion,
  TranslationJob,
  TranslationStyle,
} from '../types/domain';
import { chunkPagesForUpload } from './pageBatchUtils';

export interface ImportStageDiagnostic {
  stage:
    | 'url_validation'
    | 'adapter_selection'
    | 'redirect_and_cookies'
    | 'source_fetch'
    | 'js_render'
    | 'image_extraction'
    | 'cdn_probe';
  status: 'ok' | 'warn' | 'failed' | 'skipped';
  httpStatus?: number;
  latencyMs?: number;
  detail: string;
}

export interface RedirectHopTrace {
  url: string;
  status: number;
  location?: string;
}

export interface UrlInspectResponse {
  adapterId: string;
  adapterName: string;
  sourceMethod: 'official_api' | 'html_parser' | 'embedded_json' | 'js_rendered_dom';
  pageTitle: string;
  sourceUrl: string;
  finalUrl: string;
  requiredReferer: string;
  redirectChain: RedirectHopTrace[];
  cookiesCaptured: number;
  images: Array<{ index: number; url: string; alt: string; selected: boolean; referer?: string }>;
  diagnostics: ImportStageDiagnostic[];
  warnings: string[];
}

export class ApiRequestError extends Error {
  public readonly category?: string;
  public readonly stage?: string;
  public readonly httpStatus?: number;
  public readonly diagnostics?: ImportStageDiagnostic[];
  public readonly redirectChain?: RedirectHopTrace[];

  constructor(
    message: string,
    payload?: {
      category?: string;
      stage?: string;
      httpStatus?: number;
      diagnostics?: ImportStageDiagnostic[];
      redirectChain?: RedirectHopTrace[];
    }
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.category = payload?.category;
    this.stage = payload?.stage;
    this.httpStatus = payload?.httpStatus;
    this.diagnostics = payload?.diagnostics;
    this.redirectChain = payload?.redirectChain;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiRequestError(data.error || `Request failed (${res.status})`, {
      category: data.category,
      stage: data.stage,
      httpStatus: data.httpStatus ?? res.status,
      diagnostics: data.diagnostics,
      redirectChain: data.redirectChain,
    });
  }
  return data as T;
}

export const api = {
  // Projects
  getProjects: () => requestJson<{ projects: ProjectWithDetails[] }>('/api/projects'),
  createProject: (payload: {
    title: string;
    comicFormat: Project['comicFormat'];
    sourceLanguage: string;
    targetLanguage: string;
    readingDirection: Project['readingDirection'];
    translationStyle: TranslationStyle;
  }) => requestJson<{ project: Project }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  getProject: (id: string) =>
    requestJson<{ project: Project; chapters: Chapter[]; glossary: GlossaryEntry[] }>(
      `/api/projects/${id}`
    ),
  updateProject: (id: string, patch: Partial<Project>) =>
    requestJson<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteProject: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // Chapters & Importers
  inspectUrl: (url: string, customCookie?: string) =>
    requestJson<UrlInspectResponse>('/api/chapters/import/inspect', {
      method: 'POST',
      body: JSON.stringify({ url, customCookie }),
    }),
  importUrlChapter: (payload: {
    projectId: string;
    title: string;
    sourceUrl: string;
    selectedImageUrls: string[];
    requiredReferer?: string;
    customCookie?: string;
  }) =>
    requestJson<{
      chapter: Chapter;
      pages: Page[];
      failedImages?: Array<{ index: number; url: string; status: number; category: string; reason: string }>;
    }>('/api/chapters/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  createBrowserSession: (payload: {
    projectId?: string;
    newProjectConfig?: {
      title: string;
      comicFormat: Project['comicFormat'];
      sourceLanguage: string;
      targetLanguage: string;
      readingDirection: Project['readingDirection'];
      translationStyle: TranslationStyle;
    };
    chapterTitle: string;
    targetUrl?: string;
  }) =>
    requestJson<{
      session: {
        id: string;
        chapterTitle: string;
        targetUrl?: string;
        status: 'waiting' | 'collecting' | 'completed' | 'expired';
        pages: Array<{
          id: string;
          pageNumber: number;
          imageUrl: string;
          width: number;
          height: number;
          captureMethod: string;
          capturedAt: string;
        }>;
        chapterId?: string;
        expiresAt: string;
      };
      pairingToken: string;
      pairingBundle: string;
      appUrl: string;
    }>('/api/browser-import/session', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getBrowserSession: (sessionId: string) =>
    requestJson<{
      session: {
        id: string;
        chapterTitle: string;
        targetUrl?: string;
        status: 'waiting' | 'collecting' | 'completed' | 'expired';
        pages: Array<{
          id: string;
          pageNumber: number;
          imageUrl: string;
          width: number;
          height: number;
          captureMethod: string;
          capturedAt: string;
        }>;
        chapterId?: string;
        expiresAt: string;
      };
    }>(`/api/browser-import/session/${encodeURIComponent(sessionId)}`),
  completeBrowserSession: (sessionId: string, chapterTitle?: string) =>
    requestJson<{
      ok: boolean;
      chapter: Chapter;
      pages: Page[];
      projectId: string;
    }>('/api/browser-import/complete', {
      method: 'POST',
      body: JSON.stringify({ sessionId, chapterTitle }),
    }),
  createChapterShell: (payload: { projectId: string; title: string }) =>
    requestJson<{ chapter: Chapter }>('/api/chapters', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  appendChapterPages: async (
    chapterId: string,
    pages: Array<{ dataUrl: string; width: number; height: number; contentHash?: string }>,
    onProgress?: (pct: number, uploaded: number, total: number) => void,
    onChunkUploaded?: (uploadedCount: number) => void
  ): Promise<{ chapter: Chapter; pages: Page[] }> => {
    const chunks = chunkPagesForUpload(pages, 5, 10 * 1024 * 1024);
    let latestChapter: Chapter | null = null;
    const allAppended: Page[] = [];
    let uploaded = 0;

    for (const chunk of chunks) {
      const res = await requestJson<{ chapter: Chapter; appendedPages: Page[]; totalPages: number }>(
        `/api/chapters/${encodeURIComponent(chapterId)}/pages`,
        {
          method: 'POST',
          body: JSON.stringify({ pages: chunk }),
        }
      );
      latestChapter = res.chapter;
      allAppended.push(...res.appendedPages);
      uploaded += chunk.length;
      onChunkUploaded?.(uploaded);
      onProgress?.(Math.round((uploaded / Math.max(1, pages.length)) * 100), uploaded, pages.length);
    }

    if (!latestChapter) {
      throw new Error('No pages uploaded.');
    }
    return { chapter: latestChapter, pages: allAppended };
  },
  uploadChapter: async (
    payload: {
      projectId: string;
      title: string;
      existingChapterId?: string;
      pages: Array<{ dataUrl: string; width: number; height: number; contentHash?: string }>;
    },
    onProgress?: (pct: number, uploaded: number, total: number) => void,
    onChapterCreated?: (chapterId: string) => void,
    onChunkUploaded?: (uploadedCount: number) => void
  ): Promise<{ chapter: Chapter; pages: Page[] }> => {
    if (!payload.existingChapterId && payload.pages.length <= 5) {
      const totalChars = payload.pages.reduce((s, p) => s + p.dataUrl.length, 0);
      if (totalChars <= 10 * 1024 * 1024) {
        const res = await requestJson<{ chapter: Chapter; pages: Page[] }>('/api/chapters/upload', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onChapterCreated?.(res.chapter.id);
        onChunkUploaded?.(payload.pages.length);
        onProgress?.(100, payload.pages.length, payload.pages.length);
        return res;
      }
    }
    const chapterId =
      payload.existingChapterId ||
      (
        await requestJson<{ chapter: Chapter }>('/api/chapters', {
          method: 'POST',
          body: JSON.stringify({ projectId: payload.projectId, title: payload.title }),
        })
      ).chapter.id;
    onChapterCreated?.(chapterId);
    return api.appendChapterPages(chapterId, payload.pages, onProgress, onChunkUploaded);
  },
  getChapter: (id: string) =>
    requestJson<{ chapter: Chapter; project: Project; pages: Page[] }>(`/api/chapters/${id}`),
  updateChapter: (id: string, patch: Partial<Chapter>) =>
    requestJson<{ chapter: Chapter }>(`/api/chapters/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  // Pages
  reorderPages: (chapterId: string, orderedPageIds: string[]) =>
    requestJson<{ pages: Page[] }>('/api/pages/reorder', {
      method: 'POST',
      body: JSON.stringify({ chapterId, orderedPageIds }),
    }),
  duplicatePage: (pageId: string) =>
    requestJson<{ page: Page }>(`/api/pages/${pageId}/duplicate`, { method: 'POST' }),
  replacePageImage: (
    pageId: string,
    payload: { dataUrl: string; width?: number; height?: number; contentHash?: string; resetRegions?: boolean }
  ) =>
    requestJson<{ page: Page }>(`/api/pages/${encodeURIComponent(pageId)}/replace`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updatePage: (pageId: string, patch: Partial<Page>) =>
    requestJson<{ page: Page }>(`/api/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePage: (pageId: string) =>
    requestJson<{ ok: boolean; pages: Page[] }>(`/api/pages/${pageId}`, { method: 'DELETE' }),
  analyzePage: (pageId: string) =>
    requestJson<{
      page: Page;
      visionProviderUsed?: AiProviderId;
      visionModelUsed?: string;
      fallbackUsed?: boolean;
    }>('/api/pages/analyze', {
      method: 'POST',
      body: JSON.stringify({ pageId }),
    }),
  translatePage: (pageId: string, styleOverride?: TranslationStyle) =>
    requestJson<{
      page: Page;
      providerUsed?: AiProviderId;
      modelUsed?: string;
      fallbackUsed?: boolean;
      visionProviderUsed?: AiProviderId;
      visionModelUsed?: string;
    }>('/api/pages/translate', {
      method: 'POST',
      body: JSON.stringify({ pageId, styleOverride }),
    }),
  cleanPage: (pageId: string, manualStrokes: Page['manualStrokes']) =>
    requestJson<{ page: Page }>('/api/pages/clean', {
      method: 'POST',
      body: JSON.stringify({ pageId, manualStrokes }),
    }),
  renderPage: (pageId: string, processedDataUrl: string) =>
    requestJson<{ page: Page; verified?: boolean }>('/api/pages/render', {
      method: 'POST',
      body: JSON.stringify({ pageId, processedDataUrl }),
    }),

  // Bubbles
  createBubble: (payload: {
    pageId: string;
    regionType: TextRegion['regionType'];
    boundingBox: TextRegion['boundingBox'];
    originalText?: string;
    translatedText?: string;
  }) =>
    requestJson<{ region: TextRegion; page: Page }>('/api/bubbles', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateBubble: (id: string, patch: Partial<TextRegion>) =>
    requestJson<{ region: TextRegion; page: Page }>(`/api/bubbles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteBubble: (id: string) =>
    requestJson<{ ok: boolean; page: Page }>(`/api/bubbles/${id}`, { method: 'DELETE' }),
  retranslateBubble: (id: string, style?: TranslationStyle, customInstruction?: string) =>
    requestJson<{
      region: TextRegion;
      page: Page;
      providerUsed?: AiProviderId;
      modelUsed?: string;
      fallbackUsed?: boolean;
    }>(`/api/bubbles/${id}/retranslate`, {
      method: 'POST',
      body: JSON.stringify({ style, customInstruction }),
    }),

  // Batch Jobs & Logs
  getJobs: (chapterId?: string) =>
    requestJson<{ jobs: TranslationJob[]; logs: OperationLog[] }>(
      chapterId ? `/api/jobs?chapterId=${encodeURIComponent(chapterId)}` : '/api/jobs'
    ),
  startBatchJob: (
    chapterId: string,
    optionsOrRetry:
      | boolean
      | { retryOnlyFailed?: boolean; pageIds?: string[]; forceRetranslate?: boolean; batchSize?: number } = false
  ) =>
    requestJson<{ job: TranslationJob }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(
        typeof optionsOrRetry === 'boolean'
          ? { chapterId, retryOnlyFailed: optionsOrRetry, batchSize: 2 }
          : { chapterId, batchSize: 2, ...optionsOrRetry }
      ),
    }),
  controlJob: (jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry_failed') =>
    requestJson<{ job: TranslationJob }>(`/api/jobs/${jobId}/${action}`, { method: 'POST' }),
  clearLogs: () => requestJson<{ ok: boolean }>('/api/logs', { method: 'DELETE' }),

  // Personal Glossary (Global + Project + Edit + AI Suggestions)
  getGlossary: (projectId: string, includeGlobal = false) =>
    requestJson<{
      entries: GlossaryEntry[];
      globalEntries?: GlossaryEntry[];
      projectEntries?: GlossaryEntry[];
      overriddenGlobalIds?: string[];
      overridingProjectIds?: string[];
    }>(`/api/glossary/${encodeURIComponent(projectId)}${includeGlobal ? '?includeGlobal=1' : ''}`),
  getGlobalGlossary: () =>
    requestJson<{ entries: GlossaryEntry[] }>('/api/glossary?scope=global'),
  addGlossaryTerm: (payload: Omit<GlossaryEntry, 'id'> & { scope?: GlossaryScope }) =>
    requestJson<{ entry: GlossaryEntry }>('/api/glossary', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateGlossaryTerm: (
    id: string,
    patch: Partial<Pick<GlossaryEntry, 'originalTerm' | 'translatedTerm' | 'category' | 'notes' | 'scope' | 'projectId'>>
  ) =>
    requestJson<{ entry: GlossaryEntry }>(`/api/glossary/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  importGlossaryTerms: (projectId: string, entries: Array<Omit<GlossaryEntry, 'id' | 'projectId'>>) =>
    requestJson<{ added: GlossaryEntry[]; count: number }>(
      `/api/glossary/${encodeURIComponent(projectId)}/import`,
      {
        method: 'POST',
        body: JSON.stringify({ entries }),
      }
    ),
  deleteGlossaryTerm: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/glossary/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getGlossarySuggestions: (projectId?: string) =>
    requestJson<{ suggestions: GlossarySuggestion[] }>(
      projectId
        ? `/api/glossary-suggestions?projectId=${encodeURIComponent(projectId)}`
        : '/api/glossary-suggestions'
    ),
  approveGlossarySuggestion: (
    id: string,
    payload: {
      scope: GlossaryScope;
      projectId?: string;
      translatedTerm?: string;
      category?: GlossaryCategory;
      notes?: string;
    }
  ) =>
    requestJson<{ entry: GlossaryEntry; suggestion: GlossarySuggestion }>(
      `/api/glossary-suggestions/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  dismissGlossarySuggestion: (id: string) =>
    requestJson<{ suggestion: GlossarySuggestion }>(
      `/api/glossary-suggestions/${encodeURIComponent(id)}/dismiss`,
      { method: 'POST' }
    ),

  // AI & Settings
  getAiCatalog: () =>
    requestJson<{ catalog: ProviderCatalogInfo[] }>('/api/ai/catalog'),
  getSettings: () =>
    requestJson<{
      settings: AiSettings;
      configured: boolean;
      providersStatus?: ProvidersStatusMap;
      providersDetailed?: ProvidersDetailedStatusMap;
    }>('/api/settings'),
  updateSettings: (patch: Partial<AiSettings>) =>
    requestJson<{
      settings: AiSettings;
      providersStatus?: ProvidersStatusMap;
      providersDetailed?: ProvidersDetailedStatusMap;
    }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  saveProviderKey: (
    provider: AiProviderId,
    payload: { apiKey: string; accountId?: string; endpointUrl?: string }
  ) =>
    requestJson<{
      ok: boolean;
      settings: AiSettings;
      providersStatus: ProvidersStatusMap;
      providersDetailed: ProvidersDetailedStatusMap;
    }>(`/api/ai/providers/${encodeURIComponent(provider)}/key`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteProviderKey: (provider: AiProviderId) =>
    requestJson<{
      ok: boolean;
      providersStatus: ProvidersStatusMap;
      providersDetailed: ProvidersDetailedStatusMap;
    }>(`/api/ai/providers/${encodeURIComponent(provider)}/key`, {
      method: 'DELETE',
    }),
  fetchProviderModels: (
    provider: AiProviderId,
    payload?: { apiKey?: string; endpointUrl?: string; accountId?: string }
  ) =>
    requestJson<{
      models: ProviderModelMeta[];
      source: 'live' | 'catalog';
      warning?: string;
    }>(`/api/ai/providers/${encodeURIComponent(provider)}/models`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    }),
  testAiConnection: (
    payload?:
      | string
      | {
          provider?: AiProviderId;
          model?: string;
          visionModel?: string;
          endpointUrl?: string;
          accountId?: string;
          apiKey?: string;
          testVision?: boolean;
        }
  ) =>
    requestJson<ProviderTestResult>('/api/ai/test', {
      method: 'POST',
      body: JSON.stringify(typeof payload === 'string' ? { model: payload } : payload || {}),
    }),

  // Internal Web Browser Engine & Smart Chapter Importer
  getBrowserCapabilities: () =>
    requestJson<{ capabilities: BrowserCapabilities }>('/api/browser/capabilities'),
  getBrowserState: () =>
    requestJson<{
      state: {
        privacyMode: BrowserPrivacyMode;
        homeUrl: string;
        bookmarks: BrowserBookmark[];
        history: BrowserHistoryEntry[];
      };
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
    }>('/api/browser/state'),
  updateBrowserPrivacy: (payload: {
    privacyMode?: BrowserPrivacyMode;
    homeUrl?: string;
    clearHistory?: boolean;
    clearSessionCookies?: boolean;
  }) =>
    requestJson<{
      state: {
        privacyMode: BrowserPrivacyMode;
        homeUrl: string;
        bookmarks: BrowserBookmark[];
        history: BrowserHistoryEntry[];
      };
    }>('/api/browser/privacy', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  addBrowserBookmark: (title: string, url: string) =>
    requestJson<{ bookmarks: BrowserBookmark[] }>('/api/browser/bookmarks', {
      method: 'POST',
      body: JSON.stringify({ title, url }),
    }),
  removeBrowserBookmark: (id: string) =>
    requestJson<{ bookmarks: BrowserBookmark[] }>(`/api/browser/bookmarks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  createBrowserTab: (url?: string, privacyMode?: BrowserPrivacyMode) =>
    requestJson<{
      tab: BrowserTabSnapshot;
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
    }>('/api/browser/tabs', {
      method: 'POST',
      body: JSON.stringify({ url, privacyMode }),
    }),
  getBrowserTab: (tabId: string) =>
    requestJson<{ tab: BrowserTabSnapshot }>(`/api/browser/tabs/${encodeURIComponent(tabId)}`),
  closeBrowserTab: (tabId: string) =>
    requestJson<{
      ok: boolean;
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
    }>(`/api/browser/tabs/${encodeURIComponent(tabId)}`, { method: 'DELETE' }),
  navigateBrowserTab: (tabId: string, url: string) =>
    requestJson<{
      tab: BrowserTabSnapshot;
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
      history: BrowserHistoryEntry[];
    }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/navigate`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  backBrowserTab: (tabId: string) =>
    requestJson<{
      tab: BrowserTabSnapshot;
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
    }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/back`, { method: 'POST' }),
  forwardBrowserTab: (tabId: string) =>
    requestJson<{
      tab: BrowserTabSnapshot;
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
    }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/forward`, { method: 'POST' }),
  reloadBrowserTab: (tabId: string) =>
    requestJson<{ tab: BrowserTabSnapshot }>(
      `/api/browser/tabs/${encodeURIComponent(tabId)}/reload`,
      { method: 'POST' }
    ),
  interactBrowserTab: (
    tabId: string,
    action:
      | { type: 'click'; x: number; y: number }
      | { type: 'scroll'; deltaY: number }
      | { type: 'type'; text: string; pressEnter?: boolean }
  ) =>
    requestJson<{
      tab: BrowserTabSnapshot;
      tabs: Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>;
    }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/interact`, {
      method: 'POST',
      body: JSON.stringify(action),
    }),
  collectTabImages: (tabId: string, autoScrollLazy = true) =>
    requestJson<{
      snapshot: BrowserTabSnapshot;
      images: BrowserDiscoveredImage[];
      blockedByProtection: boolean;
    }>(`/api/browser/tabs/${encodeURIComponent(tabId)}/collect-images`, {
      method: 'POST',
      body: JSON.stringify({ autoScrollLazy }),
    }),
  screenshotBrowserTab: (tabId: string, mode: 'visible' | 'full_page' = 'visible') =>
    requestJson<{ image: BrowserDiscoveredImage }>(
      `/api/browser/tabs/${encodeURIComponent(tabId)}/screenshot`,
      {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }
    ),
  importBrowserImagesToStudio: (payload: {
    projectId?: string;
    newProjectConfig?: {
      title: string;
      comicFormat: Project['comicFormat'];
      sourceLanguage: string;
      targetLanguage: string;
      readingDirection: Project['readingDirection'];
      translationStyle: TranslationStyle;
    };
    chapterTitle: string;
    sourceUrl?: string;
    pages: Array<{ dataUrl: string; width: number; height: number }>;
  }) =>
    requestJson<{ projectId: string; chapter: Chapter; pages: Page[] }>(
      '/api/browser/import-to-studio',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  mobileShareImport: (payload: {
    projectId?: string;
    chapterTitle?: string;
    sourcePlatform?: 'android_share_intent' | 'android_webview' | 'web_share_target';
    images?: Array<{ dataUrl: string; filename?: string; width?: number; height?: number }>;
    archiveBase64?: string;
    archiveFilename?: string;
  }) =>
    requestJson<{ projectId: string; chapter: Chapter; pages: Page[] }>(
      '/api/mobile/share-import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
};
