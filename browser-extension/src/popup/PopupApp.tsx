import React, { useEffect, useState } from 'react';
import {
  dedupeCapturedPages,
  parsePairingInput,
  renumberCapturedPages,
  reorderCapturedPages,
} from '../shared/captureUtils.ts';
import type {
  CapturedPageItem,
  PairingConfig,
  UploadProgressState,
} from '../shared/types.ts';

const STORAGE_KEYS = {
  PAIRING: 'pt_ext_pairing',
  PAGES: 'pt_ext_pages',
  UPLOAD_STATE: 'pt_ext_upload_state',
} as const;

export const PopupApp: React.FC = () => {
  const [pairingInput, setPairingInput] = useState('');
  const [pairing, setPairing] = useState<PairingConfig | null>(null);
  const [pages, setPages] = useState<CapturedPageItem[]>([]);
  const [uploadState, setUploadState] = useState<UploadProgressState>({
    status: 'idle',
    sent: 0,
    total: 0,
    message: '',
  });
  const [tabStatus, setTabStatus] = useState<{
    blocked?: boolean;
    reason?: string;
    visibleImageCount?: number;
    autoCollectActive?: boolean;
  }>({});
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const syncFromStorage = async () => {
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.PAIRING,
      STORAGE_KEYS.PAGES,
      STORAGE_KEYS.UPLOAD_STATE,
    ]);
    if (data[STORAGE_KEYS.PAIRING]) setPairing(data[STORAGE_KEYS.PAIRING] as PairingConfig);
    if (Array.isArray(data[STORAGE_KEYS.PAGES])) setPages(data[STORAGE_KEYS.PAGES] as CapturedPageItem[]);
    if (data[STORAGE_KEYS.UPLOAD_STATE]) {
      setUploadState(data[STORAGE_KEYS.UPLOAD_STATE] as UploadProgressState);
    }
  };

  useEffect(() => {
    void syncFromStorage();
    void chrome.runtime.sendMessage({ type: 'CMD_CHECK_TAB' }).then((res) => {
      if (res) setTabStatus(res);
    }).catch(() => {});

    const timer = window.setInterval(() => {
      void syncFromStorage();
    }, 900);
    return () => window.clearInterval(timer);
  }, []);

  const persistPages = async (next: CapturedPageItem[]) => {
    const normalized = renumberCapturedPages(next);
    setPages(normalized);
    await chrome.storage.local.set({ [STORAGE_KEYS.PAGES]: normalized });
  };

  const handleConnect = async () => {
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      const parsed = parsePairingInput(pairingInput);
      const checkRes = await fetch(
        `${parsed.appUrl}/api/browser-import/session/${encodeURIComponent(parsed.sessionId)}`,
        {
          headers: { Authorization: `Bearer ${parsed.pairingToken}` },
        }
      );
      if (!checkRes.ok) {
        const body = (await checkRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `تعذر التحقق من الجلسة (${checkRes.status})`);
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.PAIRING]: parsed });
      setPairing(parsed);
      setPairingInput('');
      setStatusMsg(`تم الاتصال بجلسة ${parsed.sessionId} بنجاح.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runCaptureCommand = async (message: any) => {
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (!res?.ok) {
        setErrorMsg(res?.error || 'تعذر التقاط الصورة من الصفحة الحالية.');
      } else {
        await syncFromStorage();
        setStatusMsg(`تم التقاط الصفحة بنجاح (الإجمالي: ${res.totalPages ?? pages.length + 1}).`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCapturedPages = async () => {
    setErrorMsg('');
    await persistPages(pages);
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      totalPages: pages.length,
      pages: pages.map((p) => ({
        pageNumber: p.pageNumber,
        sourceUrl: p.sourceUrl,
        width: p.width,
        height: p.height,
        capturedAt: p.capturedAt,
        captureMethod: p.captureMethod,
        dataUrl: p.dataUrl,
      })),
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paneltranslate_captured_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg(`تم حفظ ${pages.length} صفحة محلياً وتصدير نسخة احتياطية.`);
  };

  const handleSendToTranslator = async () => {
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CMD_SEND_TO_TRANSLATOR' });
      await syncFromStorage();
      if (!res?.ok) {
        setErrorMsg(res?.error || res?.state?.message || 'فشل إرسال الصفحات إلى التطبيق.');
      } else {
        setStatusMsg(res.state?.message || 'تم الإرسال بنجاح.');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = pages.filter((p) => p.selected).length;
  const pct = uploadState.total > 0 ? Math.round((uploadState.sent / uploadState.total) * 100) : 0;

  return (
    <div dir="rtl" className="w-[410px] min-h-[520px] bg-slate-950 text-slate-100 p-3.5 font-sans text-xs space-y-3">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div>
          <h1 className="text-sm font-bold text-white">PanelTranslate Companion</h1>
          <p className="text-[11px] text-slate-400">التقاط الصفحات المرئية مباشرة من المتصفح</p>
        </div>
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-mono ${
            pairing ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-slate-800 text-slate-300'
          }`}
        >
          {pairing ? `Connected · ${pairing.sessionId.slice(0, 10)}` : 'Disconnected'}
        </span>
      </header>

      {/* Active Challenge Warning */}
      {tabStatus.blocked && (
        <div className="p-2.5 rounded border border-amber-700 bg-amber-950/60 text-amber-200 text-[11px] leading-relaxed">
          {tabStatus.reason}
        </div>
      )}

      {/* Connect to PanelTranslate AI */}
      <section className="p-2.5 rounded-lg border border-slate-800 bg-slate-900 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-200">الربط مع التطبيق</span>
          {pairing && (
            <button
              type="button"
              onClick={async () => {
                await chrome.storage.local.remove(STORAGE_KEYS.PAIRING);
                setPairing(null);
              }}
              className="text-[11px] text-rose-400 hover:underline cursor-pointer"
            >
              فصل الجلسة
            </button>
          )}
        </div>
        <textarea
          rows={2}
          value={pairingInput}
          onChange={(e) => setPairingInput(e.target.value)}
          placeholder="الصق كود الربط (Pairing Code) من نافذة الاستيراد في PanelTranslate AI..."
          className="w-full p-2 rounded border border-slate-700 bg-slate-950 text-[11px] font-mono text-slate-200"
        />
        <button
          type="button"
          disabled={busy || !pairingInput.trim()}
          onClick={handleConnect}
          className="w-full py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold cursor-pointer"
        >
          Connect to PanelTranslate AI
        </button>
      </section>

      {/* Capture Actions */}
      <section className="p-2.5 rounded-lg border border-slate-800 bg-slate-900 space-y-2">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>أدوات التقاط الصفحات</span>
          <span>صور مرئية مكتشفة: {tabStatus.visibleImageCount ?? 0}</span>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => runCaptureCommand({ type: 'CMD_CAPTURE_CURRENT_IMAGE' })}
            className="py-1.5 px-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-medium cursor-pointer"
          >
            Capture Current Image
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runCaptureCommand({ type: 'CMD_CAPTURE_VISIBLE_PAGE' })}
            className="py-1.5 px-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-medium cursor-pointer"
          >
            Capture Visible Page
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void chrome.runtime.sendMessage({ type: 'CMD_START_SELECT', mode: 'element' });
              window.close();
            }}
            className="py-1.5 px-2 rounded bg-indigo-950 hover:bg-indigo-900 border border-indigo-700 text-indigo-100 font-medium cursor-pointer"
          >
            Select Image on Screen
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void chrome.runtime.sendMessage({ type: 'CMD_START_SELECT', mode: 'rect' });
              window.close();
            }}
            className="py-1.5 px-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-medium cursor-pointer"
          >
            Select Rectangle Area
          </button>
        </div>

        {/* Long Chapters Batch Navigation */}
        <div className="grid grid-cols-4 gap-1.5 pt-1 border-t border-slate-800">
          <button
            type="button"
            disabled={busy}
            onClick={() => runCaptureCommand({ type: 'CMD_STEP_IMAGE', direction: 'prev' })}
            className="py-1 px-1.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[11px] cursor-pointer"
          >
            Previous Image
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runCaptureCommand({ type: 'CMD_STEP_IMAGE', direction: 'next' })}
            className="py-1 px-1.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[11px] cursor-pointer"
          >
            Next Image
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runCaptureCommand({ type: 'CMD_CAPTURE_VISIBLE_PAGE' })}
            className="py-1 px-1.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[11px] cursor-pointer"
          >
            Capture Current Viewport
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runCaptureCommand({ type: 'CMD_CAPTURE_NEXT_PAGE' })}
            className="py-1 px-1.5 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[11px] cursor-pointer"
          >
            Capture Next Page
          </button>
        </div>

        <label className="flex items-center justify-between pt-1 text-[11px] text-slate-300 cursor-pointer">
          <span>Auto Collect (التقاط الصور الظاهرة أثناء التمرير)</span>
          <input
            type="checkbox"
            checked={Boolean(tabStatus.autoCollectActive)}
            onChange={async (e) => {
              const res = await chrome.runtime.sendMessage({
                type: 'CMD_TOGGLE_AUTO_COLLECT',
                enable: e.target.checked,
              });
              setTabStatus((prev) => ({ ...prev, autoCollectActive: Boolean(res?.active) }));
              if (res?.reason) setErrorMsg(res.reason);
            }}
          />
        </label>
      </section>

      {/* Captured Pages List */}
      <section className="p-2.5 rounded-lg border border-slate-800 bg-slate-900 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold">الصفحات الملتقطة ({selectedCount}/{pages.length})</span>
          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => {
                const res = dedupeCapturedPages(pages);
                void persistPages(res.pages);
                setStatusMsg(`تمت إزالة ${res.removedCount} صفحة مكررة.`);
              }}
              className="text-indigo-400 hover:underline cursor-pointer"
            >
              حذف المكرر
            </button>
            <button
              type="button"
              onClick={() => void persistPages(pages)}
              className="text-slate-300 hover:underline cursor-pointer"
            >
              ترقيم
            </button>
            <button
              type="button"
              onClick={() => void persistPages([])}
              className="text-rose-400 hover:underline cursor-pointer"
            >
              مسح الكل
            </button>
          </div>
        </div>

        {pages.length === 0 ? (
          <p className="text-[11px] text-slate-500 py-3 text-center">
            لم يتم التقاط أي صفحات بعد. افتح الفصل ثم استخدم أزرار الالتقاط أعلاه.
          </p>
        ) : (
          <div className="max-h-40 overflow-y-auto space-y-1.5">
            {pages.map((pg, idx) => (
              <div
                key={pg.id}
                className="flex items-center gap-2 p-1.5 rounded border border-slate-800 bg-slate-950"
              >
                <input
                  type="checkbox"
                  checked={pg.selected}
                  onChange={() =>
                    void persistPages(
                      pages.map((x) => (x.id === pg.id ? { ...x, selected: !x.selected } : x))
                    )
                  }
                />
                <img src={pg.dataUrl} alt={`Page ${pg.pageNumber}`} className="w-9 h-11 object-cover rounded border border-slate-800" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono font-semibold text-slate-200">
                    #{pg.pageNumber} · {pg.width}×{pg.height}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">{pg.captureMethod}</div>
                </div>
                <div className="flex items-center gap-1 text-[10px]">
                  <button
                    type="button"
                    onClick={() => void persistPages(reorderCapturedPages(pages, idx, 'up'))}
                    className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => void persistPages(reorderCapturedPages(pages, idx, 'down'))}
                    className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => void persistPages(pages.filter((x) => x.id !== pg.id))}
                    className="px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 cursor-pointer"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Progress & Final Actions */}
      {uploadState.status !== 'idle' && (
        <div className="p-2 rounded border border-slate-800 bg-slate-900 space-y-1">
          <div className="flex justify-between text-[11px]">
            <span>{uploadState.message}</span>
            <span className="font-mono">{pct}%</span>
          </div>
          <div className="w-full h-1.5 rounded bg-slate-800 overflow-hidden">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="p-2 rounded border border-rose-800 bg-rose-950/60 text-rose-200 text-[11px]">
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div className="p-2 rounded border border-emerald-800 bg-emerald-950/60 text-emerald-200 text-[11px]">
          {statusMsg}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pages.length === 0}
          onClick={handleSaveCapturedPages}
          className="py-2 rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 font-semibold cursor-pointer"
        >
          Save Captured Pages
        </button>
        <button
          type="button"
          disabled={busy || selectedCount === 0 || !pairing}
          onClick={handleSendToTranslator}
          className="py-2 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-semibold cursor-pointer"
        >
          Send to Translator
        </button>
      </div>
    </div>
  );
};
