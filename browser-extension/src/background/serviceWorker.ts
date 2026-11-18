import {
  buildUploadBatches,
  computeDataUrlSignature,
  dedupeCapturedPages,
  renumberCapturedPages,
} from '../shared/captureUtils.ts';
import type {
  CapturedPageItem,
  CaptureMethod,
  CropRectPayload,
  PairingConfig,
  UploadProgressState,
} from '../shared/types.ts';

const STORAGE_KEYS = {
  PAIRING: 'pt_ext_pairing',
  PAGES: 'pt_ext_pages',
  UPLOAD_STATE: 'pt_ext_upload_state',
} as const;

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error('لا يوجد تبويب نشط متاح.');
  }
  return tab;
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['captureContent.js'],
  });
}

async function getStoredPages(): Promise<CapturedPageItem[]> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.PAGES);
  return Array.isArray(data[STORAGE_KEYS.PAGES]) ? (data[STORAGE_KEYS.PAGES] as CapturedPageItem[]) : [];
}

async function saveStoredPages(pages: CapturedPageItem[]): Promise<CapturedPageItem[]> {
  const numbered = renumberCapturedPages(pages);
  await chrome.storage.local.set({ [STORAGE_KEYS.PAGES]: numbered });
  return numbered;
}

async function cropVisibleTabToPng(
  windowId: number,
  crop?: CropRectPayload
): Promise<{ dataUrl: string; width: number; height: number }> {
  const fullDataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const resp = await fetch(fullDataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  if (!crop) {
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    return { dataUrl: fullDataUrl, width, height };
  }

  const dpr = crop.devicePixelRatio || 1;
  const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(crop.x * dpr)));
  const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(crop.y * dpr)));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(crop.width * dpr)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(crop.height * dpr)));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('OffscreenCanvas 2D context unavailable.');
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const arrayBuf = await outBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return {
    dataUrl: `data:image/png;base64,${base64}`,
    width: sw,
    height: sh,
  };
}

async function finalizeAndStoreCapture(
  tab: chrome.tabs.Tab,
  outcome: {
    ok: boolean;
    error?: string;
    dataUrl?: string;
    width?: number;
    height?: number;
    sourceUrl: string;
    captureMethod?: CaptureMethod;
    cropFallback?: CropRectPayload;
  }
): Promise<{ ok: boolean; error?: string; addedPage?: CapturedPageItem; totalPages?: number }> {
  if (!outcome.ok) {
    return { ok: false, error: outcome.error || 'تعذر التقاط الصفحة.' };
  }

  let dataUrl = outcome.dataUrl;
  let width = outcome.width || 900;
  let height = outcome.height || 1200;
  let captureMethod: CaptureMethod = outcome.captureMethod || 'dom_image';

  if (!dataUrl && outcome.cropFallback) {
    const cropped = await cropVisibleTabToPng(tab.windowId, outcome.cropFallback);
    dataUrl = cropped.dataUrl;
    width = cropped.width;
    height = cropped.height;
    captureMethod = 'visible_tab_crop';
  }

  if (!dataUrl) {
    return { ok: false, error: 'لم يتم إنتاج بيانات صورة صالحة.' };
  }

  const existing = await getStoredPages();
  const newItem: CapturedPageItem = {
    id: `extpg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    pageNumber: existing.length + 1,
    dataUrl,
    sourceUrl: outcome.sourceUrl || tab.url || '',
    width,
    height,
    capturedAt: new Date().toISOString(),
    captureMethod,
    signature: computeDataUrlSignature(dataUrl, width, height),
    selected: true,
  };

  const updated = await saveStoredPages([...existing, newItem]);
  return { ok: true, addedPage: newItem, totalPages: updated.length };
}

async function captureVisibleViewportForTab(tab: chrome.tabs.Tab): Promise<{
  ok: boolean;
  error?: string;
  addedPage?: CapturedPageItem;
  totalPages?: number;
}> {
  if (!tab.id) throw new Error('Tab ID missing');
  await ensureContentScriptInjected(tab.id);
  const check = await chrome.tabs.sendMessage<{ ok: boolean; blocked?: boolean; reason?: string }>(
    tab.id,
    { type: 'CHECK_PAGE_STATE' }
  );
  if (check?.blocked) {
    return { ok: false, error: check.reason || 'الصفحة تعرض بوابة حماية حالياً.' };
  }

  const full = await cropVisibleTabToPng(tab.windowId);
  return finalizeAndStoreCapture(tab, {
    ok: true,
    dataUrl: full.dataUrl,
    width: full.width,
    height: full.height,
    sourceUrl: tab.url || '',
    captureMethod: 'visible_tab_full',
  });
}

async function uploadSelectedPagesToApp(opts: {
  pairing: PairingConfig;
  pages: CapturedPageItem[];
}): Promise<UploadProgressState> {
  const selected = opts.pages.filter((p) => p.selected);
  if (selected.length === 0) {
    throw new Error('يرجى تحديد صفحة واحدة على الأقل للإرسال.');
  }

  const updateProgress = async (state: UploadProgressState) => {
    await chrome.storage.local.set({ [STORAGE_KEYS.UPLOAD_STATE]: state });
  };

  await updateProgress({
    status: 'uploading',
    sent: 0,
    total: selected.length,
    message: `جاري إرسال 0 / ${selected.length} صفحة إلى PanelTranslate AI...`,
  });

  const batches = buildUploadBatches(selected, 2);
  let sentCount = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const res = await fetch(`${opts.pairing.appUrl}/api/browser-import/pages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.pairing.pairingToken}`,
      },
      body: JSON.stringify({
        sessionId: opts.pairing.sessionId,
        replaceExisting: b === 0,
        pages: batch.map((pg) => ({
          dataUrl: pg.dataUrl,
          pageNumber: pg.pageNumber,
          sourceUrl: pg.sourceUrl,
          width: pg.width,
          height: pg.height,
          capturedAt: pg.capturedAt,
          captureMethod: pg.captureMethod,
        })),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      const errState: UploadProgressState = {
        status: 'error',
        sent: sentCount,
        total: selected.length,
        message: data.error || `فشل رفع الدفعة (${res.status})`,
      };
      await updateProgress(errState);
      return errState;
    }

    sentCount += batch.length;
    await updateProgress({
      status: 'uploading',
      sent: sentCount,
      total: selected.length,
      message: `تم إرسال ${sentCount} / ${selected.length} صفحة...`,
    });
  }

  await updateProgress({
    status: 'completing',
    sent: sentCount,
    total: selected.length,
    message: 'جاري إنشاء الفصل وتجهيزه في محرر الترجمة...',
  });

  const completeRes = await fetch(`${opts.pairing.appUrl}/api/browser-import/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.pairing.pairingToken}`,
    },
    body: JSON.stringify({
      sessionId: opts.pairing.sessionId,
      chapterTitle: opts.pairing.chapterTitle,
    }),
  });

  const completeData = (await completeRes.json().catch(() => ({}))) as {
    error?: string;
    chapter?: { id: string };
  };
  if (!completeRes.ok) {
    const errState: UploadProgressState = {
      status: 'error',
      sent: sentCount,
      total: selected.length,
      message: completeData.error || `تعذر إنهاء الاستيراد (${completeRes.status})`,
    };
    await updateProgress(errState);
    return errState;
  }

  const doneState: UploadProgressState = {
    status: 'done',
    sent: sentCount,
    total: selected.length,
    chapterId: completeData.chapter?.id,
    message: `تم إرسال ${sentCount} صفحة بنجاح إلى PanelTranslate AI!`,
  };
  await updateProgress(doneState);
  return doneState;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pt-capture-image',
      title: 'PanelTranslate AI: التقاط الصورة الظاهرة',
      contexts: ['image', 'page'],
    });
    chrome.contextMenus.create({
      id: 'pt-select-area',
      title: 'PanelTranslate AI: تحديد منطقة أو صورة على الشاشة',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  void (async () => {
    await ensureContentScriptInjected(tab.id!);
    if (info.menuItemId === 'pt-capture-image') {
      const outcome = await chrome.tabs.sendMessage(tab.id!, { type: 'CAPTURE_CURRENT_IMAGE' });
      await finalizeAndStoreCapture(tab, outcome);
    } else if (info.menuItemId === 'pt-select-area') {
      await chrome.tabs.sendMessage(tab.id!, { type: 'START_SELECTION', mode: 'element' });
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'SELECTION_CAPTURED' || msg?.type === 'AUTO_COLLECT_CAPTURED') {
        const tab = sender.tab || (await getActiveTab());
        const res = await finalizeAndStoreCapture(tab, msg.payload);
        if (msg?.type === 'AUTO_COLLECT_CAPTURED') {
          const all = await getStoredPages();
          const deduped = dedupeCapturedPages(all);
          if (deduped.removedCount > 0) {
            await saveStoredPages(deduped.pages);
          }
        }
        sendResponse(res);
        return;
      }

      if (msg?.type === 'AUTO_COLLECT_PAUSED') {
        await chrome.storage.local.set({
          [STORAGE_KEYS.UPLOAD_STATE]: {
            status: 'error',
            sent: 0,
            total: 0,
            message: msg.reason || 'توقف الالتقاط التلقائي بسبب ظهور صفحة تحقق.',
          } satisfies UploadProgressState,
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'CMD_CHECK_TAB') {
        const tab = await getActiveTab();
        await ensureContentScriptInjected(tab.id!);
        const res = await chrome.tabs.sendMessage(tab.id!, { type: 'CHECK_PAGE_STATE' });
        sendResponse(res);
        return;
      }

      if (msg?.type === 'CMD_CAPTURE_CURRENT_IMAGE') {
        const tab = await getActiveTab();
        await ensureContentScriptInjected(tab.id!);
        const outcome = await chrome.tabs.sendMessage(tab.id!, { type: 'CAPTURE_CURRENT_IMAGE' });
        sendResponse(await finalizeAndStoreCapture(tab, outcome));
        return;
      }

      if (msg?.type === 'CMD_CAPTURE_VISIBLE_PAGE') {
        const tab = await getActiveTab();
        sendResponse(await captureVisibleViewportForTab(tab));
        return;
      }

      if (msg?.type === 'CMD_CAPTURE_NEXT_PAGE') {
        const tab = await getActiveTab();
        await ensureContentScriptInjected(tab.id!);
        const scrolled = await chrome.tabs.sendMessage<{ ok: boolean; blocked?: boolean; reason?: string }>(
          tab.id!,
          { type: 'SCROLL_FOR_NEXT_PAGE' }
        );
        if (scrolled?.blocked) {
          sendResponse({ ok: false, error: scrolled.reason });
          return;
        }
        sendResponse(await captureVisibleViewportForTab(tab));
        return;
      }

      if (msg?.type === 'CMD_STEP_IMAGE') {
        const tab = await getActiveTab();
        await ensureContentScriptInjected(tab.id!);
        const outcome = await chrome.tabs.sendMessage(tab.id!, {
          type: 'STEP_IMAGE',
          direction: msg.direction,
        });
        sendResponse(await finalizeAndStoreCapture(tab, outcome));
        return;
      }

      if (msg?.type === 'CMD_START_SELECT') {
        const tab = await getActiveTab();
        await ensureContentScriptInjected(tab.id!);
        await chrome.tabs.sendMessage(tab.id!, {
          type: 'START_SELECTION',
          mode: msg.mode === 'rect' ? 'rect' : 'element',
        });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'CMD_TOGGLE_AUTO_COLLECT') {
        const tab = await getActiveTab();
        await ensureContentScriptInjected(tab.id!);
        const res = await chrome.tabs.sendMessage(tab.id!, {
          type: 'TOGGLE_AUTO_COLLECT',
          enable: Boolean(msg.enable),
        });
        sendResponse(res);
        return;
      }

      if (msg?.type === 'CMD_SEND_TO_TRANSLATOR') {
        const data = await chrome.storage.local.get([STORAGE_KEYS.PAIRING, STORAGE_KEYS.PAGES]);
        const pairing = data[STORAGE_KEYS.PAIRING] as PairingConfig | undefined;
        const pages = (data[STORAGE_KEYS.PAGES] as CapturedPageItem[]) || [];
        if (!pairing?.appUrl || !pairing?.sessionId || !pairing?.pairingToken) {
          sendResponse({
            ok: false,
            error: 'الإضافة غير مرتبطة بجلسة نشطة. اضغط Connect to PanelTranslate AI أولاً.',
          });
          return;
        }
        const state = await uploadSelectedPagesToApp({ pairing, pages });
        sendResponse({ ok: state.status === 'done', state });
        return;
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});
