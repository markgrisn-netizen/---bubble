import type {
  CapturedPageItem,
  PairingConfig,
  ProtectionCheckResult,
} from './types.ts';

/**
 * Checks visible page title, body text snippet, and DOM markers to determine whether the tab
 * currently shows an active Cloudflare / CAPTCHA / login challenge instead of manga content.
 * Never bypasses challenges — blocks auto/manual manga capture cleanly until the user resolves it.
 */
export function detectProtectionChallenge(signals: {
  title: string;
  bodyText: string;
  hasTurnstileIframe?: boolean;
  hasRecaptchaIframe?: boolean;
  hasPasswordInputOnly?: boolean;
  visibleMangaImagesCount: number;
}): ProtectionCheckResult {
  const titleLower = (signals.title || '').toLowerCase();
  const bodyLower = (signals.bodyText || '').slice(0, 6000).toLowerCase();

  if (
    titleLower.includes('just a moment') ||
    titleLower.includes('attention required') ||
    signals.hasTurnstileIframe ||
    bodyLower.includes('verify you are human') ||
    bodyLower.includes('checking your browser before accessing') ||
    bodyLower.includes('enable javascript and cookies to continue')
  ) {
    return {
      blocked: true,
      kind: 'cloudflare_waf',
      reason:
        'الصفحة تعرض حالياً تحدي Cloudflare / تحقق المتصفح. أكمل التحقق يدوياً في المتصفح حتى تظهر صفحات المانغا ثم أعد الالتقاط.',
    };
  }

  if (
    signals.hasRecaptchaIframe ||
    bodyLower.includes('g-recaptcha') ||
    bodyLower.includes('hcaptcha') ||
    bodyLower.includes('bot challenge not passed')
  ) {
    return {
      blocked: true,
      kind: 'captcha',
      reason:
        'الصفحة تعرض اختبار CAPTCHA حالياً وليست صفحة فصل مانغا. اجتز الاختبار يدوياً أولاً ثم التقط الصفحات.',
    };
  }

  if (
    signals.visibleMangaImagesCount === 0 &&
    signals.hasPasswordInputOnly &&
    (bodyLower.includes('sign in') || bodyLower.includes('log in') || bodyLower.includes('تسجيل الدخول'))
  ) {
    return {
      blocked: true,
      kind: 'login_gate',
      reason:
        'الصفحة تعرض نموذج تسجيل دخول ولا تحتوي على صور فصل ظاهرة. سجّل الدخول يدوياً في المتصفح حتى يفتح الفصل ثم ابدأ الالتقاط.',
    };
  }

  return { blocked: false };
}

/**
 * Parses either a JSON pairing bundle copied from PanelTranslate AI or a compact base64 bundle string.
 */
export function parsePairingInput(raw: string): PairingConfig {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('يرجى لصق كود الربط (Pairing Code) من تطبيق PanelTranslate AI.');
  }

  let parsedObj: Partial<PairingConfig>;
  try {
    if (trimmed.startsWith('{')) {
      parsedObj = JSON.parse(trimmed) as Partial<PairingConfig>;
    } else {
      const decoded = atob(trimmed);
      parsedObj = JSON.parse(decoded) as Partial<PairingConfig>;
    }
  } catch {
    throw new Error('صيغة كود الربط غير صالحة.');
  }

  if (!parsedObj.appUrl || !parsedObj.sessionId || !parsedObj.pairingToken) {
    throw new Error('كود الربط ناقص (يجب أن يتضمن appUrl و sessionId و pairingToken).');
  }

  const normalizedUrl = parsedObj.appUrl.replace(/\/+$/, '');
  return {
    appUrl: normalizedUrl,
    sessionId: parsedObj.sessionId.trim(),
    pairingToken: parsedObj.pairingToken.trim(),
    chapterTitle: parsedObj.chapterTitle?.trim(),
    connectedAt: new Date().toISOString(),
  };
}

/**
 * Computes a lightweight deterministic signature for deduplicating identical captured frames/images.
 */
export function computeDataUrlSignature(dataUrl: string, width: number, height: number): string {
  const commaIdx = dataUrl.indexOf(',');
  const payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(payload.length / 4096));
  for (let i = 0; i < payload.length; i += step) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${width}x${height}:${payload.length}:${(hash >>> 0).toString(16)}`;
}

export function renumberCapturedPages(pages: CapturedPageItem[]): CapturedPageItem[] {
  return pages.map((p, idx) => ({
    ...p,
    pageNumber: idx + 1,
  }));
}

export function dedupeCapturedPages(pages: CapturedPageItem[]): {
  pages: CapturedPageItem[];
  removedCount: number;
} {
  const seen = new Set<string>();
  const unique: CapturedPageItem[] = [];
  for (const p of pages) {
    const sig = p.signature || computeDataUrlSignature(p.dataUrl, p.width, p.height);
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push({ ...p, signature: sig });
    }
  }
  return {
    pages: renumberCapturedPages(unique),
    removedCount: pages.length - unique.length,
  };
}

export function reorderCapturedPages(
  pages: CapturedPageItem[],
  index: number,
  direction: 'up' | 'down'
): CapturedPageItem[] {
  const targetIdx = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= pages.length || targetIdx < 0 || targetIdx >= pages.length) {
    return pages;
  }
  const copy = [...pages];
  const [moved] = copy.splice(index, 1);
  copy.splice(targetIdx, 0, moved);
  return renumberCapturedPages(copy);
}

/**
 * Splits large chapters into sequential upload batches to stay comfortably under payload limits.
 */
export function buildUploadBatches<T>(items: T[], batchSize = 3): T[][] {
  const size = Math.max(1, batchSize);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * Determines whether a DOM element can be read directly via Canvas or requires visible-tab screenshot crop fallback.
 */
export function decideImageCaptureStrategy(info: {
  tagName: 'IMG' | 'CANVAS';
  canvasExportSucceeded: boolean;
  isTaintedCorsError: boolean;
}): 'canvas_capture' | 'dom_image' | 'visible_tab_crop' {
  if (info.tagName === 'CANVAS') {
    return info.canvasExportSucceeded ? 'canvas_capture' : 'visible_tab_crop';
  }
  if (info.isTaintedCorsError || !info.canvasExportSucceeded) {
    return 'visible_tab_crop';
  }
  return 'dom_image';
}
