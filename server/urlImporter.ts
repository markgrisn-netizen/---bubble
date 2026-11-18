import { runAdapterInspection, selectSiteAdapter } from './importer/adapters.ts';
import {
  classifyHttpFailure,
  SessionHttpClient,
  validatePublicChapterUrl,
} from './importer/httpSession.ts';
import {
  ImporterDiagnosticError,
  type DiscoveredRemoteImage,
  type FailureCategory,
  type ImportStageTrace,
  type RedirectHop,
  type UrlInspectionResult,
} from './importer/types.ts';

export {
  classifyHttpFailure,
  ImporterDiagnosticError,
  selectSiteAdapter,
  SessionHttpClient,
  validatePublicChapterUrl,
};
export type {
  DiscoveredRemoteImage,
  FailureCategory,
  ImportStageTrace,
  RedirectHop,
  UrlInspectionResult,
};

/**
 * Inspects a publicly accessible chapter URL using automatic site adapter recognition,
 * session cookie jar, manual redirect tracing, official APIs, and JS-rendered DOM fallback.
 * Respects access restrictions: never bypasses login walls, CAPTCHAs, or subscriptions.
 */
export async function inspectChapterUrl(
  rawUrl: string,
  opts: { customCookie?: string } = {}
): Promise<UrlInspectionResult> {
  return runAdapterInspection(rawUrl, opts);
}

export interface FetchedChapterImageResult {
  ok: boolean;
  status: number;
  contentType: string;
  buffer: Buffer;
  finalUrl: string;
  failureCategory?: FailureCategory;
  failureReason?: string;
}

/**
 * Downloads a single remote chapter image with session cookies and explicit Referer propagation
 * to satisfy legitimate CDN hotlink rules while classifying any upstream 403/401/429 failures.
 */
export async function fetchChapterImage(
  imgUrl: string,
  opts: {
    referer?: string;
    customCookie?: string;
    client?: SessionHttpClient;
    timeoutMs?: number;
  } = {}
): Promise<FetchedChapterImageResult> {
  const client = opts.client || new SessionHttpClient(opts.customCookie);
  const res = await client.requestBinary(imgUrl, {
    referer: opts.referer,
    timeoutMs: opts.timeoutMs || 15000,
  });

  if (!res.ok) {
    const cls = classifyHttpFailure(
      res.status,
      res.headers,
      res.buffer.toString('utf-8', 0, 1000),
      'cdn_image'
    );
    return {
      ok: false,
      status: res.status,
      contentType: res.contentType,
      buffer: res.buffer,
      finalUrl: res.finalUrl,
      failureCategory: cls.category,
      failureReason: cls.explanation,
    };
  }

  if (!res.contentType.toLowerCase().startsWith('image/')) {
    return {
      ok: false,
      status: 415,
      contentType: res.contentType,
      buffer: res.buffer,
      finalUrl: res.finalUrl,
      failureCategory: 'HTTP_ERROR',
      failureReason: `الخادم أعاد نوع محتوى غير صورة (${res.contentType}) بدلاً من ملف الصورة المتوقع.`,
    };
  }

  return {
    ok: true,
    status: res.status,
    contentType: res.contentType,
    buffer: res.buffer,
    finalUrl: res.finalUrl,
  };
}
