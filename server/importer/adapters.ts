import * as cheerio from 'cheerio';
import {
  classifyHttpFailure,
  SessionHttpClient,
  validatePublicChapterUrl,
} from './httpSession.ts';
import { renderPageDomWithChromium } from './jsRenderer.ts';
import {
  ImporterDiagnosticError,
  type DiscoveredRemoteImage,
  type ImportStageTrace,
  type UrlInspectionResult,
} from './types.ts';

export interface SiteAdapterContext {
  url: URL;
  client: SessionHttpClient;
  diagnostics: ImportStageTrace[];
  warnings: string[];
}

export interface SiteAdapter {
  id: string;
  name: string;
  matches: (url: URL) => boolean;
  extract: (ctx: SiteAdapterContext) => Promise<UrlInspectionResult>;
}

function cleanAndDedupeImageUrls(
  rawCandidates: Array<{ url: string; alt?: string }>,
  baseUrl: string,
  referer: string
): DiscoveredRemoteImage[] {
  const seen = new Set<string>();
  const out: DiscoveredRemoteImage[] = [];

  for (const item of rawCandidates) {
    const raw = (item.url || '').trim();
    if (!raw || raw.startsWith('data:image/svg')) continue;
    let absUrl: string;
    try {
      absUrl = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }

    const lower = absUrl.toLowerCase();
    if (
      lower.includes('favicon') ||
      lower.includes('/logo') ||
      lower.includes('logo.') ||
      lower.includes('avatar') ||
      lower.includes('spinner') ||
      lower.includes('loader') ||
      lower.includes('ads/') ||
      lower.endsWith('.svg') ||
      lower.endsWith('.gif')
    ) {
      continue;
    }

    if (!seen.has(absUrl)) {
      seen.add(absUrl);
      out.push({
        index: out.length + 1,
        url: absUrl,
        alt: item.alt?.trim() || `Page ${out.length + 1}`,
        selected: true,
        referer,
      });
    }
  }
  return out;
}

/**
 * 1. MangaDex Official Public REST API Adapter
 * Avoids scraping the Nuxt SPA shell by calling api.mangadex.org directly.
 */
const MangaDexAdapter: SiteAdapter = {
  id: 'mangadex_api',
  name: 'MangaDex Official API',
  matches: (url) =>
    /(^|\.)mangadex\.org$/i.test(url.hostname) && /\/chapter\/([0-9a-f-]{36})/i.test(url.pathname),
  extract: async ({ url, client, diagnostics, warnings }) => {
    const match = url.pathname.match(/\/chapter\/([0-9a-f-]{36})/i);
    const chapterId = match![1];

    const t0 = Date.now();
    const metaResp = await client.requestText(`https://api.mangadex.org/chapter/${chapterId}`, {
      kind: 'api',
    });
    if (!metaResp.ok) {
      const cls = classifyHttpFailure(metaResp.status, metaResp.headers, metaResp.bodyText, 'page');
      diagnostics.push({
        stage: 'source_fetch',
        status: 'failed',
        httpStatus: metaResp.status,
        latencyMs: Date.now() - t0,
        detail: cls.explanation,
      });
      throw new ImporterDiagnosticError({
        message: cls.explanation,
        category: cls.category,
        stage: 'source_fetch',
        httpStatus: metaResp.status,
        diagnostics,
      });
    }

    const metaJson = JSON.parse(metaResp.bodyText) as {
      data?: {
        attributes?: {
          chapter?: string;
          title?: string;
          externalUrl?: string | null;
        };
      };
    };

    const attrs = metaJson.data?.attributes;
    if (attrs?.externalUrl) {
      diagnostics.push({
        stage: 'source_fetch',
        status: 'failed',
        httpStatus: 200,
        detail: `External licensed chapter URL: ${attrs.externalUrl}`,
      });
      throw new ImporterDiagnosticError({
        message: `هذا الفصل في MangaDex مرتبط بمنصة ناشر خارجية مرخصة (${attrs.externalUrl}) ولا يستضيف صوره على MangaDex.`,
        category: 'EXTERNAL_LICENSED_HOST',
        stage: 'source_fetch',
        httpStatus: 200,
        diagnostics,
      });
    }

    const atHomeResp = await client.requestText(
      `https://api.mangadex.org/at-home/server/${chapterId}`,
      { kind: 'api' }
    );
    if (!atHomeResp.ok) {
      const cls = classifyHttpFailure(
        atHomeResp.status,
        atHomeResp.headers,
        atHomeResp.bodyText,
        'page'
      );
      diagnostics.push({
        stage: 'source_fetch',
        status: 'failed',
        httpStatus: atHomeResp.status,
        detail: cls.explanation,
      });
      throw new ImporterDiagnosticError({
        message: cls.explanation,
        category: cls.category,
        stage: 'source_fetch',
        httpStatus: atHomeResp.status,
        diagnostics,
      });
    }

    const atHomeJson = JSON.parse(atHomeResp.bodyText) as {
      baseUrl: string;
      chapter: { hash: string; data: string[]; dataSaver: string[] };
    };

    const files = atHomeJson.chapter?.data?.length
      ? atHomeJson.chapter.data
      : atHomeJson.chapter?.dataSaver || [];
    const qualityFolder = atHomeJson.chapter?.data?.length ? 'data' : 'data-saver';

    const images: DiscoveredRemoteImage[] = files.map((filename, idx) => ({
      index: idx + 1,
      url: `${atHomeJson.baseUrl}/${qualityFolder}/${atHomeJson.chapter.hash}/${filename}`,
      alt: `Page ${idx + 1}`,
      selected: true,
      referer: 'https://mangadex.org/',
    }));

    diagnostics.push({
      stage: 'source_fetch',
      status: 'ok',
      httpStatus: 200,
      latencyMs: Date.now() - t0,
      detail: `Fetched ${images.length} official pages from MangaDex At-Home API`,
    });

    const titleParts = [
      attrs?.chapter ? `Ch. ${attrs.chapter}` : '',
      attrs?.title || '',
    ].filter(Boolean);

    return {
      adapterId: 'mangadex_api',
      adapterName: 'MangaDex Official API',
      sourceMethod: 'official_api',
      pageTitle: titleParts.join(' — ') || `MangaDex ${chapterId.slice(0, 8)}`,
      sourceUrl: url.toString(),
      finalUrl: url.toString(),
      requiredReferer: 'https://mangadex.org/',
      redirectChain: [],
      cookiesCaptured: client.getCookiesCount(),
      images,
      diagnostics,
      warnings,
    };
  },
};

/**
 * 2. LINE Webtoon Adapter
 * Solves webtoon-phinf.pstatic.net HTTP 403 hotlink protection by extracting data-url
 * from #_imageList and enforcing Referer: https://www.webtoons.com/.
 */
const WebtoonsAdapter: SiteAdapter = {
  id: 'webtoons_viewer',
  name: 'LINE Webtoon Viewer',
  matches: (url) => /(^|\.)webtoons\.com$/i.test(url.hostname),
  extract: async ({ url, client, diagnostics, warnings }) => {
    const t0 = Date.now();
    const res = await client.requestText(url.toString(), {
      kind: 'html',
      referer: 'https://www.webtoons.com/',
    });

    if (res.redirectChain.length > 0) {
      diagnostics.push({
        stage: 'redirect_and_cookies',
        status: 'ok',
        detail: `Followed ${res.redirectChain.length} redirects, captured ${res.cookiesCount} cookies`,
      });
    }

    if (!res.ok) {
      const cls = classifyHttpFailure(res.status, res.headers, res.bodyText, 'page');
      diagnostics.push({
        stage: 'source_fetch',
        status: 'failed',
        httpStatus: res.status,
        latencyMs: Date.now() - t0,
        detail: cls.explanation,
      });
      throw new ImporterDiagnosticError({
        message: cls.explanation,
        category: cls.category,
        stage: 'source_fetch',
        httpStatus: res.status,
        diagnostics,
        redirectChain: res.redirectChain,
      });
    }

    const $ = cheerio.load(res.bodyText);
    const pageTitle = $('title').first().text().trim() || 'Webtoon Episode';
    const rawImgs: Array<{ url: string; alt?: string }> = [];

    $('#_imageList img').each((_, el) => {
      const src = $(el).attr('data-url') || $(el).attr('data-src') || $(el).attr('src');
      if (src) rawImgs.push({ url: src, alt: $(el).attr('alt') });
    });

    if (rawImgs.length === 0) {
      $('img._images').each((_, el) => {
        const src = $(el).attr('data-url') || $(el).attr('src');
        if (src) rawImgs.push({ url: src, alt: $(el).attr('alt') });
      });
    }

    const requiredReferer = 'https://www.webtoons.com/';
    const images = cleanAndDedupeImageUrls(rawImgs, res.finalUrl, requiredReferer);

    diagnostics.push({
      stage: 'image_extraction',
      status: images.length > 0 ? 'ok' : 'failed',
      httpStatus: res.status,
      latencyMs: Date.now() - t0,
      detail: `Extracted ${images.length} Webtoon CDN images (Referer enforced: ${requiredReferer})`,
    });

    if (images.length === 0) {
      throw new ImporterDiagnosticError({
        message: 'لم يتم العثور على صور الحلقة في #_imageList.',
        category: 'NO_IMAGES_FOUND',
        stage: 'image_extraction',
        httpStatus: res.status,
        diagnostics,
      });
    }

    return {
      adapterId: 'webtoons_viewer',
      adapterName: 'LINE Webtoon Viewer',
      sourceMethod: 'html_parser',
      pageTitle,
      sourceUrl: url.toString(),
      finalUrl: res.finalUrl,
      requiredReferer,
      redirectChain: res.redirectChain,
      cookiesCaptured: res.cookiesCount,
      images,
      diagnostics,
      warnings,
    };
  },
};

/**
 * 3. Cubari.moe JSON API Adapter (Gist / Imgur / Reddit proxies)
 */
const CubariAdapter: SiteAdapter = {
  id: 'cubari_api',
  name: 'Cubari Reader API',
  matches: (url) => /(^|\.)cubari\.moe$/i.test(url.hostname) && url.pathname.includes('/read/'),
  extract: async ({ url, client, diagnostics, warnings }) => {
    const parts = url.pathname.split('/').filter(Boolean);
    // /read/<source>/<slug>/<chapter?>
    const source = parts[1];
    const slug = parts[2];
    const chKey = parts[3];

    if (!source || !slug) {
      throw new ImporterDiagnosticError({
        message: 'رابط Cubari غير مكتمل.',
        category: 'INVALID_URL',
        stage: 'adapter_selection',
        diagnostics,
      });
    }

    const apiEndpoint = `https://cubari.moe/read/api/${source}/series/${slug}/`;
    const res = await client.requestText(apiEndpoint, {
      kind: 'api',
      referer: 'https://cubari.moe/',
    });

    if (!res.ok) {
      const cls = classifyHttpFailure(res.status, res.headers, res.bodyText, 'page');
      throw new ImporterDiagnosticError({
        message: cls.explanation,
        category: cls.category,
        stage: 'source_fetch',
        httpStatus: res.status,
        diagnostics,
      });
    }

    const data = JSON.parse(res.bodyText) as {
      title?: string;
      chapters?: Record<
        string,
        { title?: string; groups?: Record<string, Array<string | { src: string }>> }
      >;
    };

    const chaptersObj = data.chapters || {};
    const selectedKey = chKey && chaptersObj[chKey] ? chKey : Object.keys(chaptersObj)[0];
    const ch = selectedKey ? chaptersObj[selectedKey] : undefined;
    const firstGroup = ch?.groups ? Object.values(ch.groups)[0] || [] : [];
    const urls = firstGroup
      .map((item) => (typeof item === 'string' ? item : item?.src))
      .filter((u): u is string => Boolean(u));

    const images = cleanAndDedupeImageUrls(
      urls.map((u) => ({ url: u })),
      url.toString(),
      'https://cubari.moe/'
    );

    diagnostics.push({
      stage: 'source_fetch',
      status: 'ok',
      httpStatus: 200,
      detail: `Fetched ${images.length} pages via Cubari JSON API`,
    });

    return {
      adapterId: 'cubari_api',
      adapterName: 'Cubari Reader API',
      sourceMethod: 'official_api',
      pageTitle: ch?.title || data.title || 'Cubari Chapter',
      sourceUrl: url.toString(),
      finalUrl: url.toString(),
      requiredReferer: 'https://cubari.moe/',
      redirectChain: [],
      cookiesCaptured: client.getCookiesCount(),
      images,
      diagnostics,
      warnings,
    };
  },
};

/**
 * 4. Generic Adaptive HTML + Embedded JSON (Themesia ts_reader / Next.js __NEXT_DATA__ / Madara) + JS-Rendered DOM Fallback
 */
const GenericSmartAdapter: SiteAdapter = {
  id: 'smart_html_js',
  name: 'Smart HTML / CMS / JS-DOM Extractor',
  matches: () => true,
  extract: async ({ url, client, diagnostics, warnings }) => {
    const t0 = Date.now();
    const res = await client.requestText(url.toString(), {
      kind: 'html',
      referer: url.origin + '/',
    });

    if (res.redirectChain.length > 0) {
      diagnostics.push({
        stage: 'redirect_and_cookies',
        status: 'ok',
        detail: `Followed ${res.redirectChain.length} redirect(s); cookies: ${res.cookiesCount}`,
      });
    }

    if (!res.ok) {
      const cls = classifyHttpFailure(res.status, res.headers, res.bodyText, 'page');
      diagnostics.push({
        stage: 'source_fetch',
        status: 'failed',
        httpStatus: res.status,
        latencyMs: Date.now() - t0,
        detail: cls.explanation,
      });
      throw new ImporterDiagnosticError({
        message: cls.explanation,
        category: cls.category,
        stage: 'source_fetch',
        httpStatus: res.status,
        diagnostics,
        redirectChain: res.redirectChain,
      });
    }

    const contentType = res.headers['content-type'] || '';
    if (contentType.startsWith('image/')) {
      diagnostics.push({
        stage: 'source_fetch',
        status: 'ok',
        httpStatus: res.status,
        detail: 'Direct image URL detected',
      });
      return {
        adapterId: 'direct_image',
        adapterName: 'Direct Image URL',
        sourceMethod: 'html_parser',
        pageTitle: url.pathname.split('/').pop() || 'Direct Image',
        sourceUrl: url.toString(),
        finalUrl: res.finalUrl,
        requiredReferer: url.origin + '/',
        redirectChain: res.redirectChain,
        cookiesCaptured: res.cookiesCount,
        images: [
          {
            index: 1,
            url: res.finalUrl,
            alt: 'Chapter Page 1',
            selected: true,
            referer: url.origin + '/',
          },
        ],
        diagnostics,
        warnings,
      };
    }

    const bodyLower = res.bodyText.slice(0, 6000).toLowerCase();
    if (
      bodyLower.includes('cf-turnstile') ||
      bodyLower.includes('just a moment...') ||
      bodyLower.includes('g-recaptcha')
    ) {
      const msg =
        'الصفحة تعرض تحدي CAPTCHA أو حماية Cloudflare Turnstile. لا يتجاوز التطبيق أنظمة الحماية؛ يرجى تنزيل الصور من متصفحك ورفعها يدوياً.';
      diagnostics.push({ stage: 'source_fetch', status: 'failed', httpStatus: res.status, detail: msg });
      throw new ImporterDiagnosticError({
        message: msg,
        category: 'WAF_OR_CAPTCHA',
        stage: 'source_fetch',
        httpStatus: res.status,
        diagnostics,
      });
    }

    let html = res.bodyText;
    const $ = cheerio.load(html);
    let pageTitle = $('title').first().text().trim() || url.hostname;
    let sourceMethod: UrlInspectionResult['sourceMethod'] = 'html_parser';
    const rawCandidates: Array<{ url: string; alt?: string }> = [];

    // Strategy A: Embedded MangaStream / Themesia ts_reader.run(...) JSON
    const tsMatch = html.match(/ts_reader\.run\(\s*(\{[\s\S]*?\})\s*\)/);
    if (tsMatch) {
      try {
        const parsedTs = JSON.parse(tsMatch[1]) as {
          sources?: Array<{ images?: string[] }>;
        };
        const tsImgs = parsedTs.sources?.[0]?.images || [];
        if (tsImgs.length > 0) {
          sourceMethod = 'embedded_json';
          for (const u of tsImgs) rawCandidates.push({ url: u });
          diagnostics.push({
            stage: 'image_extraction',
            status: 'ok',
            detail: `Extracted ${tsImgs.length} images from Themesia ts_reader JSON payload`,
          });
        }
      } catch {
        // Ignore malformed inline script
      }
    }

    // Strategy B: WordPress Madara / Reader containers first
    if (rawCandidates.length === 0) {
      const readerSelectors = [
        '.reading-content img',
        '#readerarea img',
        '.chapter-content img',
        '.container-chapter-reader img',
        '.viewer_img img',
        'img.wp-manga-chapter-img',
      ];
      for (const sel of readerSelectors) {
        $(sel).each((_, el) => {
          const src =
            $(el).attr('data-src') ||
            $(el).attr('data-lazy-src') ||
            $(el).attr('data-original') ||
            $(el).attr('data-url') ||
            $(el).attr('src');
          if (src) rawCandidates.push({ url: src, alt: $(el).attr('alt') });
        });
        if (rawCandidates.length > 0) break;
      }
    }

    // Strategy C: Generic HTML <img> & <source> tags
    if (rawCandidates.length === 0) {
      $('img').each((_, el) => {
        const src =
          $(el).attr('data-src') ||
          $(el).attr('data-original') ||
          $(el).attr('data-lazy-src') ||
          $(el).attr('data-url') ||
          $(el).attr('src');
        if (src) rawCandidates.push({ url: src, alt: $(el).attr('alt') });
      });
    }

    let images = cleanAndDedupeImageUrls(rawCandidates, res.finalUrl, res.finalUrl);

    // Strategy D: If static HTML returned 200 OK but 0 chapter images (e.g. SPA / JS-rendered page),
    // try controlled Headless Chromium DOM rendering
    if (images.length === 0) {
      diagnostics.push({
        stage: 'js_render',
        status: 'warn',
        detail: 'Static HTML yielded 0 images; attempting headless Chromium DOM hydration',
      });
      const rendered = await renderPageDomWithChromium(res.finalUrl);
      if (rendered) {
        if (rendered.hasCaptchaOrLogin) {
          throw new ImporterDiagnosticError({
            message: 'الصفحة الديناميكية تعرض تحدي CAPTCHA أو بوابة تحقق عند تشغيل المتصفح.',
            category: 'WAF_OR_CAPTCHA',
            stage: 'js_render',
            httpStatus: res.status,
            diagnostics,
          });
        }
        if (rendered.title) pageTitle = rendered.title;
        images = cleanAndDedupeImageUrls(
          rendered.imgUrls.map((u) => ({ url: u })),
          rendered.finalUrl,
          rendered.finalUrl
        );
        if (images.length > 0) {
          sourceMethod = 'js_rendered_dom';
          diagnostics.push({
            stage: 'js_render',
            status: 'ok',
            detail: `Headless Chromium rendered ${images.length} dynamic DOM image(s)`,
          });
        }
      } else {
        diagnostics.push({
          stage: 'js_render',
          status: 'skipped',
          detail: 'JS rendering produced no additional chapter images',
        });
      }
    } else {
      diagnostics.push({
        stage: 'image_extraction',
        status: 'ok',
        httpStatus: res.status,
        latencyMs: Date.now() - t0,
        detail: `Extracted ${images.length} images via ${sourceMethod}`,
      });
    }

    if (images.length === 0) {
      throw new ImporterDiagnosticError({
        message:
          'تم تحميل الصفحة بنجاح (HTTP 200) ولكن لم يتم العثور على صور فصل صالحة في HTML أو DOM الديناميكي.',
        category: 'NO_IMAGES_FOUND',
        stage: 'image_extraction',
        httpStatus: res.status,
        diagnostics,
        redirectChain: res.redirectChain,
      });
    }

    return {
      adapterId: sourceMethod === 'js_rendered_dom' ? 'js_dom_renderer' : 'smart_html',
      adapterName:
        sourceMethod === 'js_rendered_dom'
          ? 'JS-Rendered DOM Extractor'
          : sourceMethod === 'embedded_json'
          ? 'CMS Embedded JSON Extractor'
          : 'Smart HTML Extractor',
      sourceMethod,
      pageTitle,
      sourceUrl: url.toString(),
      finalUrl: res.finalUrl,
      requiredReferer: res.finalUrl,
      redirectChain: res.redirectChain,
      cookiesCaptured: res.cookiesCount,
      images,
      diagnostics,
      warnings,
    };
  },
};

const ADAPTER_REGISTRY: SiteAdapter[] = [
  MangaDexAdapter,
  WebtoonsAdapter,
  CubariAdapter,
  GenericSmartAdapter,
];

export function selectSiteAdapter(url: URL): SiteAdapter {
  for (const adapter of ADAPTER_REGISTRY) {
    if (adapter.matches(url)) return adapter;
  }
  return GenericSmartAdapter;
}

export async function runAdapterInspection(
  rawUrl: string,
  opts: { customCookie?: string } = {}
): Promise<UrlInspectionResult> {
  const diagnostics: ImportStageTrace[] = [];
  const warnings: string[] = [];

  let urlObj: URL;
  try {
    urlObj = validatePublicChapterUrl(rawUrl);
    diagnostics.push({
      stage: 'url_validation',
      status: 'ok',
      detail: `Validated public URL (${urlObj.hostname})`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push({ stage: 'url_validation', status: 'failed', detail: msg });
    throw new ImporterDiagnosticError({
      message: msg,
      category: 'INVALID_URL',
      stage: 'url_validation',
      diagnostics,
    });
  }

  const adapter = selectSiteAdapter(urlObj);
  diagnostics.push({
    stage: 'adapter_selection',
    status: 'ok',
    detail: `Selected adapter: ${adapter.name} (${adapter.id})`,
  });

  const client = new SessionHttpClient(opts.customCookie);
  let result: UrlInspectionResult;
  try {
    result = await adapter.extract({
      url: urlObj,
      client,
      diagnostics,
      warnings,
    });
  } catch (err) {
    if (err instanceof ImporterDiagnosticError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const isLocalhostBlock = msg.includes('الشبكة المحلية');
    diagnostics.push({
      stage: 'source_fetch',
      status: 'failed',
      detail: msg,
    });
    throw new ImporterDiagnosticError({
      message: isLocalhostBlock
        ? msg
        : `تعذر الاتصال بالخادم أو انتهت المهلة أثناء جلب المصدر: ${msg}`,
      category: isLocalhostBlock ? 'SSRF_BLOCKED' : 'NETWORK_OR_TIMEOUT',
      stage: 'source_fetch',
      diagnostics,
    });
  }

  // Probe the first extracted CDN image using the adapter's requiredReferer + cookies
  // so we verify CDN accessibility BEFORE returning success!
  if (result.images.length > 0) {
    const sampleUrl = result.images[0].url;
    const probeStart = Date.now();
    try {
      const probe = await client.requestBinary(sampleUrl, {
        referer: result.requiredReferer,
        timeoutMs: 8000,
      });
      if (!probe.ok) {
        const cls = classifyHttpFailure(
          probe.status,
          probe.headers,
          probe.buffer.toString('utf-8', 0, 1000),
          'cdn_image'
        );
        result.diagnostics.push({
          stage: 'cdn_probe',
          status: 'warn',
          httpStatus: probe.status,
          latencyMs: Date.now() - probeStart,
          detail: `Sample CDN check returned HTTP ${probe.status}: ${cls.explanation}`,
        });
        result.warnings.push(cls.explanation);
      } else {
        result.diagnostics.push({
          stage: 'cdn_probe',
          status: 'ok',
          httpStatus: probe.status,
          latencyMs: Date.now() - probeStart,
          detail: `Verified CDN image access (${probe.contentType}) with Referer ${result.requiredReferer}`,
        });
      }
    } catch (err) {
      result.diagnostics.push({
        stage: 'cdn_probe',
        status: 'warn',
        detail: `CDN probe warning: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return result;
}
