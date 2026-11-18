import type { FailureCategory, RedirectHop } from './types.ts';

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^169\.254\./,
];

export function validatePublicChapterUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('الرابط غير صالح. تأكد من إدخال رابط يبدأ بـ http:// أو https://');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('يُسمح فقط بروابط HTTP أو HTTPS.');
  }

  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) {
    throw new Error('لا يمكن الوصول إلى عناوين الشبكة المحلية لأسباب أمنية.');
  }

  return parsed;
}

export interface HttpResponseRecord {
  status: number;
  ok: boolean;
  finalUrl: string;
  headers: Record<string, string>;
  bodyText: string;
  redirectChain: RedirectHop[];
  cookiesCount: number;
}

/**
 * HTTP client with an isolated per-import Cookie Jar, manual redirect tracking,
 * proper HTTP content-negotiation headers, and Referer/Origin propagation.
 */
export class SessionHttpClient {
  private cookies = new Map<string, string>();
  private allowPrivateHosts: boolean;

  constructor(initialCookieHeader?: string, opts?: { allowPrivateHosts?: boolean }) {
    this.allowPrivateHosts = Boolean(opts?.allowPrivateHosts);
    if (initialCookieHeader) {
      this.ingestRawCookieHeader(initialCookieHeader);
    }
  }

  private parseUrlSafely(rawUrl: string): URL {
    if (!this.allowPrivateHosts) {
      return validatePublicChapterUrl(rawUrl);
    }
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP/HTTPS allowed.');
    }
    return parsed;
  }

  private ingestRawCookieHeader(raw: string): void {
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) this.cookies.set(k, v);
      }
    }
  }

  private captureSetCookies(res: Response): void {
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const rawCookies: string[] =
      typeof getSetCookie === 'function'
        ? getSetCookie.call(res.headers)
        : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')!]
        : [];

    for (const cookieStr of rawCookies) {
      const firstPair = cookieStr.split(';')[0];
      const eq = firstPair.indexOf('=');
      if (eq > 0) {
        const name = firstPair.slice(0, eq).trim();
        const val = firstPair.slice(eq + 1).trim();
        if (name) this.cookies.set(name, val);
      }
    }
  }

  public getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  public getCookiesCount(): number {
    return this.cookies.size;
  }

  private buildHeaders(
    kind: 'html' | 'json' | 'api' | 'image',
    targetUrl: URL,
    referer?: string
  ): Record<string, string> {
    if (kind === 'api') {
      const apiHeaders: Record<string, string> = {
        'User-Agent': 'PanelTranslateAI/1.0 (Compatible Manga Reader)',
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8,ja;q=0.7',
      };
      if (referer) {
        apiHeaders.Referer = referer;
      }
      const cookieStr = this.getCookieHeader();
      if (cookieStr) {
        apiHeaders.Cookie = cookieStr;
      }
      return apiHeaders;
    }

    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8,ja;q=0.7',
    };

    if (kind === 'html') {
      headers.Accept =
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
      headers['Upgrade-Insecure-Requests'] = '1';
      headers['Sec-Fetch-Dest'] = 'document';
      headers['Sec-Fetch-Mode'] = 'navigate';
      headers['Sec-Fetch-Site'] = referer ? 'same-origin' : 'none';
    } else if (kind === 'json') {
      headers.Accept = 'application/json,text/plain,*/*';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Mode'] = 'cors';
    } else {
      headers.Accept = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
      headers['Sec-Fetch-Dest'] = 'image';
      headers['Sec-Fetch-Mode'] = 'no-cors';
      headers['Sec-Fetch-Site'] = 'cross-site';
    }

    if (referer) {
      headers.Referer = referer;
      try {
        headers.Origin = new URL(referer).origin;
      } catch {
        // Ignore invalid referer origin
      }
    } else {
      headers.Referer = targetUrl.origin + '/';
    }

    const cookieStr = this.getCookieHeader();
    if (cookieStr) {
      headers.Cookie = cookieStr;
    }

    return headers;
  }

  public async requestText(
    url: string,
    opts: { kind?: 'html' | 'json' | 'api'; referer?: string; timeoutMs?: number } = {}
  ): Promise<HttpResponseRecord> {
    const kind = opts.kind || 'html';
    const timeoutMs = opts.timeoutMs || 12000;
    const redirectChain: RedirectHop[] = [];
    let currentUrl = this.parseUrlSafely(url);

    for (let hop = 0; hop < 8; hop++) {
      const headers = this.buildHeaders(kind, currentUrl, opts.referer);
      const res = await fetch(currentUrl.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });

      this.captureSetCookies(res);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        redirectChain.push({
          url: currentUrl.toString(),
          status: res.status,
          location: location || undefined,
        });
        if (!location) break;
        currentUrl = this.parseUrlSafely(new URL(location, currentUrl.toString()).toString());
        continue;
      }

      const headersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });

      const bodyText = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        finalUrl: currentUrl.toString(),
        headers: headersObj,
        bodyText,
        redirectChain,
        cookiesCount: this.cookies.size,
      };
    }

    throw new Error('تجاوزت طلبات إعادة التوجيه الحد المسموح (8 قفزات).');
  }

  public async requestBinary(
    url: string,
    opts: { referer?: string; timeoutMs?: number } = {}
  ): Promise<{
    status: number;
    ok: boolean;
    contentType: string;
    buffer: Buffer;
    headers: Record<string, string>;
    finalUrl: string;
  }> {
    let currentUrl = this.parseUrlSafely(url);
    for (let hop = 0; hop < 6; hop++) {
      const headers = this.buildHeaders('image', currentUrl, opts.referer);
      const res = await fetch(currentUrl.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs || 12000),
      });

      this.captureSetCookies(res);

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        currentUrl = this.parseUrlSafely(new URL(loc, currentUrl.toString()).toString());
        continue;
      }

      const headersObj: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
      const arrayBuf = await res.arrayBuffer();
      return {
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        buffer: Buffer.from(arrayBuf),
        headers: headersObj,
        finalUrl: currentUrl.toString(),
      };
    }

    throw new Error('Too many redirects while fetching CDN image');
  }
}

export function classifyHttpFailure(
  status: number,
  headers: Record<string, string>,
  bodyText: string,
  targetKind: 'page' | 'cdn_image'
): { category: FailureCategory; explanation: string } {
  const serverHdr = (headers['server'] || '').toLowerCase();
  const viaHdr = (headers['via'] || '').toLowerCase();
  const xCache = (headers['x-cache'] || '').toLowerCase();
  const cfMitigated = (headers['cf-mitigated'] || '').toLowerCase();
  const wafAction = (headers['x-amzn-waf-action'] || '').toLowerCase();
  const bodyLower = bodyText.slice(0, 8000).toLowerCase();

  if (status === 429) {
    const retryAfter = headers['retry-after'] ? ` (Retry-After: ${headers['retry-after']}s)` : '';
    return {
      category: 'RATE_LIMITED',
      explanation: `المصدر فرض تحديد معدل الطلبات HTTP 429${retryAfter}. انتظر قليلاً ثم أعد المحاولة.`,
    };
  }

  if (
    cfMitigated.includes('challenge') ||
    wafAction.includes('captcha') ||
    bodyLower.includes('cf-turnstile') ||
    bodyLower.includes('just a moment...') ||
    bodyLower.includes('bot challenge') ||
    bodyLower.includes('g-recaptcha') ||
    bodyLower.includes('hcaptcha')
  ) {
    return {
      category: 'WAF_OR_CAPTCHA',
      explanation: `الخادم يفرض تحدي حماية/CAPTCHA (${serverHdr || 'WAF'}). لا يتجاوز التطبيق اختبارات CAPTCHA أو جدران الحماية. افتح الفصل في متصفحك واحفظ الصور أو ملف CBZ لرفعه مباشرة.`,
    };
  }

  if (
    status === 401 ||
    headers['www-authenticate'] ||
    bodyLower.includes('sign in to continue') ||
    bodyLower.includes('login required') ||
    bodyLower.includes('subscription required')
  ) {
    return {
      category: 'AUTH_REQUIRED',
      explanation: `المصدر يتطلب تسجيل دخول أو اشتراكاً مصرحاً به (HTTP ${status}). إذا كان لديك جلسة مصرح بها يمكنك تمرير Cookie المصرح في الخيارات المتقدمة أو رفع الصور يدوياً.`,
    };
  }

  if (status === 403) {
    if (targetKind === 'cdn_image') {
      return {
        category: 'HOTLINK_REFERER_BLOCK',
        explanation:
          'خادم الصور (CDN) رفض الطلب برمز HTTP 403 بسبب قيود Hotlink Protection / Referer أو توقيع رابط منتهي الصلاحية.',
      };
    }

    if (
      serverHdr.includes('cloudflare') ||
      serverHdr.includes('cloudfront') ||
      viaHdr.includes('cloudfront') ||
      xCache.includes('cloudfront')
    ) {
      return {
        category: 'IP_OR_GEO_BLOCK',
        explanation: `جدار حماية CDN (${serverHdr || 'CloudFront'}) حظر عنوان IP الخاص بالخادم برمز HTTP 403 (حظر استضافات السحابة أو تقييد جغرافي).`,
      };
    }

    return {
      category: 'HTTP_ERROR',
      explanation: `الخادم أعاد HTTP 403 Forbidden (${serverHdr || 'Origin'}). قد يتطلب جلسة متصفح صالحة أو يحظر الوصول من خوادم السحابة.`,
    };
  }

  return {
    category: 'HTTP_ERROR',
    explanation: `فشل الطلب من المصدر برمز HTTP ${status}.`,
  };
}
