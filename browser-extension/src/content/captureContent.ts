import { detectProtectionChallenge } from '../shared/captureUtils.ts';
import type { CaptureMethod, CropRectPayload } from '../shared/types.ts';

interface ContentCaptureOutcome {
  ok: boolean;
  error?: string;
  challengeBlocked?: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  sourceUrl: string;
  captureMethod?: CaptureMethod;
  cropFallback?: CropRectPayload;
  totalMangaElements?: number;
  activeIndex?: number;
}

declare global {
  interface Window {
    __ptCompanionInstalled?: boolean;
    __ptCurrentImageIdx?: number;
    __ptAutoCollectTimer?: number | null;
    __ptAutoSeenElements?: WeakSet<Element>;
  }
}

function getVisibleMangaCandidates(): Array<HTMLImageElement | HTMLCanvasElement> {
  const candidates: Array<HTMLImageElement | HTMLCanvasElement> = [];
  const allEls = Array.from(document.querySelectorAll('img, canvas')) as Array<
    HTMLImageElement | HTMLCanvasElement
  >;

  for (const el of allEls) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 160) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      continue;
    }
    if (el instanceof HTMLImageElement) {
      // Trigger lazy-loaded attribute hint check without hidden network scraping
      const natW = el.naturalWidth || rect.width;
      const natH = el.naturalHeight || rect.height;
      if (natW < 180 || natH < 180) continue;
    }
    candidates.push(el);
  }
  return candidates;
}

function runProtectionCheck(): { blocked: boolean; reason?: string } {
  const candidates = getVisibleMangaCandidates();
  const hasTurnstileIframe = Boolean(
    document.querySelector(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], [class*="cf-turnstile"]'
    )
  );
  const hasRecaptchaIframe = Boolean(
    document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha'
    )
  );
  const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
  return detectProtectionChallenge({
    title: document.title || '',
    bodyText: document.body?.innerText || '',
    hasTurnstileIframe,
    hasRecaptchaIframe,
    hasPasswordInputOnly: hasPasswordInput,
    visibleMangaImagesCount: candidates.length,
  });
}

function highlightElementBriefly(el: Element): void {
  const rect = el.getBoundingClientRect();
  const badge = document.createElement('div');
  badge.style.position = 'fixed';
  badge.style.left = `${Math.max(0, rect.left)}px`;
  badge.style.top = `${Math.max(0, rect.top)}px`;
  badge.style.width = `${Math.max(4, rect.width)}px`;
  badge.style.height = `${Math.max(4, rect.height)}px`;
  badge.style.border = '3px solid #4F46E5';
  badge.style.background = 'rgba(79, 70, 229, 0.10)';
  badge.style.zIndex = '2147483646';
  badge.style.pointerEvents = 'none';
  badge.style.boxSizing = 'border-box';
  document.body.appendChild(badge);
  setTimeout(() => badge.remove(), 900);
}

/**
 * Attempts direct Canvas/DOM extraction for an already-visible <img> or <canvas>.
 * If Canvas is tainted by CORS (SecurityError), cleanly falls back to returning the element's
 * visible viewport bounding rectangle so Chrome's tabs.captureVisibleTab crops it safely.
 */
function captureSingleDomOrCanvasElement(
  el: HTMLImageElement | HTMLCanvasElement
): ContentCaptureOutcome {
  const prot = runProtectionCheck();
  if (prot.blocked) {
    return {
      ok: false,
      challengeBlocked: true,
      error: prot.reason,
      sourceUrl: location.href,
    };
  }

  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  if (el instanceof HTMLCanvasElement) {
    try {
      const dataUrl = el.toDataURL('image/png');
      return {
        ok: true,
        dataUrl,
        width: el.width || Math.round(rect.width),
        height: el.height || Math.round(rect.height),
        sourceUrl: location.href,
        captureMethod: 'canvas_capture',
      };
    } catch {
      // Tainted canvas: fall back to visible tab crop
      return {
        ok: true,
        sourceUrl: location.href,
        captureMethod: 'visible_tab_crop',
        cropFallback: {
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.min(window.innerWidth - Math.max(0, rect.left), rect.width),
          height: Math.min(window.innerHeight - Math.max(0, rect.top), rect.height),
          devicePixelRatio: dpr,
          sourceUrl: location.href,
          naturalWidth: el.width,
          naturalHeight: el.height,
          captureMethod: 'visible_tab_crop',
        },
      };
    }
  }

  // HTMLImageElement: draw into offscreen canvas if CORS allows
  const natW = el.naturalWidth || Math.round(rect.width);
  const natH = el.naturalHeight || Math.round(rect.height);
  try {
    const c = document.createElement('canvas');
    c.width = natW;
    c.height = natH;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.drawImage(el, 0, 0, natW, natH);
      const dataUrl = c.toDataURL('image/png');
      return {
        ok: true,
        dataUrl,
        width: natW,
        height: natH,
        sourceUrl: location.href,
        captureMethod: 'dom_image',
      };
    }
  } catch {
    // Tainted canvas due to cross-origin image without Access-Control-Allow-Origin
  }

  // Fallback to visible tab screenshot crop of what the user actually sees
  const clampedX = Math.max(0, rect.left);
  const clampedY = Math.max(0, rect.top);
  const clampedW = Math.min(window.innerWidth - clampedX, rect.right - clampedX);
  const clampedH = Math.min(window.innerHeight - clampedY, rect.bottom - clampedY);

  if (clampedW < 30 || clampedH < 30) {
    return {
      ok: false,
      error: 'الصورة خارج نطاق العرض المرئي حالياً. مرّر الصفحة حتى تظهر الصورة ثم التقطها.',
      sourceUrl: location.href,
    };
  }

  return {
    ok: true,
    sourceUrl: location.href,
    captureMethod: 'visible_tab_crop',
    cropFallback: {
      x: clampedX,
      y: clampedY,
      width: clampedW,
      height: clampedH,
      devicePixelRatio: dpr,
      sourceUrl: location.href,
      naturalWidth: natW,
      naturalHeight: natH,
      captureMethod: 'visible_tab_crop',
    },
  };
}

function findPrimaryVisibleCandidate(): HTMLImageElement | HTMLCanvasElement | null {
  const candidates = getVisibleMangaCandidates();
  if (candidates.length === 0) return null;

  const vh = window.innerHeight;
  let best: HTMLImageElement | HTMLCanvasElement | null = null;
  let bestScore = -1;

  for (const el of candidates) {
    const r = el.getBoundingClientRect();
    const visibleH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const visibleW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
    const area = visibleW * visibleH;
    if (area > bestScore) {
      bestScore = area;
      best = el;
    }
  }
  return best;
}

function startInteractiveSelectionOverlay(mode: 'element' | 'rect'): void {
  const existing = document.getElementById('__pt_selection_overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = '__pt_selection_overlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '2147483647';
  overlay.style.cursor = 'crosshair';
  overlay.style.background = mode === 'rect' ? 'rgba(15, 23, 42, 0.18)' : 'transparent';

  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.border = '2px solid #4F46E5';
  box.style.background = 'rgba(79, 70, 229, 0.14)';
  box.style.pointerEvents = 'none';
  box.style.display = 'none';
  overlay.appendChild(box);

  const hint = document.createElement('div');
  hint.textContent =
    mode === 'element'
      ? 'PanelTranslate AI: انقر على صورة المانغا أو Canvas لالتقاطها (ESC للإلغاء)'
      : 'PanelTranslate AI: اسحب مستطيلاً حول المنطقة المطلوبة (ESC للإلغاء)';
  hint.style.position = 'fixed';
  hint.style.top = '14px';
  hint.style.left = '50%';
  hint.style.transform = 'translateX(-50%)';
  hint.style.background = '#0F172A';
  hint.style.color = '#F8FAFC';
  hint.style.padding = '8px 14px';
  hint.style.borderRadius = '8px';
  hint.style.fontFamily = 'system-ui, sans-serif';
  hint.style.fontSize = '13px';
  hint.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
  hint.style.pointerEvents = 'none';
  overlay.appendChild(hint);

  const cleanup = () => {
    window.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cleanup();
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  if (mode === 'element') {
    let hoveredTarget: HTMLImageElement | HTMLCanvasElement | null = null;
    overlay.addEventListener('mousemove', (e) => {
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';
      const media = el?.closest('img, canvas') as HTMLImageElement | HTMLCanvasElement | null;
      if (media) {
        hoveredTarget = media;
        const r = media.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = `${r.left}px`;
        box.style.top = `${r.top}px`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;
      } else {
        hoveredTarget = null;
        box.style.display = 'none';
      }
    });

    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = hoveredTarget;
      cleanup();
      if (!target) return;
      const res = captureSingleDomOrCanvasElement(target);
      void chrome.runtime.sendMessage({
        type: 'SELECTION_CAPTURED',
        payload: res,
      });
    });
  } else {
    let startX = 0;
    let startY = 0;
    let dragging = false;

    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = 'block';
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = '0px';
      box.style.height = '0px';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
    });

    overlay.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      cleanup();
      if (w < 24 || h < 24) return;
      const prot = runProtectionCheck();
      if (prot.blocked) {
        void chrome.runtime.sendMessage({
          type: 'SELECTION_CAPTURED',
          payload: { ok: false, challengeBlocked: true, error: prot.reason, sourceUrl: location.href },
        });
        return;
      }
      void chrome.runtime.sendMessage({
        type: 'SELECTION_CAPTURED',
        payload: {
          ok: true,
          sourceUrl: location.href,
          captureMethod: 'visible_tab_crop',
          cropFallback: {
            x,
            y,
            width: w,
            height: h,
            devicePixelRatio: window.devicePixelRatio || 1,
            sourceUrl: location.href,
            captureMethod: 'visible_tab_crop',
          },
        } satisfies ContentCaptureOutcome,
      });
    });
  }

  document.body.appendChild(overlay);
}

function togglePassiveAutoCollect(enable: boolean): { active: boolean; reason?: string } {
  if (window.__ptAutoCollectTimer) {
    window.clearInterval(window.__ptAutoCollectTimer);
    window.__ptAutoCollectTimer = null;
  }
  if (!enable) {
    return { active: false };
  }

  const prot = runProtectionCheck();
  if (prot.blocked) {
    return { active: false, reason: prot.reason };
  }

  window.__ptAutoSeenElements = new WeakSet<Element>();
  const scanVisible = () => {
    const check = runProtectionCheck();
    if (check.blocked) {
      if (window.__ptAutoCollectTimer) {
        window.clearInterval(window.__ptAutoCollectTimer);
        window.__ptAutoCollectTimer = null;
      }
      void chrome.runtime.sendMessage({
        type: 'AUTO_COLLECT_PAUSED',
        reason: check.reason,
      });
      return;
    }

    const candidates = getVisibleMangaCandidates();
    const vh = window.innerHeight;
    for (const el of candidates) {
      if (window.__ptAutoSeenElements?.has(el)) continue;
      const rect = el.getBoundingClientRect();
      // Strictly only capture images actually visible in viewport to the user
      if (rect.bottom > 40 && rect.top < vh - 40) {
        window.__ptAutoSeenElements?.add(el);
        const outcome = captureSingleDomOrCanvasElement(el);
        if (outcome.ok) {
          void chrome.runtime.sendMessage({
            type: 'AUTO_COLLECT_CAPTURED',
            payload: outcome,
          });
        }
      }
    }
  };

  scanVisible();
  window.__ptAutoCollectTimer = window.setInterval(scanVisible, 1200);
  return { active: true };
}

if (!window.__ptCompanionInstalled) {
  window.__ptCompanionInstalled = true;
  window.__ptCurrentImageIdx = 0;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'CHECK_PAGE_STATE') {
        const prot = runProtectionCheck();
        const candidates = getVisibleMangaCandidates();
        sendResponse({
          ok: !prot.blocked,
          blocked: prot.blocked,
          reason: prot.reason,
          title: document.title,
          url: location.href,
          visibleImageCount: candidates.length,
          autoCollectActive: Boolean(window.__ptAutoCollectTimer),
        });
        return;
      }

      if (msg?.type === 'CAPTURE_CURRENT_IMAGE') {
        const prot = runProtectionCheck();
        if (prot.blocked) {
          sendResponse({ ok: false, challengeBlocked: true, error: prot.reason, sourceUrl: location.href });
          return;
        }
        const candidates = getVisibleMangaCandidates();
        const idx = window.__ptCurrentImageIdx ?? 0;
        const target =
          (candidates[idx] &&
            candidates[idx].getBoundingClientRect().bottom > 0 &&
            candidates[idx].getBoundingClientRect().top < window.innerHeight
            ? candidates[idx]
            : null) || findPrimaryVisibleCandidate();

        if (!target) {
          sendResponse({
            ok: false,
            error: 'لم يتم العثور على صورة مانغا ظاهرة في نطاق العرض الحالي. استخدم Capture Visible Page أو Select Rectangle.',
            sourceUrl: location.href,
          });
          return;
        }
        highlightElementBriefly(target);
        sendResponse(captureSingleDomOrCanvasElement(target));
        return;
      }

      if (msg?.type === 'STEP_IMAGE') {
        const prot = runProtectionCheck();
        if (prot.blocked) {
          sendResponse({ ok: false, challengeBlocked: true, error: prot.reason, sourceUrl: location.href });
          return;
        }
        const candidates = getVisibleMangaCandidates();
        if (candidates.length === 0) {
          sendResponse({
            ok: false,
            error: 'لا توجد صور مانغا مكتشفة في هذه الصفحة بعد.',
            sourceUrl: location.href,
          });
          return;
        }
        const delta = msg.direction === 'prev' ? -1 : 1;
        const nextIdx = Math.max(
          0,
          Math.min(candidates.length - 1, (window.__ptCurrentImageIdx ?? 0) + delta)
        );
        window.__ptCurrentImageIdx = nextIdx;
        const el = candidates[nextIdx];
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise((r) => setTimeout(r, 250));
        highlightElementBriefly(el);
        const outcome = captureSingleDomOrCanvasElement(el);
        sendResponse({
          ...outcome,
          totalMangaElements: candidates.length,
          activeIndex: nextIdx + 1,
        });
        return;
      }

      if (msg?.type === 'SCROLL_FOR_NEXT_PAGE') {
        window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 450));
        const prot = runProtectionCheck();
        sendResponse({
          ok: !prot.blocked,
          blocked: prot.blocked,
          reason: prot.reason,
          sourceUrl: location.href,
        });
        return;
      }

      if (msg?.type === 'START_SELECTION') {
        startInteractiveSelectionOverlay(msg.mode === 'rect' ? 'rect' : 'element');
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'TOGGLE_AUTO_COLLECT') {
        sendResponse(togglePassiveAutoCollect(Boolean(msg.enable)));
        return;
      }
    })();
    return true;
  });
}
