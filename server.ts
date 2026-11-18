import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import dotenv from 'dotenv';
import JSZip from 'jszip';
import { createServer as createViteServer } from 'vite';
import { appendLog, getDb, getUploadsDir, saveBase64Asset, saveDb } from './server/store.ts';
import {
  analyzeComicPageWithProvider,
  fetchDynamicProviderModels,
  getProvidersDetailedStatus,
  getProvidersStatus,
  isValidAiProviderId,
  normalizeAiSettings,
  retranslateSingleBubbleWithProvider,
  testProviderConnection,
  translateRegionsWithProvider,
  validateEndpointUrl,
} from './server/aiProviders.ts';
import { getProviderCatalogList, resolveCloudflareEndpoint } from './server/providerCatalog.ts';
import { deleteVaultSecret, redactSecrets, setVaultSecret } from './server/secretVault.ts';
import { GeminiUpstreamError } from './server/geminiResilience.ts';
import {
  fetchChapterImage,
  ImporterDiagnosticError,
  inspectChapterUrl,
  SessionHttpClient,
  validatePublicChapterUrl,
} from './server/urlImporter.ts';
import {
  appendPagesToBrowserSession,
  completeBrowserImportSession,
  createBrowserImportSession,
  getBrowserImportSessionPublic,
  verifyBrowserSessionAuth,
} from './server/browserImport.ts';
import {
  addBrowserBookmark,
  captureTabScreenshotAsPage,
  closeBrowserTab,
  collectTabComicImages,
  createBrowserTab,
  getBrowserCapabilities,
  getBrowserTabSnapshot,
  getBrowserWorkspaceState,
  goBackBrowserTab,
  goForwardBrowserTab,
  importBrowserImagesToStudio,
  interactWithBrowserTab,
  listBrowserTabs,
  navigateBrowserTab,
  reloadBrowserTab,
  removeBrowserBookmark,
  updateBrowserPrivacySettings,
} from './server/webBrowserEngine.ts';
import { importMobileSharePayload } from './server/mobileShare.ts';
import { controlJob, createTranslationJob } from './server/jobRunner.ts';
import { mergeStoryMemoryUpdate } from './server/batchTranslation.ts';
import {
  boxToPolygon,
  createDefaultFontSettings,
  normalizeGlossaryCategory,
  polygonToBox,
} from './src/utils/bubbleLayout.ts';
import type { Chapter, GlossaryEntry, Page, Project, TextRegion } from './src/types/domain.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '60mb' }));
  app.use(express.urlencoded({ extended: true, limit: '60mb' }));

  // Serve persisted uploaded page images
  app.use('/uploads', express.static(getUploadsDir()));

  // Health & AI status
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/ai/catalog', (_req, res) => {
    res.json({ catalog: getProviderCatalogList() });
  });

  app.get('/api/ai/status', (_req, res) => {
    const db = getDb();
    const providersStatus = getProvidersStatus();
    const providersDetailed = getProvidersDetailedStatus(db.user.settings);
    const configured = Object.values(providersStatus).some(Boolean);
    res.json({
      configured,
      providersStatus,
      providersDetailed,
      settings: db.user.settings,
    });
  });

  app.put('/api/ai/providers/:id/key', (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidAiProviderId(id)) {
        res.status(400).json({ error: `Unknown AI provider: ${id}` });
        return;
      }
      const { apiKey, accountId, endpointUrl } = req.body || {};
      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        res.status(400).json({ error: 'API key is required.' });
        return;
      }

      setVaultSecret(id, apiKey.trim(), typeof accountId === 'string' ? accountId : undefined);

      const db = getDb();
      if (id === 'cloudflare' && db.user.settings.providers?.cloudflare) {
        const cleanAcct = typeof accountId === 'string' ? accountId.trim() : db.user.settings.providers.cloudflare.accountId;
        db.user.settings.providers.cloudflare.accountId = cleanAcct;
        db.user.settings.providers.cloudflare.endpointUrl = resolveCloudflareEndpoint(
          cleanAcct,
          typeof endpointUrl === 'string' ? endpointUrl : db.user.settings.providers.cloudflare.endpointUrl
        );
      } else if (typeof endpointUrl === 'string' && endpointUrl.trim() && db.user.settings.providers?.[id]) {
        db.user.settings.providers[id].endpointUrl = validateEndpointUrl(endpointUrl);
      }
      saveDb();

      appendLog('info', 'PROVIDER_KEY_SAVED', `Saved encrypted API credentials for ${id}`);
      res.json({
        ok: true,
        settings: db.user.settings,
        providersStatus: getProvidersStatus(),
        providersDetailed: getProvidersDetailedStatus(db.user.settings),
      });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/ai/providers/:id/key', (req, res) => {
    const id = req.params.id;
    if (!isValidAiProviderId(id)) {
      res.status(400).json({ error: `Unknown AI provider: ${id}` });
      return;
    }
    deleteVaultSecret(id);
    const db = getDb();
    appendLog('info', 'PROVIDER_KEY_DELETED', `Removed stored API key for ${id}`);
    res.json({
      ok: true,
      providersStatus: getProvidersStatus(),
      providersDetailed: getProvidersDetailedStatus(db.user.settings),
    });
  });

  app.post('/api/ai/providers/:id/models', async (req, res) => {
    try {
      const id = req.params.id;
      if (!isValidAiProviderId(id)) {
        res.status(400).json({ error: `Unknown AI provider: ${id}` });
        return;
      }
      const db = getDb();
      const { apiKey, endpointUrl, accountId } = req.body || {};
      const result = await fetchDynamicProviderModels({
        provider: id,
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
        endpointUrl: typeof endpointUrl === 'string' ? endpointUrl : undefined,
        accountId: typeof accountId === 'string' ? accountId : undefined,
        settings: db.user.settings,
      });
      res.json(result);
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/ai/test', async (req, res) => {
    const rawKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined;
    try {
      const db = getDb();
      const provider = req.body?.provider || db.user.settings.provider;
      const model = req.body?.model;
      const visionModel = req.body?.visionModel;
      const endpointUrl = req.body?.endpointUrl;
      const accountId = req.body?.accountId;
      const testVision = Boolean(req.body?.testVision);
      const result = await testProviderConnection({
        provider,
        model,
        visionModel,
        endpointUrl,
        accountId,
        apiKey: rawKey,
        testVision,
        settings: db.user.settings,
      });
      appendLog(
        'info',
        'AI_CONNECTION_TEST',
        `Connected to ${result.provider}:${result.model}${result.visionModel ? ` + vision:${result.visionModel}` : ''} (${result.latencyMs}ms)`
      );
      res.json(result);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = redactSecrets(rawMsg, rawKey ? [rawKey] : []);
      const status = err instanceof GeminiUpstreamError ? err.httpStatus : 400;
      appendLog('error', 'AI_CONNECTION_TEST_FAILED', msg);
      res.status(status).json({
        ok: false,
        error: msg,
        code: err instanceof GeminiUpstreamError ? err.code : undefined,
        retryable: err instanceof GeminiUpstreamError ? err.retryable : false,
      });
    }
  });

  app.get('/api/settings', (_req, res) => {
    const db = getDb();
    const providersStatus = getProvidersStatus();
    const providersDetailed = getProvidersDetailedStatus(db.user.settings);
    const configured = Object.values(providersStatus).some(Boolean);
    res.json({ settings: db.user.settings, configured, providersStatus, providersDetailed });
  });

  app.patch('/api/settings', (req, res) => {
    try {
      const db = getDb();
      const merged = normalizeAiSettings({ ...db.user.settings, ...req.body });
      if (merged.providers) {
        for (const [pid, cfg] of Object.entries(merged.providers)) {
          if (pid === 'cloudflare' && cfg.endpointUrl.includes('{ACCOUNT_ID}')) {
            if (merged.provider === 'cloudflare' || merged.visionProvider === 'cloudflare') {
              validateEndpointUrl(cfg.endpointUrl);
            }
            continue;
          }
          if (cfg.endpointUrl) {
            cfg.endpointUrl = validateEndpointUrl(cfg.endpointUrl);
          }
        }
      }
      db.user.settings = merged;
      saveDb();
      appendLog(
        'info',
        'SETTINGS_UPDATED',
        `Updated Multi-API settings (translation=${merged.provider}, vision=${merged.visionProvider || 'gemini'}, allowPaidFallback=${Boolean(merged.allowPaidFallback)})`
      );
      res.json({
        settings: db.user.settings,
        providersStatus: getProvidersStatus(),
        providersDetailed: getProvidersDetailedStatus(db.user.settings),
      });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const status = err instanceof GeminiUpstreamError ? err.httpStatus : 400;
      res.status(status).json({ error: msg });
    }
  });

  // Projects CRUD
  app.get('/api/projects', (_req, res) => {
    const db = getDb();
    const result = db.projects.map((p) => {
      const chapters = db.chapters.filter((c) => c.projectId === p.id);
      const chapterIds = new Set(chapters.map((c) => c.id));
      const pages = db.pages.filter((pg) => chapterIds.has(pg.chapterId));
      const completedPages = pages.filter((pg) => pg.status === 'completed').length;
      const completionPercent =
        pages.length > 0 ? Math.round((completedPages / pages.length) * 100) : 0;
      const glossaryCount = db.glossary.filter((g) => g.projectId === p.id).length;
      return {
        ...p,
        chapters,
        glossaryCount,
        completionPercent,
      };
    });
    res.json({ projects: result });
  });

  app.post('/api/projects', (req, res) => {
    const { title, comicFormat, sourceLanguage, targetLanguage, readingDirection, translationStyle } =
      req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      res.status(400).json({ error: 'Project title is required.' });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();
    const project: Project = {
      id: `proj-${crypto.randomBytes(4).toString('hex')}`,
      userId: db.user.id,
      title: title.trim(),
      comicFormat: comicFormat || 'superhero',
      sourceLanguage: sourceLanguage || 'en',
      targetLanguage: targetLanguage || 'ar',
      readingDirection: readingDirection || 'ltr',
      translationStyle: translationStyle || 'cinematic',
      storyMemory: {
        characters: [],
        locations: [],
        loreTerms: [],
        relationships: [],
        keyFacts: [],
        translationDecisions: [],
        recurringNotes: '',
        chapterSummaries: [],
      },
      createdAt: now,
      updatedAt: now,
    };
    db.projects.unshift(project);
    saveDb();
    appendLog('info', 'PROJECT_CREATED', `Created project "${project.title}"`, {
      projectId: project.id,
    });
    res.status(201).json({ project });
  });

  app.get('/api/projects/:id', (req, res) => {
    const db = getDb();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const chapters = db.chapters.filter((c) => c.projectId === project.id);
    const glossary = db.glossary.filter((g) => g.projectId === project.id);
    res.json({ project, chapters, glossary });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const db = getDb();
    const project = db.projects.find((p) => p.id === req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const allowedFields = [
      'title',
      'comicFormat',
      'sourceLanguage',
      'targetLanguage',
      'readingDirection',
      'translationStyle',
      'storyMemory',
      'coverImage',
    ] as const;
    for (const key of allowedFields) {
      if (req.body?.[key] !== undefined) {
        (project as unknown as Record<string, unknown>)[key] = req.body[key];
      }
    }
    project.updatedAt = new Date().toISOString();
    saveDb();
    res.json({ project });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const db = getDb();
    const idx = db.projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const [removed] = db.projects.splice(idx, 1);
    const chapterIds = new Set(
      db.chapters.filter((c) => c.projectId === removed.id).map((c) => c.id)
    );
    db.chapters = db.chapters.filter((c) => c.projectId !== removed.id);
    db.pages = db.pages.filter((pg) => !chapterIds.has(pg.chapterId));
    db.glossary = db.glossary.filter((g) => g.projectId !== removed.id);
    db.jobs = db.jobs.filter((j) => j.projectId !== removed.id);
    saveDb();
    appendLog('info', 'PROJECT_DELETED', `Deleted project "${removed.title}"`);
    res.json({ ok: true });
  });

  // Scoped CORS for Browser Companion Chrome Extension (never accepts site cookies)
  app.use('/api/browser-import', (req, res, next) => {
    const origin = req.headers.origin || '';
    if (
      origin.startsWith('chrome-extension://') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      (process.env.APP_URL && origin === process.env.APP_URL)
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.post('/api/browser-import/session', (req, res) => {
    try {
      const { projectId, newProjectConfig, chapterTitle, targetUrl } = req.body || {};
      const { session, pairingToken } = createBrowserImportSession({
        projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : undefined,
        newProjectConfig,
        chapterTitle,
        targetUrl,
      });

      const forwardedProto = req.headers['x-forwarded-proto'];
      const proto = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0] : req.protocol;
      const host = req.get('host') || `localhost:${PORT}`;
      const appUrl = process.env.APP_URL && !host.includes('localhost')
        ? process.env.APP_URL.replace(/\/+$/, '')
        : `${proto}://${host}`;

      const pairingBundle = Buffer.from(
        JSON.stringify({
          appUrl,
          sessionId: session.id,
          pairingToken,
          chapterTitle: session.chapterTitle,
        })
      ).toString('base64');

      res.status(201).json({
        session,
        pairingToken,
        pairingBundle,
        appUrl,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/browser-import/session/:id', (req, res) => {
    try {
      const origin = req.headers.origin || '';
      const authHeader = req.headers.authorization || '';
      if (origin.startsWith('chrome-extension://')) {
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        verifyBrowserSessionAuth(req.params.id, token);
      }
      const session = getBrowserImportSessionPublic(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Browser import session not found' });
        return;
      }
      res.json({ session });
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser-import/pages', (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const { sessionId, pages, replaceExisting } = req.body || {};
      if (!sessionId || !Array.isArray(pages)) {
        res.status(400).json({ error: 'sessionId and pages array are required.' });
        return;
      }
      const result = appendPagesToBrowserSession(sessionId, bearerToken, pages, {
        replaceExisting: Boolean(replaceExisting),
      });
      res.status(201).json({
        ok: true,
        sessionId: result.session.id,
        addedCount: result.addedCount,
        totalPages: result.session.pages.length,
        session: result.session,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthErr = msg.includes('Pairing Token') || msg.includes('المصادقة');
      res.status(isAuthErr ? 401 : 400).json({ error: msg });
    }
  });

  app.post('/api/browser-import/complete', (req, res) => {
    try {
      const authHeader = req.headers.authorization || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const origin = req.headers.origin || '';
      const { sessionId, chapterTitle } = req.body || {};
      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 'sessionId is required.' });
        return;
      }
      const allowLocalOwner = !origin.startsWith('chrome-extension://') && !bearerToken;
      const completed = completeBrowserImportSession(sessionId, {
        bearerToken: bearerToken || undefined,
        allowLocalOwner,
        chapterTitleOverride: typeof chapterTitle === 'string' ? chapterTitle : undefined,
      });
      res.status(201).json({
        ok: true,
        ...completed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAuthErr = msg.includes('Pairing Token') || msg.includes('المصادقة');
      res.status(isAuthErr ? 401 : 400).json({ error: msg });
    }
  });

  app.get('/api/browser-import/extension-bundle.zip', async (_req, res) => {
    try {
      const extDistDir = path.resolve(process.cwd(), 'browser-extension', 'dist');
      if (!fs.existsSync(path.join(extDistDir, 'manifest.json'))) {
        res.status(404).json({ error: 'Extension build not found. Run npm run build:extension first.' });
        return;
      }
      const zip = new JSZip();
      const addDir = (dir: string, prefix = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) addDir(full, rel);
          else zip.file(rel, fs.readFileSync(full));
        }
      };
      addDir(extDistDir);
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="faqqa-browser-companion.zip"');
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // URL Chapter inspection, CDN preview proxy & import
  app.get('/api/chapters/import/proxy-image', async (req, res) => {
    try {
      const rawImgUrl = typeof req.query.url === 'string' ? req.query.url : '';
      const referer = typeof req.query.referer === 'string' ? req.query.referer : undefined;
      const customCookie = typeof req.query.cookie === 'string' ? req.query.cookie : undefined;

      if (!rawImgUrl) {
        res.status(400).json({ error: 'Missing image url parameter' });
        return;
      }

      validatePublicChapterUrl(rawImgUrl);
      const fetched = await fetchChapterImage(rawImgUrl, {
        referer,
        customCookie,
        timeoutMs: 12000,
      });

      if (!fetched.ok) {
        res.status(fetched.status >= 400 ? fetched.status : 502).json({
          error: fetched.failureReason || `CDN proxy returned HTTP ${fetched.status}`,
          category: fetched.failureCategory || 'HTTP_ERROR',
          httpStatus: fetched.status,
          source: 'server_cdn_proxy',
        });
        return;
      }

      res.setHeader('Content-Type', fetched.contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Proxy-Source', 'Faqqa-CDN-Session');
      res.send(fetched.buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg, source: 'server_cdn_proxy' });
    }
  });

  app.post('/api/chapters/import/inspect', async (req, res) => {
    try {
      const { url, customCookie } = req.body || {};
      if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'يرجى إدخال رابط الفصل.' });
        return;
      }
      const inspected = await inspectChapterUrl(url, {
        customCookie: typeof customCookie === 'string' && customCookie.trim() ? customCookie.trim() : undefined,
      });
      appendLog(
        'info',
        'CHAPTER_URL_INSPECTED',
        `Inspected "${inspected.pageTitle}" via ${inspected.adapterName} (${inspected.images.length} images)`
      );
      res.json(inspected);
    } catch (err) {
      if (err instanceof ImporterDiagnosticError) {
        appendLog('warn', 'CHAPTER_URL_INSPECT_FAILED', `${err.category} @ ${err.stage}: ${err.message}`);
        res.status(400).json({
          error: err.message,
          category: err.category,
          stage: err.stage,
          httpStatus: err.httpStatus,
          diagnostics: err.diagnostics,
          redirectChain: err.redirectChain,
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      appendLog('error', 'CHAPTER_URL_INSPECT_FAILED', msg);
      res.status(400).json({ error: msg });
    }
  });

  app.post('/api/chapters/import', async (req, res) => {
    try {
      const {
        projectId,
        title,
        sourceUrl,
        selectedImageUrls,
        requiredReferer,
        customCookie,
      } = req.body || {};
      if (!projectId || !Array.isArray(selectedImageUrls) || selectedImageUrls.length === 0) {
        res.status(400).json({ error: 'Project ID and at least one image URL are required.' });
        return;
      }

      const db = getDb();
      const project = db.projects.find((p) => p.id === projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const now = new Date().toISOString();
      const existingCount = db.chapters.filter((c) => c.projectId === projectId).length;
      const chapter: Chapter = {
        id: `ch-${crypto.randomBytes(4).toString('hex')}`,
        projectId,
        title: (title || `الفصل ${existingCount + 1}`).trim(),
        chapterNumber: existingCount + 1,
        pageCount: 0,
        status: 'draft',
        lastReadPage: 1,
        sourceUrl,
        createdAt: now,
        updatedAt: now,
      };

      const refererHeader =
        (typeof requiredReferer === 'string' && requiredReferer.trim()) ||
        (typeof sourceUrl === 'string' && sourceUrl.trim()) ||
        undefined;
      const sharedClient = new SessionHttpClient(
        typeof customCookie === 'string' && customCookie.trim() ? customCookie.trim() : undefined
      );

      const createdPages: Page[] = [];
      const failedImages: Array<{
        index: number;
        url: string;
        status: number;
        category: string;
        reason: string;
      }> = [];

      for (let i = 0; i < selectedImageUrls.length; i++) {
        const imgUrl = selectedImageUrls[i];
        validatePublicChapterUrl(imgUrl);

        const fetched = await fetchChapterImage(imgUrl, {
          referer: refererHeader,
          client: sharedClient,
          timeoutMs: 15000,
        });

        if (!fetched.ok) {
          failedImages.push({
            index: i + 1,
            url: imgUrl,
            status: fetched.status,
            category: fetched.failureCategory || 'HTTP_ERROR',
            reason: fetched.failureReason || `HTTP ${fetched.status}`,
          });
          continue;
        }

        const dataUrl = `data:${fetched.contentType};base64,${fetched.buffer.toString('base64')}`;
        const saved = saveBase64Asset(dataUrl, `ch_${chapter.id}_p${i + 1}`);
        createdPages.push({
          id: `pg-${crypto.randomBytes(4).toString('hex')}`,
          chapterId: chapter.id,
          pageNumber: createdPages.length + 1,
          originalImage: saved.url,
          status: 'pending',
          width: 900,
          height: 1200,
          rotation: 0,
          manualStrokes: [],
          panels: [],
          regions: [],
        });
      }

      if (createdPages.length === 0) {
        const primaryFailure = failedImages[0];
        const detailMsg = primaryFailure
          ? `فشل تنزيل الصور من CDN (${primaryFailure.category} · HTTP ${primaryFailure.status}): ${primaryFailure.reason}`
          : 'تعذر تنزيل الصور من الرابط المحدد.';
        appendLog('error', 'CHAPTER_URL_IMPORT_FAILED', detailMsg, { projectId });
        res.status(400).json({
          error: detailMsg,
          category: primaryFailure?.category || 'HTTP_ERROR',
          stage: 'cdn_download',
          httpStatus: primaryFailure?.status,
          failedImages,
        });
        return;
      }

      chapter.pageCount = createdPages.length;
      if (!project.coverImage) {
        project.coverImage = createdPages[0].originalImage;
      }
      project.updatedAt = now;
      db.chapters.push(chapter);
      db.pages.push(...createdPages);
      saveDb();

      appendLog(
        'info',
        'CHAPTER_URL_IMPORTED',
        `Imported ${createdPages.length}/${selectedImageUrls.length} pages from URL`,
        {
          projectId,
          chapterId: chapter.id,
        }
      );

      res.status(201).json({
        chapter,
        pages: createdPages,
        failedImages,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Upload Chapter Pages (base64 extracted images from client multi-image/ZIP/CBZ/PDF)
  app.post('/api/chapters/upload', (req, res) => {
    try {
      const { projectId, title, pages } = req.body || {};
      if (!projectId || !Array.isArray(pages) || pages.length === 0) {
        res.status(400).json({ error: 'Project ID and at least one page image are required.' });
        return;
      }

      const db = getDb();
      const project = db.projects.find((p) => p.id === projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const now = new Date().toISOString();
      const existingCount = db.chapters.filter((c) => c.projectId === projectId).length;
      const chapter: Chapter = {
        id: `ch-${crypto.randomBytes(4).toString('hex')}`,
        projectId,
        title: (title || `الفصل ${existingCount + 1}`).trim(),
        chapterNumber: existingCount + 1,
        pageCount: pages.length,
        status: 'draft',
        lastReadPage: 1,
        createdAt: now,
        updatedAt: now,
      };

      const createdPages: Page[] = pages.map(
        (
          item: { dataUrl: string; width?: number; height?: number; contentHash?: string },
          index: number
        ) => {
          const saved = saveBase64Asset(item.dataUrl, `ch_${chapter.id}_p${index + 1}`);
          return {
            id: `pg-${crypto.randomBytes(4).toString('hex')}`,
            chapterId: chapter.id,
            pageNumber: index + 1,
            originalImage: saved.url,
            status: 'pending',
            width: item.width || 900,
            height: item.height || 1200,
            rotation: 0,
            contentHash: item.contentHash,
            manualStrokes: [],
            panels: [],
            regions: [],
          };
        }
      );

      if (!project.coverImage && createdPages[0]) {
        project.coverImage = createdPages[0].originalImage;
      }
      project.updatedAt = now;
      db.chapters.push(chapter);
      db.pages.push(...createdPages);
      saveDb();

      appendLog(
        'info',
        'CHAPTER_UPLOADED',
        `Uploaded ${createdPages.length} pages to "${chapter.title}"`,
        { projectId, chapterId: chapter.id }
      );

      res.status(201).json({ chapter, pages: createdPages });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // Create empty chapter shell for chunked large-book uploads (supports 100+ page graphic novels)
  app.post('/api/chapters', (req, res) => {
    try {
      const { projectId, title } = req.body || {};
      if (!projectId) {
        res.status(400).json({ error: 'projectId is required.' });
        return;
      }
      const db = getDb();
      const project = db.projects.find((p) => p.id === projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const now = new Date().toISOString();
      const existingCount = db.chapters.filter((c) => c.projectId === projectId).length;
      const chapter: Chapter = {
        id: `ch-${crypto.randomBytes(4).toString('hex')}`,
        projectId,
        title: (title || `الفصل ${existingCount + 1}`).trim(),
        chapterNumber: existingCount + 1,
        pageCount: 0,
        status: 'draft',
        lastReadPage: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.chapters.push(chapter);
      project.updatedAt = now;
      saveDb();
      res.status(201).json({ chapter });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Append one or more pages to an existing open chapter without losing previous work
  app.post('/api/chapters/:id/pages', (req, res) => {
    try {
      const { pages } = req.body || {};
      if (!Array.isArray(pages) || pages.length === 0) {
        res.status(400).json({ error: 'pages array is required.' });
        return;
      }
      const db = getDb();
      const chapter = db.chapters.find((c) => c.id === req.params.id);
      if (!chapter) {
        res.status(404).json({ error: 'Chapter not found' });
        return;
      }
      const project = db.projects.find((p) => p.id === chapter.projectId);
      const existingPages = db.pages.filter((p) => p.chapterId === chapter.id);
      let nextPageNumber = existingPages.reduce((m, p) => Math.max(m, p.pageNumber), 0);

      const appendedPages: Page[] = pages.map(
        (item: { dataUrl: string; width?: number; height?: number; contentHash?: string }) => {
          nextPageNumber += 1;
          const saved = saveBase64Asset(item.dataUrl, `ch_${chapter.id}_p${nextPageNumber}`);
          return {
            id: `pg-${crypto.randomBytes(4).toString('hex')}`,
            chapterId: chapter.id,
            pageNumber: nextPageNumber,
            originalImage: saved.url,
            status: 'pending',
            width: item.width || 900,
            height: item.height || 1200,
            rotation: 0,
            contentHash: item.contentHash,
            manualStrokes: [],
            panels: [],
            regions: [],
          };
        }
      );

      db.pages.push(...appendedPages);
      chapter.pageCount = existingPages.length + appendedPages.length;
      if (chapter.status === 'completed') {
        chapter.status = 'partial';
      }
      chapter.updatedAt = new Date().toISOString();
      if (project) {
        if (!project.coverImage && appendedPages[0]) {
          project.coverImage = appendedPages[0].originalImage;
        }
        project.updatedAt = chapter.updatedAt;
      }
      saveDb();

      appendLog(
        'info',
        'CHAPTER_PAGES_APPENDED',
        `Appended ${appendedPages.length} pages to "${chapter.title}" (total=${chapter.pageCount})`,
        { projectId: chapter.projectId, chapterId: chapter.id }
      );

      res.status(201).json({
        chapter,
        appendedPages,
        totalPages: chapter.pageCount,
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/chapters/:id', (req, res) => {
    const db = getDb();
    const chapter = db.chapters.find((c) => c.id === req.params.id);
    if (!chapter) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const project = db.projects.find((p) => p.id === chapter.projectId);
    const pages = db.pages
      .filter((p) => p.chapterId === chapter.id)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    res.json({ chapter, project, pages });
  });

  app.patch('/api/chapters/:id', (req, res) => {
    const db = getDb();
    const chapter = db.chapters.find((c) => c.id === req.params.id);
    if (!chapter) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    if (req.body?.title) chapter.title = String(req.body.title).trim();
    if (typeof req.body?.lastReadPage === 'number') {
      chapter.lastReadPage = req.body.lastReadPage;
    }
    chapter.updatedAt = new Date().toISOString();
    saveDb();
    res.json({ chapter });
  });

  // Page management: reorder, duplicate, rotate, delete
  app.post('/api/pages/reorder', (req, res) => {
    const { chapterId, orderedPageIds } = req.body || {};
    if (!chapterId || !Array.isArray(orderedPageIds)) {
      res.status(400).json({ error: 'chapterId and orderedPageIds are required' });
      return;
    }
    const db = getDb();
    orderedPageIds.forEach((pid: string, idx: number) => {
      const pg = db.pages.find((p) => p.id === pid && p.chapterId === chapterId);
      if (pg) pg.pageNumber = idx + 1;
    });
    saveDb();
    const pages = db.pages
      .filter((p) => p.chapterId === chapterId)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    res.json({ pages });
  });

  app.post('/api/pages/:id/duplicate', (req, res) => {
    const db = getDb();
    const src = db.pages.find((p) => p.id === req.params.id);
    if (!src) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    const siblings = db.pages
      .filter((p) => p.chapterId === src.chapterId)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    const newId = `pg-${crypto.randomBytes(4).toString('hex')}`;
    const clone: Page = {
      ...JSON.parse(JSON.stringify(src)),
      id: newId,
      pageNumber: src.pageNumber + 1,
    };
    clone.regions = clone.regions.map((r, i) => ({
      ...r,
      id: `reg-${newId}-${i + 1}`,
      pageId: newId,
    }));
    for (const s of siblings) {
      if (s.pageNumber > src.pageNumber) s.pageNumber += 1;
    }
    db.pages.push(clone);
    const ch = db.chapters.find((c) => c.id === src.chapterId);
    if (ch) ch.pageCount = siblings.length + 1;
    saveDb();
    res.status(201).json({ page: clone });
  });

  app.patch('/api/pages/:id', (req, res) => {
    const db = getDb();
    const page = db.pages.find((p) => p.id === req.params.id);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    if (typeof req.body?.rotation === 'number') {
      page.rotation = (req.body.rotation % 360) as Page['rotation'];
    }
    if (Array.isArray(req.body?.manualStrokes)) {
      page.manualStrokes = req.body.manualStrokes;
    }
    if (Array.isArray(req.body?.regions)) {
      page.regions = req.body.regions;
    }
    if (req.body?.status) {
      page.status = req.body.status;
    }
    saveDb();
    res.json({ page });
  });

  app.post('/api/pages/:id/replace', (req, res) => {
    try {
      const { dataUrl, width, height, contentHash, resetRegions } = req.body || {};
      if (!dataUrl || typeof dataUrl !== 'string') {
        res.status(400).json({ error: 'dataUrl is required.' });
        return;
      }
      const db = getDb();
      const page = db.pages.find((p) => p.id === req.params.id);
      if (!page) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      const saved = saveBase64Asset(dataUrl, `replaced_${page.id}`);
      page.originalImage = saved.url;
      page.processedImage = undefined;
      if (typeof width === 'number' && width > 0) page.width = width;
      if (typeof height === 'number' && height > 0) page.height = height;
      if (typeof contentHash === 'string') page.contentHash = contentHash;
      if (resetRegions) {
        page.regions = [];
        page.panels = [];
        page.manualStrokes = [];
        page.status = 'pending';
      }
      page.errorMessage = undefined;
      saveDb();
      res.json({ page });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/pages/:id', (req, res) => {
    const db = getDb();
    const idx = db.pages.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    const [removed] = db.pages.splice(idx, 1);
    const remaining = db.pages
      .filter((p) => p.chapterId === removed.chapterId)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    remaining.forEach((p, i) => {
      p.pageNumber = i + 1;
    });
    const ch = db.chapters.find((c) => c.id === removed.chapterId);
    if (ch) ch.pageCount = remaining.length;
    saveDb();
    res.json({ ok: true, pages: remaining });
  });

  // Computer Vision + OCR analysis for a single page
  app.post('/api/pages/analyze', async (req, res) => {
    try {
      const { pageId } = req.body || {};
      const db = getDb();
      const page = db.pages.find((p) => p.id === pageId);
      if (!page) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      const chapter = db.chapters.find((c) => c.id === page.chapterId);
      const project = chapter ? db.projects.find((pr) => pr.id === chapter.projectId) : undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      page.status = 'analyzing';
      saveDb();

      const analyzed = await analyzeComicPageWithProvider(page, project.readingDirection, db.user.settings, {
        targetLanguage: project.targetLanguage,
        comicFormat: project.comicFormat,
      });
      page.panels = analyzed.panels;
      page.regions = analyzed.regions;
      page.status = 'analyzed';
      page.errorMessage = undefined;
      page.lastTranslationMeta = {
        providerUsed: page.lastTranslationMeta?.providerUsed || analyzed.providerUsed,
        modelUsed: page.lastTranslationMeta?.modelUsed || analyzed.modelUsed,
        visionProviderUsed: analyzed.providerUsed,
        visionModelUsed: analyzed.modelUsed,
        fallbackUsed: page.lastTranslationMeta?.fallbackUsed,
        updatedAt: new Date().toISOString(),
      };
      saveDb();

      appendLog(
        'info',
        'PAGE_ANALYZED',
        `Detected ${analyzed.regions.length} regions on page ${page.pageNumber} via ${analyzed.providerUsed}:${analyzed.modelUsed}`,
        { projectId: project.id, chapterId: chapter?.id, pageId: page.id }
      );
      res.json({
        page,
        providerUsed: analyzed.providerUsed,
        modelUsed: analyzed.modelUsed,
      });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const status = err instanceof GeminiUpstreamError ? err.httpStatus : 400;
      appendLog('error', 'PAGE_ANALYZE_FAILED', msg);
      res.status(status).json({
        error: msg,
        code: err instanceof GeminiUpstreamError ? err.code : undefined,
        retryable: err instanceof GeminiUpstreamError ? err.retryable : false,
      });
    }
  });

  // Translate all regions on a single page
  app.post('/api/pages/translate', async (req, res) => {
    try {
      const { pageId, styleOverride } = req.body || {};
      const db = getDb();
      const page = db.pages.find((p) => p.id === pageId);
      if (!page) {
        res.status(404).json({ error: 'Page not found' });
        return;
      }
      const chapter = db.chapters.find((c) => c.id === page.chapterId);
      const project = chapter ? db.projects.find((pr) => pr.id === chapter.projectId) : undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      let visionProviderUsed = page.lastTranslationMeta?.visionProviderUsed;
      let visionModelUsed = page.lastTranslationMeta?.visionModelUsed;

      if (page.regions.length === 0) {
        const analyzed = await analyzeComicPageWithProvider(page, project.readingDirection, db.user.settings, {
          targetLanguage: project.targetLanguage,
          comicFormat: project.comicFormat,
        });
        page.panels = analyzed.panels;
        page.regions = analyzed.regions;
        visionProviderUsed = analyzed.providerUsed;
        visionModelUsed = analyzed.modelUsed;
      }

      const prevPage = db.pages.find(
        (p) => p.chapterId === page.chapterId && p.pageNumber === page.pageNumber - 1
      );
      const previousPageContext = prevPage?.regions.length
        ? prevPage.regions
            .slice(-6)
            .map(
              (r) =>
                `${r.speaker || r.regionType}: "${r.originalText}" -> "${r.translatedText || ''}"`
            )
            .join('\n')
        : undefined;

      const glossary = db.glossary.filter((g) => g.projectId === project.id);
      const tr = await translateRegionsWithProvider(
        page.regions,
        project,
        project.storyMemory,
        glossary,
        styleOverride || project.translationStyle,
        project.targetLanguage,
        db.user.settings,
        previousPageContext
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

      if (tr.memoryUpdate || tr.summaryAddition) {
        project.storyMemory = mergeStoryMemoryUpdate(
          project.storyMemory,
          tr.memoryUpdate,
          tr.summaryAddition ? [tr.summaryAddition] : []
        );
      }

      page.status = 'completed';
      page.errorMessage = undefined;
      page.lastTranslationMeta = {
        providerUsed: tr.providerUsed,
        modelUsed: tr.modelUsed,
        visionProviderUsed,
        visionModelUsed,
        fallbackUsed: tr.fallbackUsed,
        updatedAt: new Date().toISOString(),
      };
      saveDb();

      appendLog(
        'info',
        'PAGE_TRANSLATED',
        `Translated ${tr.translations.length} regions on page ${page.pageNumber} via ${tr.providerUsed}:${tr.modelUsed}${tr.fallbackUsed ? ' (fallback)' : ''}`,
        { projectId: project.id, chapterId: chapter?.id, pageId: page.id }
      );
      res.json({
        page,
        providerUsed: tr.providerUsed,
        modelUsed: tr.modelUsed,
        fallbackUsed: tr.fallbackUsed,
        visionProviderUsed,
        visionModelUsed,
      });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const status = err instanceof GeminiUpstreamError ? err.httpStatus : 400;
      appendLog('error', 'PAGE_TRANSLATE_FAILED', msg);
      res.status(status).json({
        error: msg,
        code: err instanceof GeminiUpstreamError ? err.code : undefined,
        retryable: err instanceof GeminiUpstreamError ? err.retryable : false,
      });
    }
  });

  // Non-destructive page cleaning & render persistence
  app.post('/api/pages/clean', (req, res) => {
    const { pageId, manualStrokes } = req.body || {};
    const db = getDb();
    const page = db.pages.find((p) => p.id === pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    if (Array.isArray(manualStrokes)) {
      page.manualStrokes = manualStrokes;
    }
    if (page.status === 'analyzed' || page.status === 'pending') {
      page.status = 'cleaned';
    }
    saveDb();
    res.json({ page });
  });

  app.post('/api/pages/render', (req, res) => {
    const { pageId, processedDataUrl } = req.body || {};
    const db = getDb();
    const page = db.pages.find((p) => p.id === pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    if (processedDataUrl && typeof processedDataUrl === 'string') {
      const saved = saveBase64Asset(processedDataUrl, `rendered_${page.id}`);
      page.processedImage = saved.url;
    }
    page.status = 'completed';
    saveDb();
    res.json({ page });
  });

  // Bubble / Region CRUD & Single-Bubble Retranslation
  app.post('/api/bubbles', (req, res) => {
    const { pageId, regionType, boundingBox, originalText, translatedText } = req.body || {};
    const db = getDb();
    const page = db.pages.find((p) => p.id === pageId);
    if (!page) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }
    const chapter = db.chapters.find((c) => c.id === page.chapterId);
    const project = chapter ? db.projects.find((pr) => pr.id === chapter.projectId) : undefined;
    const type: TextRegion['regionType'] = regionType || 'dialogue';
    const box = boundingBox || { x: 350, y: 350, width: 220, height: 150 };
    const region: TextRegion = {
      id: `reg-${page.id}-${Date.now()}`,
      pageId: page.id,
      regionType: type,
      boundingBox: box,
      boundingPolygon: boxToPolygon(box),
      originalText: originalText || '',
      translatedText: translatedText || 'نص مترجم جديد',
      alternatives: [],
      sourceLanguage: project?.sourceLanguage || 'auto',
      confidence: 1.0,
      readingOrder: page.regions.length + 1,
      fontSettings: createDefaultFontSettings(project?.targetLanguage || 'ar', type),
      cleanMode: type === 'sfx' ? 'keep' : 'auto',
      sfxMode: type === 'sfx' ? 'side' : 'keep',
      approvalStatus: 'pending',
      translationStatus: 'edited',
    };
    page.regions.push(region);
    saveDb();
    res.status(201).json({ region, page });
  });

  app.patch('/api/bubbles/:id', (req, res) => {
    const db = getDb();
    let foundRegion: TextRegion | undefined;
    let foundPage: Page | undefined;

    for (const pg of db.pages) {
      const reg = pg.regions.find((r) => r.id === req.params.id);
      if (reg) {
        foundRegion = reg;
        foundPage = pg;
        break;
      }
    }

    if (!foundRegion || !foundPage) {
      res.status(404).json({ error: 'Region not found' });
      return;
    }

    const patch = req.body || {};
    if (patch.originalText !== undefined) foundRegion.originalText = patch.originalText;
    if (patch.translatedText !== undefined) {
      foundRegion.translatedText = patch.translatedText;
      foundRegion.translationStatus = 'edited';
    }
    if (patch.regionType !== undefined) foundRegion.regionType = patch.regionType;
    if (patch.speaker !== undefined) foundRegion.speaker = patch.speaker;
    if (patch.cleanMode !== undefined) foundRegion.cleanMode = patch.cleanMode;
    if (patch.sfxMode !== undefined) foundRegion.sfxMode = patch.sfxMode;
    if (patch.approvalStatus !== undefined) foundRegion.approvalStatus = patch.approvalStatus;
    if (patch.fontSettings !== undefined) {
      foundRegion.fontSettings = { ...foundRegion.fontSettings, ...patch.fontSettings };
    }
    if (patch.boundingPolygon && Array.isArray(patch.boundingPolygon)) {
      foundRegion.boundingPolygon = patch.boundingPolygon;
      foundRegion.boundingBox = polygonToBox(patch.boundingPolygon);
    } else if (patch.boundingBox) {
      foundRegion.boundingBox = patch.boundingBox;
      foundRegion.boundingPolygon = boxToPolygon(patch.boundingBox);
    }

    saveDb();
    res.json({ region: foundRegion, page: foundPage });
  });

  app.delete('/api/bubbles/:id', (req, res) => {
    const db = getDb();
    for (const pg of db.pages) {
      const idx = pg.regions.findIndex((r) => r.id === req.params.id);
      if (idx !== -1) {
        pg.regions.splice(idx, 1);
        saveDb();
        res.json({ ok: true, page: pg });
        return;
      }
    }
    res.status(404).json({ error: 'Region not found' });
  });

  app.post('/api/bubbles/:id/retranslate', async (req, res) => {
    try {
      const { style, customInstruction } = req.body || {};
      const db = getDb();
      let targetRegion: TextRegion | undefined;
      let parentPage: Page | undefined;

      for (const pg of db.pages) {
        const reg = pg.regions.find((r) => r.id === req.params.id);
        if (reg) {
          targetRegion = reg;
          parentPage = pg;
          break;
        }
      }

      if (!targetRegion || !parentPage) {
        res.status(404).json({ error: 'Region not found' });
        return;
      }

      const chapter = db.chapters.find((c) => c.id === parentPage!.chapterId);
      const project = chapter ? db.projects.find((pr) => pr.id === chapter.projectId) : undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const glossary = db.glossary.filter((g) => g.projectId === project.id);
      const result = await retranslateSingleBubbleWithProvider(
        targetRegion,
        parentPage.regions,
        project,
        glossary,
        style || project.translationStyle,
        project.targetLanguage,
        db.user.settings,
        customInstruction
      );

      targetRegion.translatedText = result.translatedText;
      targetRegion.alternatives = result.alternatives || [];
      targetRegion.translationStatus = 'translated';
      parentPage.lastTranslationMeta = {
        ...parentPage.lastTranslationMeta,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        fallbackUsed: result.fallbackUsed,
        updatedAt: new Date().toISOString(),
      };
      saveDb();

      res.json({
        region: targetRegion,
        page: parentPage,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed,
        fallbackUsed: result.fallbackUsed,
      });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      const status = err instanceof GeminiUpstreamError ? err.httpStatus : 400;
      res.status(status).json({
        error: msg,
        code: err instanceof GeminiUpstreamError ? err.code : undefined,
        retryable: err instanceof GeminiUpstreamError ? err.retryable : false,
      });
    }
  });

  // Batch Jobs API
  app.get('/api/jobs', (req, res) => {
    const db = getDb();
    const chapterId = typeof req.query.chapterId === 'string' ? req.query.chapterId : '';
    const jobs = chapterId ? db.jobs.filter((j) => j.chapterId === chapterId) : db.jobs;
    res.json({ jobs, logs: db.logs });
  });

  app.post('/api/jobs', (req, res) => {
    try {
      const { chapterId, retryOnlyFailed, pageIds, forceRetranslate, batchSize } = req.body || {};
      const job = createTranslationJob(chapterId, {
        retryOnlyFailed: Boolean(retryOnlyFailed),
        pageIds: Array.isArray(pageIds) ? pageIds : undefined,
        forceRetranslate: Boolean(forceRetranslate),
        batchSize: typeof batchSize === 'number' ? batchSize : 2,
      });
      res.status(201).json({ job });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const db = getDb();
    const job = db.jobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/jobs/:id/:action', (req, res) => {
    try {
      const action = req.params.action as 'pause' | 'resume' | 'cancel' | 'retry_failed';
      if (!['pause', 'resume', 'cancel', 'retry_failed'].includes(action)) {
        res.status(400).json({ error: 'Invalid job action' });
        return;
      }
      const job = controlJob(req.params.id, action);
      res.json({ job });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  app.delete('/api/logs', (_req, res) => {
    const db = getDb();
    db.logs = [];
    saveDb();
    res.json({ ok: true });
  });

  // Glossary API
  app.get('/api/glossary/:projectId', (req, res) => {
    const db = getDb();
    const entries = db.glossary.filter((g) => g.projectId === req.params.projectId);
    res.json({ entries });
  });

  app.post('/api/glossary', (req, res) => {
    const { projectId, originalTerm, translatedTerm, category, notes } = req.body || {};
    if (!projectId || !originalTerm?.trim() || !translatedTerm?.trim()) {
      res.status(400).json({ error: 'projectId, originalTerm, and translatedTerm are required' });
      return;
    }
    const db = getDb();
    const entry: GlossaryEntry = {
      id: `gloss-${crypto.randomBytes(4).toString('hex')}`,
      projectId,
      originalTerm: originalTerm.trim(),
      translatedTerm: translatedTerm.trim(),
      category: normalizeGlossaryCategory(category),
      notes: (notes || '').trim(),
    };
    db.glossary.unshift(entry);
    saveDb();
    res.status(201).json({ entry });
  });

  app.post('/api/glossary/:projectId/import', (req, res) => {
    const { entries } = req.body || {};
    if (!Array.isArray(entries)) {
      res.status(400).json({ error: 'entries array is required' });
      return;
    }
    const db = getDb();
    const added: GlossaryEntry[] = [];
    for (const item of entries) {
      if (!item.originalTerm || !item.translatedTerm) continue;
      const entry: GlossaryEntry = {
        id: `gloss-${crypto.randomBytes(4).toString('hex')}`,
        projectId: req.params.projectId,
        originalTerm: String(item.originalTerm).trim(),
        translatedTerm: String(item.translatedTerm).trim(),
        category: normalizeGlossaryCategory(item.category),
        notes: String(item.notes || '').trim(),
      };
      db.glossary.unshift(entry);
      added.push(entry);
    }
    saveDb();
    res.status(201).json({ added, count: added.length });
  });

  app.delete('/api/glossary/:id', (req, res) => {
    const db = getDb();
    const idx = db.glossary.findIndex((g) => g.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Glossary entry not found' });
      return;
    }
    db.glossary.splice(idx, 1);
    saveDb();
    res.json({ ok: true });
  });

  // Server-side Export endpoint (builds ZIP/CBZ from rendered or original pages + editable JSON layers)
  app.post('/api/export', async (req, res) => {
    try {
      const { chapterId, format, contentMode, includeEditableLayersJson, renderedPages } =
        req.body || {};
      const db = getDb();
      const chapter = db.chapters.find((c) => c.id === chapterId);
      if (!chapter) {
        res.status(404).json({ error: 'Chapter not found' });
        return;
      }
      const pages = db.pages
        .filter((p) => p.chapterId === chapterId)
        .sort((a, b) => a.pageNumber - b.pageNumber);

      const zip = new JSZip();
      const renderedMap = new Map<string, string>(
        Array.isArray(renderedPages)
          ? renderedPages.map((rp: { pageId: string; dataUrl: string }) => [rp.pageId, rp.dataUrl])
          : []
      );

      for (const p of pages) {
        const num = String(p.pageNumber).padStart(3, '0');
        if (contentMode === 'translated' || contentMode === 'both') {
          const dataUrl = renderedMap.get(p.id);
          if (dataUrl) {
            const b64 = dataUrl.split(',')[1];
            if (b64) {
              zip.file(
                `${contentMode === 'both' ? 'translated/' : ''}${num}_translated.png`,
                Buffer.from(b64, 'base64')
              );
            }
          }
        }
        if (contentMode === 'original' || contentMode === 'both') {
          let localPath = '';
          if (p.originalImage.startsWith('/uploads/')) {
            localPath = path.resolve(process.cwd(), 'data', p.originalImage.slice(1));
          } else if (p.originalImage.startsWith('/src/')) {
            localPath = path.resolve(process.cwd(), p.originalImage.slice(1));
          }
          if (localPath && fs.existsSync(localPath)) {
            const ext = path.extname(localPath) || '.jpg';
            zip.file(
              `${contentMode === 'both' ? 'original/' : ''}${num}_original${ext}`,
              fs.readFileSync(localPath)
            );
          }
        }
      }

      if (includeEditableLayersJson) {
        zip.file(
          'editable_layers.json',
          JSON.stringify({ chapter, pages }, null, 2)
        );
      }

      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      const ext = format === 'cbz' ? 'cbz' : 'zip';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="chapter.${ext}"`);
      res.send(buf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // =========================================================================
  // Internal Web Browser Engine & Smart Browser Chapter Importer
  // =========================================================================
  app.get('/api/browser/capabilities', (_req, res) => {
    res.json({ capabilities: getBrowserCapabilities() });
  });

  app.get('/api/browser/state', async (_req, res) => {
    try {
      const state = getBrowserWorkspaceState();
      const tabs = await listBrowserTabs();
      res.json({ state, tabs });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/privacy', async (req, res) => {
    try {
      const { privacyMode, homeUrl, clearHistory, clearSessionCookies } = req.body || {};
      const state = await updateBrowserPrivacySettings({
        privacyMode,
        homeUrl,
        clearHistory: Boolean(clearHistory),
        clearSessionCookies: Boolean(clearSessionCookies),
      });
      res.json({ state });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/bookmarks', (req, res) => {
    try {
      const { title, url } = req.body || {};
      if (!url) {
        res.status(400).json({ error: 'url is required' });
        return;
      }
      const bookmarks = addBrowserBookmark(String(title || url), String(url));
      res.status(201).json({ bookmarks });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/browser/bookmarks/:id', (req, res) => {
    const bookmarks = removeBrowserBookmark(req.params.id);
    res.json({ bookmarks });
  });

  app.get('/api/browser/tabs', async (_req, res) => {
    const tabs = await listBrowserTabs();
    res.json({ tabs });
  });

  app.post('/api/browser/tabs', async (req, res) => {
    try {
      const { url, privacyMode } = req.body || {};
      const tab = await createBrowserTab({ url, privacyMode });
      const tabs = await listBrowserTabs();
      res.status(201).json({ tab, tabs });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/browser/tabs/:id', async (req, res) => {
    try {
      const tab = await getBrowserTabSnapshot(req.params.id);
      res.json({ tab });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/browser/tabs/:id', async (req, res) => {
    await closeBrowserTab(req.params.id);
    const tabs = await listBrowserTabs();
    res.json({ ok: true, tabs });
  });

  app.post('/api/browser/tabs/:id/navigate', async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url) {
        res.status(400).json({ error: 'url is required' });
        return;
      }
      const tab = await navigateBrowserTab(req.params.id, String(url));
      const tabs = await listBrowserTabs();
      const state = getBrowserWorkspaceState();
      res.json({ tab, tabs, history: state.history });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/tabs/:id/back', async (req, res) => {
    try {
      const tab = await goBackBrowserTab(req.params.id);
      const tabs = await listBrowserTabs();
      res.json({ tab, tabs });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/tabs/:id/forward', async (req, res) => {
    try {
      const tab = await goForwardBrowserTab(req.params.id);
      const tabs = await listBrowserTabs();
      res.json({ tab, tabs });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/tabs/:id/reload', async (req, res) => {
    try {
      const tab = await reloadBrowserTab(req.params.id);
      res.json({ tab });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/tabs/:id/interact', async (req, res) => {
    try {
      const action = req.body;
      if (!action || typeof action.type !== 'string') {
        res.status(400).json({ error: 'Invalid interaction payload' });
        return;
      }
      const tab = await interactWithBrowserTab(req.params.id, action);
      const tabs = await listBrowserTabs();
      res.json({ tab, tabs });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/tabs/:id/collect-images', async (req, res) => {
    try {
      const autoScrollLazy = Boolean(req.body?.autoScrollLazy);
      const result = await collectTabComicImages(req.params.id, { autoScrollLazy });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/tabs/:id/screenshot', async (req, res) => {
    try {
      const mode = req.body?.mode === 'full_page' ? 'full_page' : 'visible';
      const image = await captureTabScreenshotAsPage(req.params.id, mode);
      res.json({ image });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/browser/import-to-studio', (req, res) => {
    try {
      const { projectId, newProjectConfig, chapterTitle, sourceUrl, pages } = req.body || {};
      const result = importBrowserImagesToStudio({
        projectId,
        newProjectConfig,
        chapterTitle,
        sourceUrl,
        pages,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // =========================================================================
  // Android Share Intent & PWA Web Share Target Bridge
  // =========================================================================
  app.post('/api/mobile/share-import', async (req, res) => {
    try {
      const result = await importMobileSharePayload(req.body || {});
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Vite dev middleware or static production build
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PanelTranslate AI server listening on http://localhost:${PORT}`);
  });
}

startServer();
