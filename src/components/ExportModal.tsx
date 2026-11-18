import React, { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import type { AiSettings, LanguageCode, Page, ReadingDirection } from '../types/domain';
import { tFor } from '../i18n/translations';
import {
  exportChapterPages,
  type ExportContentMode,
  type ExportFormat,
} from '../utils/fileExport';
import { parsePageRangeSpec } from '../utils/pageBatchUtils';

interface ExportModalProps {
  lang: LanguageCode;
  isOpen: boolean;
  chapterTitle: string;
  pages: Page[];
  currentPageNumber?: number;
  readingDirection?: ReadingDirection;
  inpaintingEngine: AiSettings['inpaintingEngine'];
  onClose: () => void;
}

export const ExportModal: React.FC<ExportModalProps> = ({
  lang,
  isOpen,
  chapterTitle,
  pages,
  currentPageNumber = 1,
  readingDirection = 'ltr',
  inpaintingEngine,
  onClose,
}) => {
  const t = tFor(lang);
  const [format, setFormat] = useState<ExportFormat>('cbz');
  const [contentMode, setContentMode] = useState<ExportContentMode>('translated');
  const [exportDir, setExportDir] = useState<ReadingDirection>(readingDirection);
  const [reverseSpreads, setReverseSpreads] = useState(false);
  const [pageScope, setPageScope] = useState<'all' | 'current' | 'range'>('all');
  const [rangeText, setRangeText] = useState('');
  const [includeLayers, setIncludeLayers] = useState(true);
  const [quality, setQuality] = useState(0.95);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (isOpen) {
      setExportDir(readingDirection);
    }
  }, [isOpen, readingDirection]);

  if (!isOpen) return null;

  const selectedPageNumbers = (() => {
    if (pageScope === 'current') return [currentPageNumber];
    if (pageScope === 'range') return parsePageRangeSpec(rangeText, pages.length);
    return undefined;
  })();

  const handleExport = async () => {
    setExporting(true);
    setErrorMsg('');
    setProgress(5);
    try {
      await exportChapterPages(
        chapterTitle,
        pages,
        {
          format,
          contentMode,
          includeEditableLayersJson: includeLayers,
          quality,
          inpaintingEngine,
          readingDirection: exportDir,
          reverseSpreadPairsForRtl: reverseSpreads,
          selectedPageNumbers,
        },
        (pct) => setProgress(pct)
      );
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.exportModal.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto"
    >
      <div className="faqqa-card w-full max-w-lg rounded-[24px] overflow-hidden my-auto">
        <div className="px-6 py-4 border-b-2 border-[#111111]/15 dark:border-white/15 flex items-center justify-between bg-[#FFE01B]/25 dark:bg-[#FFE01B]/10">
          <h2 className="font-display-comic text-lg font-black text-[#111111] dark:text-[#FFFDF9]">
            {t.exportModal.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close export dialog"
            className="p-1.5 rounded-xl border-2 border-transparent hover:border-[#111111] text-[#524E46] hover:text-[#111111] dark:hover:text-white cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-extrabold text-[#524E46] dark:text-slate-300 mb-2">
              {t.exportModal.format}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['png', 'jpg', 'webp', 'pdf', 'zip', 'cbz'] as ExportFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setFormat(fmt)}
                  className={`py-2 px-3 rounded-xl border-2 text-xs font-black uppercase cursor-pointer transition-all ${
                    format === fmt
                      ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'border-[#111111]/20 dark:border-white/20 text-[#333333] dark:text-slate-300'
                  }`}
                >
                  {fmt}
                </button>
              ))}
            </div>
          </div>

          {/* Page Selection Scope (All / Single Page / Custom Range) */}
          <div className="space-y-2">
            <label className="block text-xs font-extrabold text-[#524E46] dark:text-slate-300">
              {t.exportModal.pageSelection}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'all', label: `${t.exportModal.scopeAll} (${pages.length})` },
                  { id: 'current', label: `${t.exportModal.scopeCurrent} (#${currentPageNumber})` },
                  { id: 'range', label: t.exportModal.scopeRange },
                ] as const
              ).map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => setPageScope(sc.id)}
                  className={`py-1.5 px-2.5 rounded-xl border-2 text-xs font-extrabold cursor-pointer transition-all ${
                    pageScope === sc.id
                      ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'border-[#111111]/20 dark:border-white/20 text-[#333333] dark:text-slate-300'
                  }`}
                >
                  {sc.label}
                </button>
              ))}
            </div>
            {pageScope === 'range' && (
              <input
                type="text"
                dir="ltr"
                value={rangeText}
                onChange={(e) => setRangeText(e.target.value)}
                placeholder={t.exportModal.rangePlaceholder}
                aria-label={t.exportModal.scopeRange}
                className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
              />
            )}
          </div>

          {/* Reading Direction Order for PDF / Archive Export */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
              {t.exportModal.readingDirectionOrder}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'ltr', label: t.importModal.modeLtr },
                  { id: 'rtl', label: t.importModal.modeRtl },
                  { id: 'vertical', label: t.importModal.modeVertical },
                ] as const
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setExportDir(mode.id)}
                  className={`py-1.5 px-2 rounded-xl border-2 text-xs font-extrabold cursor-pointer ${
                    exportDir === mode.id
                      ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'border-[#111111]/20 dark:border-white/20 text-[#333333] dark:text-slate-300'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {exportDir === 'rtl' && (format === 'pdf' || format === 'zip' || format === 'cbz') && (
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={reverseSpreads}
                  onChange={(e) => setReverseSpreads(e.target.checked)}
                />
                <span>{t.exportModal.reverseSpreadsRtl}</span>
              </label>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
              {t.exportModal.content}
            </label>
            <div className="space-y-1.5">
              {(
                [
                  { id: 'translated', label: t.exportModal.onlyTranslated },
                  { id: 'original', label: t.exportModal.onlyOriginal },
                  { id: 'both', label: t.exportModal.both },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.id}
                  className="flex items-center gap-2.5 p-2 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer text-xs sm:text-sm"
                >
                  <input
                    type="radio"
                    name="exportContent"
                    checked={contentMode === opt.id}
                    onChange={() => setContentMode(opt.id)}
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {(format === 'zip' || format === 'cbz') && (
            <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={includeLayers}
                onChange={(e) => setIncludeLayers(e.target.checked)}
              />
              <span>{t.exportModal.includeLayers}</span>
            </label>
          )}

          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-slate-600 dark:text-slate-400">{t.exportModal.quality}</span>
              <span className="font-mono-tabular font-semibold">{Math.round(quality * 100)}%</span>
            </div>
            <input
              type="range"
              min="0.75"
              max="1"
              step="0.05"
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
              className="w-full"
            />
          </div>

          {exporting && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-extrabold text-[#111111] dark:text-[#FFE01B]">
                <span>{t.exportModal.exporting}</span>
                <span className="font-mono-tabular">{progress}%</span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-[#FAF5E8] dark:bg-[#111216] border border-[#111111]/30 overflow-hidden">
                <div className="h-full bg-[#FFE01B] transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {errorMsg && (
            <p className="text-xs font-bold text-[#EA3829]" role="alert">
              {errorMsg}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t-2 border-[#111111]/10 dark:border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border-2 border-[#111111]/25 dark:border-white/25 text-sm font-bold cursor-pointer"
            >
              {t.home.cancel}
            </button>
            <button
              type="button"
              disabled={exporting || pages.length === 0 || (pageScope === 'range' && (selectedPageNumbers?.length || 0) === 0)}
              onClick={handleExport}
              className="faqqa-btn-yellow inline-flex items-center gap-2 px-5 py-2 rounded-xl disabled:opacity-50 text-sm font-black cursor-pointer"
            >
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              <span>{t.exportModal.startExport}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
