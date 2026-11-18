import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { chromium, type Browser, type BrowserContext, type Page as PwPage } from 'playwright-core';
import type {
  BrowserBookmark,
  BrowserCapabilities,
  BrowserChapterLink,
  BrowserDiscoveredImage,
  BrowserHistoryEntry,
  BrowserPrivacyMode,
  BrowserProtectionStatus,
  BrowserTabSnapshot,
  Chapter,
  ComicFormat,
  Page,
  ReadingDirection,
  TranslationStyle,
} from '../src/types/domain.ts';
import { validateAndDecodeImageDataUrl } from './browserImport.ts';
import { appendLog, ensureDataDirs, getDb, saveBase64Asset, saveDb } from './store.ts';

const VIEWPORT_WIDTH = 1120;
const VIEWPORT_HEIGHT = 760;
const BROWSER_STATE_FILE = path.resolve(process.cwd(), 'data', 'browser_workspace.json');

interface PersistedBrowserState {
  privacyMode: BrowserPrivacyMode;
  homeUrl: string;
  bookmarks: BrowserBookmark[];
  history: BrowserHistoryEntry[];
}

interface CachedNetworkImage {
  url: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  buffer: Buffer;
  sha256: string;
}

interface InternalTab {
  id: string;
  privacyMode: BrowserPrivacyMode;
  pwPage: PwPage;
  title: string;
  url: string;
  httpStatus: number | null;
  loading: boolean;
  error?: string;
  historyStack: string[];
  historyIndex: number;
  networkImages: Map<string, CachedNetworkImage>;
  lastCollectedImages: BrowserDiscoveredImage[];
}

const DEFAULT_BOOKMARKS: BrowserBookmark[] = [
  {
    id: 'bm-comic-plus',
    title: 'GlobalComix — Western Comics',
    url: 'https://globalcomix.com',
    createdAt: new Date(0).toISOString(),
  },
  {
    id: 'bm-webtoons',
    title: 'WEBTOON — English',
    url: 'https://www.webtoons.com/en/',
    createdAt: new Date(0).toISOString(),
  },
  {
    id: 'bm-mangadex',
    title: 'MangaDex',
    url: 'https://mangadex.org',
    createdAt: new Date(0).toISOString(),
  },
];

let persistedStateCache: PersistedBrowserState | null = null;
let sharedBrowser: Browser | null = null;
let standardContext: BrowserContext | null = null;
let incognitoContext: BrowserContext | null = null;
const activeTabs = new Map<string, InternalTab>();

function loadPersistedBrowserState(): PersistedBrowserState {
  ensureDataDirs();
  if (persistedStateCache) return persistedStateCache;
  if (fs.existsSync(BROWSER_STATE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(BROWSER_STATE_FILE, 'utf-8')) as PersistedBrowserState;
      persistedStateCache = {
        privacyMode: raw.privacyMode === 'incognito' ? 'incognito' : 'standard',
        homeUrl: raw.homeUrl || 'pt://home',
        bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks : [...DEFAULT_BOOKMARKS],
        history: Array.isArray(raw.history) ? raw.history : [],
      };
      return persistedStateCache;
    } catch {
      // Fallback cleanly
    }
  }
  persistedStateCache = {
    privacyMode: 'standard',
    homeUrl: 'pt://home',
    bookmarks: [...DEFAULT_BOOKMARKS],
    history: [],
  };
  savePersistedBrowserState();
  return persistedStateCache;
}

function savePersistedBrowserState(): void {
  ensureDataDirs();
  if (!persistedStateCache) return;
  const tmp = `${BROWSER_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(persistedStateCache, null, 2), 'utf-8');
  fs.renameSync(tmp, BROWSER_STATE_FILE);
}

/**
 * Inspects local Chromium / Playwright runtime availability cleanly.
 */
export function findChromiumExecutable(): string | undefined {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    candidates.push(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  }
  candidates.push(
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  );

  // Dynamically scan /ms-playwright for any installed chromium version
  if (fs.existsSync('/ms-playwright')) {
    try {
      for (const dir of fs.readdirSync('/ms-playwright')) {
        if (dir.startsWith('chromium_headless_shell')) {
          candidates.push(
            path.join('/ms-playwright', dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
          );
        } else if (dir.startsWith('chromium-')) {
          candidates.push(path.join('/ms-playwright', dir, 'chrome-linux', 'chrome'));
          candidates.push(path.join('/ms-playwright', dir, 'chrome-linux64', 'chrome'));
        }
      }
    } catch {
      // Ignore scan error
    }
  }

  return candidates.find((p) => p && fs.existsSync(p));
}

export function getBrowserCapabilities(): BrowserCapabilities {
  const execPath = findChromiumExecutable();
  const androidDir = path.resolve(process.cwd(), 'android-browser-module');
  return {
    environment: 'ai_studio_web',
    iframeSupported: false,
    iframeReason:
      'بيئة الويب في المتصفح تمنع iframe من عرض معظم مواقع الكوميكس بسبب X-Frame-Options/CSP وقيود Cross-Origin DOM؛ لذلك يعمل المتصفح الداخلي عبر محرك Chromium حقيقي على الخادم في الويب، وعبر وحدة Kotlin WebView أصلية على Android.',
    serverChromiumAvailable: Boolean(execPath),
    chromiumExecutablePath: execPath,
    androidModuleAvailable: fs.existsSync(androidDir),
    androidModulePath: '/android-browser-module',
    shareIntentSupported: true,
  };
}

function isBlockedPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.')) return true;
  if (h.startsWith('169.254.')) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172) {
    const oct = Number(m172[1]);
    if (oct >= 16 && oct <= 31) return true;
  }
  return false;
}

export function validateBrowserUrl(
  rawUrl: string,
  opts?: { allowLocalTestServer?: boolean }
): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || trimmed === 'pt://home') return 'pt://home';
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('الرابط المدخل غير صالح.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('يدعم المتصفح الداخلي روابط HTTP و HTTPS فقط.');
  }
  if (!opts?.allowLocalTestServer && isBlockedPrivateHost(parsed.hostname)) {
    throw new Error('تم حظر الوصول إلى الشبكة الداخلية أو عناوين localhost لأسباب أمنية.');
  }
  return parsed.toString();
}

async function ensureBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  const execPath = findChromiumExecutable();
  if (!execPath) {
    throw new Error(
      'محرك Chromium غير متوفر على الخادم. يرجى استخدام وحدة Android WebView أو رفع الملفات المحلية أو إضافة المتصفح.'
    );
  }
  sharedBrowser = await chromium.launch({
    executablePath: execPath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return sharedBrowser;
}

async function ensureContext(privacyMode: BrowserPrivacyMode): Promise<BrowserContext> {
  const browser = await ensureBrowser();
  if (privacyMode === 'incognito') {
    if (!incognitoContext) {
      incognitoContext = await browser.newContext({
        viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
        javaScriptEnabled: true,
        ignoreHTTPSErrors: false,
      });
    }
    return incognitoContext;
  }
  if (!standardContext) {
    standardContext = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
    });
  }
  return standardContext;
}

function renderHomePageHtml(): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>متصفح فُقّاعة — Faqqa Browser</title>
  <style>
    body { margin:0; font-family: system-ui, -apple-system, sans-serif; background:#111216; color:#FFFDF9; padding:48px 56px; }
    .wrap { max-width:860px; margin:0 auto; }
    h1 { font-size:28px; margin:0 0 10px; color:#FFE01B; font-weight:900; }
    p { color:#CBD5E1; line-height:1.7; font-size:15px; margin:0 0 28px; }
    .grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:16px; }
    .card { display:block; text-decoration:none; background:#1A1B21; border:2px solid #2E303A; border-radius:16px; padding:18px; color:#FFFDF9; }
    .card:hover { border-color:#FFE01B; }
    .title { font-weight:700; font-size:15px; margin-bottom:6px; }
    .sub { font-size:12px; color:#94A3B8; direction:ltr; text-align:left; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>متصفح فُقّاعة (Faqqa) الداخلي</h1>
    <p>أدخل رابط أي موقع كوميكس غربية أو مانغا أو مانهوا في شريط العناوين بالأعلى. يدعم هذا المتصفح تنفيذ JavaScript والتمرير الطبيعي لصور Lazy Loading وتسجيل الدخول اليدوي دون استخدام iframe، ثم استيراد الصور مباشرة إلى محرر الترجمة.</p>
    <div class="grid">
      <a class="card" href="https://globalcomix.com"><div class="title">GlobalComix</div><div class="sub">https://globalcomix.com</div></a>
      <a class="card" href="https://www.webtoons.com/en/"><div class="title">WEBTOON English</div><div class="sub">https://www.webtoons.com/en/</div></a>
      <a class="card" href="https://mangadex.org"><div class="title">MangaDex</div><div class="sub">https://mangadex.org</div></a>
    </div>
  </div>
</body>
</html>`;
}

function classifyMimeFromHeader(ct: string, buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (ct.includes('png')) return 'image/png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'image/jpeg';
  if (ct.includes('webp')) return 'image/webp';
  return null;
}

function attachNetworkImageCapture(tab: InternalTab): void {
  tab.pwPage.on('response', async (res) => {
    try {
      const reqType = res.request().resourceType();
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (reqType !== 'image' && !ct.startsWith('image/')) return;
      if (res.status() < 200 || res.status() >= 300) return;
      const body = await res.body().catch(() => null);
      if (!body || body.length < 3072 || body.length > 15 * 1024 * 1024) return;
      const mimeType = classifyMimeFromHeader(ct, body);
      if (!mimeType) return;
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const finalUrl = res.url();
      tab.networkImages.set(finalUrl, {
        url: finalUrl,
        mimeType,
        buffer: body,
        sha256,
      });
      if (tab.networkImages.size > 160) {
        const firstKey = tab.networkImages.keys().next().value;
        if (firstKey) tab.networkImages.delete(firstKey);
      }
    } catch {
      // Ignore closed page or unbuffered response
    }
  });
}

async function detectProtectionState(tab: InternalTab): Promise<{
  status: BrowserProtectionStatus;
  message?: string;
}> {
  if (tab.httpStatus === 403) {
    return {
      status: 'http_403_blocked',
      message:
        'رفض الموقع الوصول برمز HTTP 403 (لا يُعدّ هذا نجاحاً للاستيراد). يمكنك محاولة التحقق داخل المتصفح أو الفتح في المتصفح الخارجي أو رفع الملفات المحلية.',
    };
  }

  try {
    const signals = await tab.pwPage.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      const bodyText = (document.body?.innerText || '').slice(0, 1500).toLowerCase();
      const hasCf =
        Boolean(document.querySelector('#challenge-running, #cf-challenge-running, .cf-browser-verification')) ||
        title.includes('just a moment') ||
        bodyText.includes('verify you are human') ||
        bodyText.includes('checking your browser');
      const hasCaptcha = Boolean(
        document.querySelector(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile'
        )
      );
      const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
      const largeImages = Array.from(document.querySelectorAll('img')).filter(
        (img) => img.naturalWidth >= 250 && img.naturalHeight >= 250
      ).length;
      return { hasCf, hasCaptcha, hasPasswordInput, largeImages };
    });

    if (signals.hasCf) {
      return {
        status: 'cloudflare_challenge',
        message:
          'ظهرت صفحة تحقق Cloudflare. يمكنك إتمام التحقق يدوياً داخل نافذة المتصفح أدناه دون محاولة تجاوز الحماية، أو استخدام المتصفح الخارجي / رفع الملفات.',
      };
    }
    if (signals.hasCaptcha) {
      return {
        status: 'captcha_challenge',
        message:
          'يطلب الموقع تحقق CAPTCHA بشرياً. أكمل التحقق بنفسك داخل المتصفح إذا سمح الموقع بذلك، أو افتحه في المتصفح الخارجي.',
      };
    }
    if (signals.hasPasswordInput && signals.largeImages === 0) {
      return {
        status: 'login_wall',
        message:
          'يتطلب هذا المحتوى تسجيل الدخول اليدوي. انقر على حقول الدخول في الصفحة وأدخل بياناتك يدوياً.',
      };
    }
  } catch {
    // Ignore transient navigation evaluation
  }
  return { status: 'clear' };
}

async function buildTabSnapshot(tab: InternalTab): Promise<BrowserTabSnapshot> {
  let screenshotDataUrl = '';
  try {
    const buf = await tab.pwPage.screenshot({ type: 'jpeg', quality: 82 });
    screenshotDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    screenshotDataUrl = '';
  }

  let domMeta: {
    title: string;
    scrollY: number;
    scrollHeight: number;
    chapterLinks: BrowserChapterLink[];
    focusedInput: { tag: string; type: string; placeholder?: string } | null;
    discoveredImageCount: number;
  } = {
    title: tab.title || 'New Tab',
    scrollY: 0,
    scrollHeight: VIEWPORT_HEIGHT,
    chapterLinks: [],
    focusedInput: null,
    discoveredImageCount: tab.lastCollectedImages.length,
  };

  try {
    domMeta = await tab.pwPage.evaluate(() => {
      const title = document.title || 'New Tab';
      const scrollY = Math.round(window.scrollY || 0);
      const scrollHeight = Math.round(document.documentElement?.scrollHeight || document.body?.scrollHeight || 760);

      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const focusedInput =
        active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
          ? {
              tag: active.tagName.toLowerCase(),
              type: (active as HTMLInputElement).type || 'text',
              placeholder: active.placeholder || undefined,
            }
          : null;

      const links: Array<{ label: string; url: string; kind: 'prev' | 'next' | 'chapter' }> = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (a as HTMLAnchorElement).href;
        if (!href || !/^https?:\/\//i.test(href) || seen.has(href)) continue;
        const text = (a.textContent || a.getAttribute('aria-label') || '').trim();
        const lower = `${text} ${href}`.toLowerCase();
        let kind: 'prev' | 'next' | 'chapter' | null = null;
        if (/(\bnext\b|التالي|فصل تال|next chapter|ch\.?\s*next)/i.test(lower)) kind = 'next';
        else if (/(\bprev\b|\bprevious\b|السابق|فصل سابق)/i.test(lower)) kind = 'prev';
        else if (/(chapter|issue|episode|ch-|الفصل|العدد)\s*\d*/i.test(lower) && text.length > 0 && text.length <= 64) {
          kind = 'chapter';
        }
        if (kind) {
          seen.add(href);
          links.push({ label: text.slice(0, 48) || kind.toUpperCase(), url: href, kind });
        }
        if (links.length >= 16) break;
      }

      const imgs = Array.from(document.querySelectorAll('img')).filter(
        (img) => img.naturalWidth >= 180 && img.naturalHeight >= 180
      ).length;
      const canvases = Array.from(document.querySelectorAll('canvas')).filter(
        (c) => c.width >= 200 && c.height >= 200
      ).length;

      return {
        title,
        scrollY,
        scrollHeight,
        chapterLinks: links,
        focusedInput,
        discoveredImageCount: imgs + canvases,
      };
    });
  } catch {
    // Fallback to previous values during navigation
  }

  tab.title = domMeta.title || tab.title;
  const protection = await detectProtectionState(tab);

  return {
    id: tab.id,
    title: tab.url === 'pt://home' ? 'متصفح فُقّاعة — Faqqa' : tab.title,
    url: tab.url,
    canGoBack: tab.historyIndex > 0,
    canGoForward: tab.historyIndex < tab.historyStack.length - 1,
    loading: tab.loading,
    httpStatus: tab.httpStatus,
    protectionStatus: protection.status,
    protectionMessage: protection.message,
    scrollY: domMeta.scrollY,
    scrollHeight: domMeta.scrollHeight,
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    screenshotDataUrl,
    discoveredImageCount: Math.max(domMeta.discoveredImageCount, tab.lastCollectedImages.length),
    chapterLinks: domMeta.chapterLinks,
    focusedInput: domMeta.focusedInput,
    privacyMode: tab.privacyMode,
    error: tab.error,
  };
}

export async function createBrowserTab(opts?: {
  url?: string;
  privacyMode?: BrowserPrivacyMode;
  allowLocalTestServer?: boolean;
}): Promise<BrowserTabSnapshot> {
  const state = loadPersistedBrowserState();
  const privacyMode = opts?.privacyMode || state.privacyMode;
  const ctx = await ensureContext(privacyMode);
  const pwPage = await ctx.newPage();

  const tabId = `btab-${crypto.randomBytes(4).toString('hex')}`;
  const tab: InternalTab = {
    id: tabId,
    privacyMode,
    pwPage,
    title: 'New Tab',
    url: 'pt://home',
    httpStatus: 200,
    loading: false,
    historyStack: ['pt://home'],
    historyIndex: 0,
    networkImages: new Map(),
    lastCollectedImages: [],
  };

  attachNetworkImageCapture(tab);
  activeTabs.set(tabId, tab);

  const initialUrl = opts?.url?.trim() || state.homeUrl || 'pt://home';
  return navigateBrowserTab(tabId, initialUrl, {
    allowLocalTestServer: opts?.allowLocalTestServer,
    historyMode: 'replace_initial',
  });
}

export async function getBrowserTabSnapshot(tabId: string): Promise<BrowserTabSnapshot> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');
  return buildTabSnapshot(tab);
}

export async function listBrowserTabs(): Promise<
  Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>
> {
  return Array.from(activeTabs.values()).map((t) => ({
    id: t.id,
    title: t.url === 'pt://home' ? 'متصفح فُقّاعة — Faqqa' : t.title,
    url: t.url,
    privacyMode: t.privacyMode,
  }));
}

export async function closeBrowserTab(tabId: string): Promise<void> {
  const tab = activeTabs.get(tabId);
  if (!tab) return;
  activeTabs.delete(tabId);
  await tab.pwPage.close().catch(() => undefined);

  // If no incognito tabs remain, wipe incognito context completely
  if (
    tab.privacyMode === 'incognito' &&
    !Array.from(activeTabs.values()).some((t) => t.privacyMode === 'incognito') &&
    incognitoContext
  ) {
    await incognitoContext.close().catch(() => undefined);
    incognitoContext = null;
  }
}

function recordBrowsingHistory(tab: InternalTab): void {
  const state = loadPersistedBrowserState();
  if (tab.privacyMode === 'incognito' || state.privacyMode === 'incognito') return;
  if (!tab.url || tab.url === 'pt://home') return;

  state.history.unshift({
    id: `hist-${crypto.randomBytes(4).toString('hex')}`,
    title: tab.title || tab.url,
    url: tab.url,
    visitedAt: new Date().toISOString(),
  });
  if (state.history.length > 100) state.history.length = 100;
  savePersistedBrowserState();
}

export async function navigateBrowserTab(
  tabId: string,
  rawUrl: string,
  opts?: { historyMode?: 'push' | 'replace_initial' | 'none'; allowLocalTestServer?: boolean }
): Promise<BrowserTabSnapshot> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');

  const safeUrl = validateBrowserUrl(rawUrl, {
    allowLocalTestServer: opts?.allowLocalTestServer,
  });

  tab.loading = true;
  tab.error = undefined;
  tab.networkImages.clear();
  tab.lastCollectedImages = [];

  try {
    if (safeUrl === 'pt://home') {
      await tab.pwPage.setContent(renderHomePageHtml(), { waitUntil: 'domcontentloaded' });
      tab.url = 'pt://home';
      tab.title = 'متصفح فُقّاعة — Faqqa';
      tab.httpStatus = 200;
    } else {
      const response = await tab.pwPage.goto(safeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 22000,
      });
      await tab.pwPage.waitForTimeout(450);
      tab.url = tab.pwPage.url() || safeUrl;
      tab.title = (await tab.pwPage.title().catch(() => safeUrl)) || safeUrl;
      tab.httpStatus = response ? response.status() : null;
    }

    const mode = opts?.historyMode || 'push';
    if (mode === 'replace_initial') {
      tab.historyStack = [tab.url];
      tab.historyIndex = 0;
    } else if (mode === 'push') {
      if (tab.historyStack[tab.historyIndex] !== tab.url) {
        tab.historyStack = tab.historyStack.slice(0, tab.historyIndex + 1);
        tab.historyStack.push(tab.url);
        tab.historyIndex = tab.historyStack.length - 1;
      }
    }
    recordBrowsingHistory(tab);
  } catch (err) {
    tab.error = err instanceof Error ? err.message : String(err);
  } finally {
    tab.loading = false;
  }

  return buildTabSnapshot(tab);
}

export async function goBackBrowserTab(tabId: string): Promise<BrowserTabSnapshot> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');
  if (tab.historyIndex <= 0) return buildTabSnapshot(tab);
  tab.historyIndex -= 1;
  const target = tab.historyStack[tab.historyIndex];
  return navigateBrowserTab(tabId, target, { historyMode: 'none', allowLocalTestServer: true });
}

export async function goForwardBrowserTab(tabId: string): Promise<BrowserTabSnapshot> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');
  if (tab.historyIndex >= tab.historyStack.length - 1) return buildTabSnapshot(tab);
  tab.historyIndex += 1;
  const target = tab.historyStack[tab.historyIndex];
  return navigateBrowserTab(tabId, target, { historyMode: 'none', allowLocalTestServer: true });
}

export async function reloadBrowserTab(tabId: string): Promise<BrowserTabSnapshot> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');
  if (tab.url === 'pt://home') {
    await tab.pwPage.setContent(renderHomePageHtml(), { waitUntil: 'domcontentloaded' });
    return buildTabSnapshot(tab);
  }
  const response = await tab.pwPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
  tab.httpStatus = response ? response.status() : tab.httpStatus;
  await tab.pwPage.waitForTimeout(350);
  return buildTabSnapshot(tab);
}

export async function interactWithBrowserTab(
  tabId: string,
  action:
    | { type: 'click'; x: number; y: number }
    | { type: 'scroll'; deltaY: number }
    | { type: 'type'; text: string; pressEnter?: boolean }
): Promise<BrowserTabSnapshot> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');

  const prevUrl = tab.pwPage.url();
  if (action.type === 'click') {
    const cx = Math.max(0, Math.min(VIEWPORT_WIDTH - 1, Math.round(action.x)));
    const cy = Math.max(0, Math.min(VIEWPORT_HEIGHT - 1, Math.round(action.y)));
    await tab.pwPage.mouse.click(cx, cy);
    await tab.pwPage.waitForTimeout(450);
  } else if (action.type === 'scroll') {
    await tab.pwPage.evaluate((dy) => {
      window.scrollBy({ top: dy, behavior: 'instant' as ScrollBehavior });
    }, action.deltaY);
    await tab.pwPage.waitForTimeout(350);
  } else if (action.type === 'type') {
    await tab.pwPage.keyboard.type(action.text, { delay: 15 });
    if (action.pressEnter) {
      await tab.pwPage.keyboard.press('Enter');
    }
    await tab.pwPage.waitForTimeout(450);
  }

  const nextUrl = tab.pwPage.url();
  if (nextUrl && nextUrl !== prevUrl && !nextUrl.startsWith('about:')) {
    tab.url = nextUrl;
    tab.historyStack = tab.historyStack.slice(0, tab.historyIndex + 1);
    tab.historyStack.push(nextUrl);
    tab.historyIndex = tab.historyStack.length - 1;
    recordBrowsingHistory(tab);
  }

  return buildTabSnapshot(tab);
}

/**
 * Discovers high-resolution comic pages from the live Chromium DOM, cached browser network
 * responses, and <canvas> elements — optionally performing natural scroll to trigger lazy-loading,
 * with full-resolution preservation and SHA-256 deduplication.
 */
export async function collectTabComicImages(
  tabId: string,
  opts?: { autoScrollLazy?: boolean }
): Promise<{
  snapshot: BrowserTabSnapshot;
  images: BrowserDiscoveredImage[];
  blockedByProtection: boolean;
}> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');

  const protection = await detectProtectionState(tab);
  if (protection.status === 'http_403_blocked') {
    return {
      snapshot: await buildTabSnapshot(tab),
      images: [],
      blockedByProtection: true,
    };
  }

  if (opts?.autoScrollLazy) {
    let lastScrollY = -1;
    for (let step = 0; step < 14; step++) {
      const info = await tab.pwPage.evaluate(() => {
        window.scrollBy(0, 640);
        return {
          y: window.scrollY,
          maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        };
      });
      await tab.pwPage.waitForTimeout(320);
      if (info.y >= info.maxY || info.y === lastScrollY) break;
      lastScrollY = info.y;
    }
  }

  // Extract rendered DOM images & canvas frames in exact vertical/reading sequence
  const domCandidates = await tab.pwPage.evaluate(() => {
    const items: Array<{
      url: string;
      width: number;
      height: number;
      top: number;
      left: number;
      kind: 'dom_image' | 'canvas_capture';
      inlineDataUrl?: string;
    }> = [];

    for (const img of Array.from(document.querySelectorAll('img'))) {
      const w = img.naturalWidth || img.clientWidth;
      const h = img.naturalHeight || img.clientHeight;
      if (w < 180 || h < 180) continue;
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (!src) continue;
      const rect = img.getBoundingClientRect();

      let inlineDataUrl: string | undefined;
      if (src.startsWith('data:image/')) {
        inlineDataUrl = src;
      } else {
        try {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const cctx = c.getContext('2d');
          if (cctx) {
            cctx.drawImage(img, 0, 0, w, h);
            inlineDataUrl = c.toDataURL('image/png');
          }
        } catch {
          // Cross-origin tainted canvas: resolved from Playwright networkImages cache
        }
      }

      items.push({
        url: src,
        width: w,
        height: h,
        top: rect.top + window.scrollY,
        left: rect.left,
        kind: 'dom_image',
        inlineDataUrl,
      });
    }

    for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
      if (canvas.width < 200 || canvas.height < 200) continue;
      const rect = canvas.getBoundingClientRect();
      try {
        const dataUrl = canvas.toDataURL('image/png');
        items.push({
          url: `canvas://${items.length + 1}`,
          width: canvas.width,
          height: canvas.height,
          top: rect.top + window.scrollY,
          left: rect.left,
          kind: 'canvas_capture',
          inlineDataUrl: dataUrl,
        });
      } catch {
        // Ignore tainted canvas
      }
    }

    items.sort((a, b) => (Math.abs(a.top - b.top) > 40 ? a.top - b.top : a.left - b.left));
    return items;
  });

  const collected: BrowserDiscoveredImage[] = [];
  const seenHashes = new Map<string, number>();

  for (const cand of domCandidates) {
    let dataUrl = cand.inlineDataUrl || '';
    let mimeType = 'image/png';
    let byteSize = 0;
    let sha256 = '';
    let captureSource: BrowserDiscoveredImage['captureSource'] = cand.kind;

    const cached = tab.networkImages.get(cand.url);
    if (cached) {
      mimeType = cached.mimeType;
      byteSize = cached.buffer.length;
      sha256 = cached.sha256;
      dataUrl = `data:${mimeType};base64,${cached.buffer.toString('base64')}`;
      captureSource = 'network_cache';
    } else if (dataUrl) {
      try {
        const validated = validateAndDecodeImageDataUrl(dataUrl);
        mimeType = validated.mime;
        byteSize = validated.buffer.length;
        sha256 = validated.sha256;
        dataUrl = validated.dataUrl;
      } catch {
        continue;
      }
    } else {
      continue;
    }

    const existingIdx = seenHashes.get(sha256);
    const isDuplicate = existingIdx !== undefined;
    const idx = collected.length + 1;
    if (!isDuplicate) seenHashes.set(sha256, idx);

    collected.push({
      id: `bimg-${crypto.randomBytes(4).toString('hex')}`,
      index: idx,
      url: cand.url,
      dataUrl,
      width: cand.width,
      height: cand.height,
      mimeType,
      byteSize,
      sha256,
      captureSource,
      isDuplicate,
      duplicateOfIndex: existingIdx,
      selected: !isDuplicate,
    });
  }

  tab.lastCollectedImages = collected;
  return {
    snapshot: await buildTabSnapshot(tab),
    images: collected,
    blockedByProtection: false,
  };
}

export async function captureTabScreenshotAsPage(
  tabId: string,
  mode: 'visible' | 'full_page' = 'visible'
): Promise<BrowserDiscoveredImage> {
  const tab = activeTabs.get(tabId);
  if (!tab) throw new Error('علامة التبويب غير موجودة.');

  const buf = await tab.pwPage.screenshot({
    type: 'png',
    fullPage: mode === 'full_page',
  });
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dims = await tab.pwPage.evaluate(
    (isFull) => ({
      w: document.documentElement.clientWidth || 1120,
      h: isFull ? document.documentElement.scrollHeight || 760 : document.documentElement.clientHeight || 760,
    }),
    mode === 'full_page'
  );

  const item: BrowserDiscoveredImage = {
    id: `bshot-${crypto.randomBytes(4).toString('hex')}`,
    index: tab.lastCollectedImages.length + 1,
    url: tab.url,
    dataUrl: `data:image/png;base64,${buf.toString('base64')}`,
    width: dims.w,
    height: dims.h,
    mimeType: 'image/png',
    byteSize: buf.length,
    sha256,
    captureSource: 'screenshot_fallback',
    isDuplicate: tab.lastCollectedImages.some((img) => img.sha256 === sha256),
    selected: true,
  };
  tab.lastCollectedImages.push(item);
  return item;
}

/**
 * Direct handoff from Internal Browser -> Studio Translator pipeline.
 * NEVER routes back through source_fetch; stores decoded full-resolution images locally
 * and creates a Chapter ready for OCR -> Bubble Detection -> EN->AR Translation.
 */
export function importBrowserImagesToStudio(opts: {
  projectId?: string;
  newProjectConfig?: {
    title: string;
    comicFormat: ComicFormat;
    sourceLanguage: string;
    targetLanguage: string;
    readingDirection: ReadingDirection;
    translationStyle: TranslationStyle;
  };
  chapterTitle: string;
  sourceUrl?: string;
  pages: Array<{ dataUrl: string; width: number; height: number }>;
}): { projectId: string; chapter: Chapter; pages: Page[] } {
  if (!Array.isArray(opts.pages) || opts.pages.length === 0) {
    throw new Error('يرجى اختيار صفحة واحدة على الأقل قبل الإرسال للترجمة.');
  }

  const db = getDb();
  const now = new Date().toISOString();
  let targetProject = opts.projectId
    ? db.projects.find((p) => p.id === opts.projectId)
    : undefined;

  if (!targetProject) {
    const cfg = opts.newProjectConfig;
    if (!cfg || !cfg.title?.trim()) {
      throw new Error('يرجى تحديد مشروع قائم أو إدخال اسم مشروع جديد.');
    }
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
  }

  const chapterNum = db.chapters.filter((c) => c.projectId === targetProject!.id).length + 1;
  const chapter: Chapter = {
    id: `ch-${crypto.randomBytes(4).toString('hex')}`,
    projectId: targetProject.id,
    title: (opts.chapterTitle || `Issue #${chapterNum}`).trim(),
    chapterNumber: chapterNum,
    pageCount: opts.pages.length,
    status: 'draft',
    lastReadPage: 1,
    sourceUrl: opts.sourceUrl,
    createdAt: now,
    updatedAt: now,
  };

  const createdPages: Page[] = opts.pages.map((p, idx) => {
    const validated = validateAndDecodeImageDataUrl(p.dataUrl);
    const saved = saveBase64Asset(validated.dataUrl, `browser_import_p${idx + 1}`);
    return {
      id: `pg-${crypto.randomBytes(4).toString('hex')}`,
      chapterId: chapter.id,
      pageNumber: idx + 1,
      originalImage: saved.url,
      status: 'pending',
      width: p.width > 0 ? Math.round(p.width) : 900,
      height: p.height > 0 ? Math.round(p.height) : 1200,
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
    'CHAPTER_INTERNAL_BROWSER_IMPORTED',
    `Imported ${createdPages.length} page(s) directly from internal Browser into "${chapter.title}" (no source_fetch)`,
    { projectId: targetProject.id, chapterId: chapter.id }
  );

  return { projectId: targetProject.id, chapter, pages: createdPages };
}

export function getBrowserWorkspaceState(): PersistedBrowserState {
  return loadPersistedBrowserState();
}

export async function updateBrowserPrivacySettings(opts: {
  privacyMode?: BrowserPrivacyMode;
  homeUrl?: string;
  clearHistory?: boolean;
  clearSessionCookies?: boolean;
}): Promise<PersistedBrowserState> {
  const state = loadPersistedBrowserState();
  if (opts.privacyMode) state.privacyMode = opts.privacyMode;
  if (opts.homeUrl !== undefined) {
    state.homeUrl = validateBrowserUrl(opts.homeUrl);
  }
  if (opts.clearHistory) {
    state.history = [];
  }
  if (opts.clearSessionCookies) {
    if (standardContext) {
      await standardContext.clearCookies().catch(() => undefined);
    }
    if (incognitoContext) {
      await incognitoContext.close().catch(() => undefined);
      incognitoContext = null;
    }
  }
  savePersistedBrowserState();
  return state;
}

export function addBrowserBookmark(title: string, url: string): BrowserBookmark[] {
  const state = loadPersistedBrowserState();
  const safeUrl = validateBrowserUrl(url);
  if (!state.bookmarks.some((b) => b.url === safeUrl)) {
    state.bookmarks.unshift({
      id: `bm-${crypto.randomBytes(4).toString('hex')}`,
      title: (title || safeUrl).trim(),
      url: safeUrl,
      createdAt: new Date().toISOString(),
    });
    savePersistedBrowserState();
  }
  return state.bookmarks;
}

export function removeBrowserBookmark(id: string): BrowserBookmark[] {
  const state = loadPersistedBrowserState();
  state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
  savePersistedBrowserState();
  return state.bookmarks;
}

export async function shutdownBrowserEngine(): Promise<void> {
  for (const tab of activeTabs.values()) {
    await tab.pwPage.close().catch(() => undefined);
  }
  activeTabs.clear();
  if (incognitoContext) {
    await incognitoContext.close().catch(() => undefined);
    incognitoContext = null;
  }
  if (standardContext) {
    await standardContext.close().catch(() => undefined);
    standardContext = null;
  }
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => undefined);
    sharedBrowser = null;
  }
}
