import React, { useState } from 'react';
import {
  Check,
  Clipboard,
  Copy,
  HelpCircle,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  CleanMode,
  FontSettings,
  LanguageCode,
  Project,
  RegionType,
  SfxMode,
  TextRegion,
  TranslationStyle,
} from '../types/domain';
import { tFor } from '../i18n/translations';

interface BubbleInspectorProps {
  lang: LanguageCode;
  project: Project;
  region: TextRegion | null;
  availableFonts: string[];
  busyRegionAction: boolean;
  onUpdateRegion: (regionId: string, patch: Partial<TextRegion>) => void;
  onUpdateFont: (regionId: string, fontPatch: Partial<FontSettings>) => void;
  onRetranslateBubble: (
    regionId: string,
    style: TranslationStyle,
    instruction?: string
  ) => Promise<void>;
  onDeleteRegion: (regionId: string) => Promise<void>;
  onSaveStoryNotes: (notes: string) => Promise<void>;
}

export const BubbleInspector: React.FC<BubbleInspectorProps> = ({
  lang,
  project,
  region,
  availableFonts,
  busyRegionAction,
  onUpdateRegion,
  onUpdateFont,
  onRetranslateBubble,
  onDeleteRegion,
  onSaveStoryNotes,
}) => {
  const t = tFor(lang);
  const [activeTab, setActiveTab] = useState<'text' | 'style' | 'clean' | 'memory'>('text');
  const [styleChoice, setStyleChoice] = useState<TranslationStyle>(project.translationStyle);
  const [customInstruction, setCustomInstruction] = useState('');
  const [storyNotes, setStoryNotes] = useState(project.storyMemory.recurringNotes || '');
  const [copiedId, setCopiedId] = useState(false);

  const handleCopy = async (txt: string) => {
    try {
      await navigator.clipboard.writeText(txt);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      // Clipboard may be restricted in headless contexts
    }
  };

  const handlePaste = async () => {
    if (!region) return;
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) onUpdateRegion(region.id, { translatedText: txt });
    } catch {
      // Clipboard permission unavailable
    }
  };

  return (
    <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-s border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22] flex flex-col min-h-0">
      {/* Inspector Tabs */}
      <div className="grid grid-cols-4 border-b border-slate-200 dark:border-slate-800 text-xs font-medium">
        {(
          [
            { id: 'text', label: t.studio.inspector.tabText },
            { id: 'style', label: t.studio.inspector.tabStyle },
            { id: 'clean', label: t.studio.inspector.tabClean },
            { id: 'memory', label: t.studio.inspector.tabMemory },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`py-2.5 px-2 text-center border-b-2 truncate cursor-pointer transition-colors font-extrabold ${
              activeTab === tab.id
                ? 'border-[#111111] dark:border-[#FFE01B] text-[#111111] dark:text-[#FFE01B] bg-[#FFE01B]/30 dark:bg-[#FFE01B]/10'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {activeTab === 'memory' ? (
          <div className="space-y-3.5">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
              {t.studio.inspector.storyNotes}
            </label>
            <textarea
              rows={4}
              value={storyNotes}
              onChange={(e) => setStoryNotes(e.target.value)}
              className="w-full p-2.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
            />
            <button
              type="button"
              onClick={() => void onSaveStoryNotes(storyNotes)}
              className="faqqa-btn-yellow w-full py-2 rounded-xl text-xs font-black cursor-pointer"
            >
              {t.studio.inspector.saveMemory}
            </button>

            {project.storyMemory.characters.length > 0 && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                  {t.glossary.charactersMemory}
                </h3>
                {project.storyMemory.characters.map((ch) => (
                  <div
                    key={ch.id}
                    className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs space-y-0.5"
                  >
                    <div className="font-semibold text-slate-900 dark:text-white">
                      {ch.name} → {ch.translatedName}
                    </div>
                    {ch.speechStyle && (
                      <div className="text-slate-500 dark:text-slate-400">{ch.speechStyle}</div>
                    )}
                    {ch.relations && (
                      <div className="text-[11px] text-slate-400 dark:text-slate-500">{ch.relations}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {(project.storyMemory.locations?.length || 0) > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1">
                <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  {t.studio.locationsLabel}
                </h4>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {project.storyMemory.locations.join(' · ')}
                </p>
              </div>
            )}

            {(project.storyMemory.loreTerms?.length || 0) > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1">
                <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  {t.studio.loreTermsLabel}
                </h4>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {project.storyMemory.loreTerms!.join(' · ')}
                </p>
              </div>
            )}

            {(project.storyMemory.relationships?.length || 0) > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1">
                <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  {t.studio.relationshipsLabel}
                </h4>
                <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                  {project.storyMemory.relationships!.slice(-6).map((rel, i) => (
                    <li key={i}>• {rel}</li>
                  ))}
                </ul>
              </div>
            )}

            {(project.storyMemory.keyFacts?.length || 0) > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1">
                <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  {t.studio.keyFactsLabel}
                </h4>
                <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-300">
                  {project.storyMemory.keyFacts!.slice(-6).map((fact, i) => (
                    <li key={i}>• {fact}</li>
                  ))}
                </ul>
              </div>
            )}

            {(project.storyMemory.translationDecisions?.length || 0) > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1">
                <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  {t.studio.decisionsLabel}
                </h4>
                <div className="space-y-1 text-[11px]">
                  {project.storyMemory.translationDecisions!.slice(-8).map((d, i) => (
                    <div key={i} className="text-slate-600 dark:text-slate-300">
                      <span className="font-mono">{d.original}</span> → <strong>{d.translated}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {project.storyMemory.chapterSummaries.length > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 space-y-1">
                <h4 className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                  {t.studio.storyMemoryTitle}
                </h4>
                <ul className="space-y-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {project.storyMemory.chapterSummaries.slice(-4).map((sum, i) => (
                    <li key={i}>• {sum}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : !region ? (
          <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400 leading-relaxed px-4">
            {t.studio.inspector.noSelection}
          </div>
        ) : activeTab === 'text' ? (
          <div className="space-y-4">
            {/* Metadata row (unboxed inline typography) */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 pb-2 border-b border-slate-100 dark:border-slate-800">
              <span>
                #{region.readingOrder} · {region.sourceLanguage.toUpperCase()}
              </span>
              <span className="font-mono-tabular">
                {t.studio.inspector.confidence}: {Math.round(region.confidence * 100)}%
              </span>
            </div>

            {/* Region Type & Speaker */}
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {t.studio.inspector.regionType}
                </label>
                <select
                  value={region.regionType}
                  onChange={(e) =>
                    onUpdateRegion(region.id, { regionType: e.target.value as RegionType })
                  }
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                >
                  <option value="dialogue">{t.studio.inspector.types.dialogue}</option>
                  <option value="narration">{t.studio.inspector.types.narration}</option>
                  <option value="sfx">{t.studio.inspector.types.sfx}</option>
                  <option value="outside">{t.studio.inspector.types.outside}</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {t.studio.inspector.speaker}
                </label>
                <input
                  type="text"
                  value={region.speaker || ''}
                  onChange={(e) => onUpdateRegion(region.id, { speaker: e.target.value })}
                  className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                />
              </div>
            </div>

            {/* Original Text */}
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">
                {t.studio.inspector.originalText}
              </label>
              <textarea
                rows={2}
                value={region.originalText}
                onChange={(e) => onUpdateRegion(region.id, { originalText: e.target.value })}
                className="w-full p-2.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
              />
            </div>

            {/* Translated Text + Copy/Paste */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-slate-500">
                  {t.studio.inspector.translatedText}
                </label>
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => void handleCopy(region.translatedText)}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-[#EA3829] cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    <span>{copiedId ? '✓' : t.studio.inspector.copyText}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handlePaste()}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-[#EA3829] cursor-pointer"
                  >
                    <Clipboard className="w-3 h-3" />
                    <span>{t.studio.inspector.pasteText}</span>
                  </button>
                </div>
              </div>
              <textarea
                rows={3}
                dir={region.fontSettings.direction === 'rtl' ? 'rtl' : 'ltr'}
                value={region.translatedText}
                onChange={(e) => onUpdateRegion(region.id, { translatedText: e.target.value })}
                className="w-full p-2.5 text-sm font-medium rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-white dark:bg-[#0D1117] focus:ring-2 focus:ring-[#FFE01B] focus:outline-none"
              />
            </div>

            {/* Retranslate Bubble with Style & Custom Instruction */}
            <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#0D1117]/60 space-y-2">
              <select
                value={styleChoice}
                onChange={(e) => setStyleChoice(e.target.value as TranslationStyle)}
                aria-label={t.studio.inspector.translationStyle}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
              >
                {Object.entries(t.styles).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={customInstruction}
                onChange={(e) => setCustomInstruction(e.target.value)}
                placeholder={lang === 'ar' ? 'توجيه اختياري (مثال: اجعلها أقصر)...' : 'Optional note (e.g. shorter)...'}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
              />
              <button
                type="button"
                disabled={busyRegionAction}
                onClick={() =>
                  void onRetranslateBubble(region.id, styleChoice, customInstruction || undefined)
                }
                className="faqqa-btn-yellow w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl disabled:opacity-50 text-xs font-black cursor-pointer"
              >
                {busyRegionAction ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                <span>{t.studio.inspector.retranslateBubble}</span>
              </button>
            </div>

            {/* Clickable Alternative Suggestions */}
            {region.alternatives && region.alternatives.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-slate-500">
                  {t.studio.inspector.alternatives}
                </div>
                <div className="space-y-1.5">
                  {region.alternatives.map((alt, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => onUpdateRegion(region.id, { translatedText: alt })}
                      className="w-full text-start p-2 rounded-xl border-2 border-[#111111]/15 dark:border-slate-800 hover:border-[#111111] dark:hover:border-[#FFE01B] text-xs text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                    >
                      {alt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Approval & Delete */}
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onUpdateRegion(region.id, { approvalStatus: 'approved' })}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                    region.approvalStatus === 'approved'
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{t.studio.inspector.approve}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onUpdateRegion(region.id, { approvalStatus: 'needs_review' })}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                    region.approvalStatus === 'needs_review'
                      ? 'bg-amber-600 text-white border-amber-600'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  <span>{t.studio.inspector.needsReview}</span>
                </button>
              </div>
              <button
                type="button"
                aria-label={t.studio.inspector.deleteBubble}
                onClick={() => void onDeleteRegion(region.id)}
                className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : activeTab === 'style' ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">
                {t.studio.inspector.fontFamily}
              </label>
              <select
                value={region.fontSettings.fontFamily}
                onChange={(e) => onUpdateFont(region.id, { fontFamily: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
              >
                {availableFonts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={region.fontSettings.autoFit}
                  onChange={(e) => onUpdateFont(region.id, { autoFit: e.target.checked })}
                />
                <span>{t.studio.inspector.autoFit}</span>
              </label>
              <input
                type="color"
                aria-label={t.studio.inspector.textColor}
                value={region.fontSettings.color}
                onChange={(e) => onUpdateFont(region.id, { color: e.target.value })}
                className="w-8 h-7 rounded border border-slate-300 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-500">{t.studio.inspector.fontSize}</span>
                <span className="font-mono-tabular">{region.fontSettings.fontSize}px</span>
              </div>
              <input
                type="range"
                min="10"
                max="42"
                value={region.fontSettings.fontSize}
                onChange={(e) => onUpdateFont(region.id, { fontSize: Number(e.target.value) })}
                className="w-full"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {t.studio.inspector.align}
                </label>
                <select
                  value={region.fontSettings.align}
                  onChange={(e) =>
                    onUpdateFont(region.id, {
                      align: e.target.value as FontSettings['align'],
                    })
                  }
                  className="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                >
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                  <option value="left">Left</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {t.studio.inspector.direction}
                </label>
                <select
                  value={region.fontSettings.direction}
                  onChange={(e) =>
                    onUpdateFont(region.id, {
                      direction: e.target.value as FontSettings['direction'],
                    })
                  }
                  className="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                >
                  <option value="rtl">RTL (العربية)</option>
                  <option value="ltr">LTR (Comic EN)</option>
                  <option value="vertical">Vertical (縦書き)</option>
                </select>
              </div>
            </div>

            <details className="pt-2 border-t border-slate-200 dark:border-slate-800 group">
              <summary className="list-none flex items-center justify-between text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer py-1 select-none hover:text-slate-900 dark:hover:text-white">
                <span>{t.studio.inspector.advancedStyle}</span>
                <span className="text-[11px] text-slate-400 group-open:rotate-180 transition-transform">▾</span>
              </summary>
              <div className="pt-3 space-y-3.5">
                <label className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-200 cursor-pointer">
                  <span>{t.studio.inspector.letterCaseUppercase}</span>
                  <input
                    type="checkbox"
                    checked={region.fontSettings.letterCase === 'uppercase'}
                    onChange={(e) =>
                      onUpdateFont(region.id, {
                        letterCase: e.target.checked ? 'uppercase' : 'normal',
                      })
                    }
                  />
                </label>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">{t.studio.inspector.lineHeight}</span>
                    <span className="font-mono-tabular">{region.fontSettings.lineHeight}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="2"
                    step="0.05"
                    value={region.fontSettings.lineHeight}
                    onChange={(e) => onUpdateFont(region.id, { lineHeight: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">{t.studio.inspector.padding}</span>
                    <span className="font-mono-tabular">{region.fontSettings.padding}%</span>
                  </div>
                  <input
                    type="range"
                    min="4"
                    max="30"
                    value={region.fontSettings.padding}
                    onChange={(e) => onUpdateFont(region.id, { padding: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">{t.studio.inspector.rotation}</span>
                    <span className="font-mono-tabular">{region.fontSettings.rotation}°</span>
                  </div>
                  <input
                    type="range"
                    min="-45"
                    max="45"
                    value={region.fontSettings.rotation}
                    onChange={(e) => onUpdateFont(region.id, { rotation: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                      <span>{t.studio.inspector.offsetX}</span>
                      <span className="font-mono-tabular">{region.fontSettings.offsetX}</span>
                    </div>
                    <input
                      type="range"
                      min="-60"
                      max="60"
                      value={region.fontSettings.offsetX}
                      onChange={(e) => onUpdateFont(region.id, { offsetX: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                      <span>{t.studio.inspector.offsetY}</span>
                      <span className="font-mono-tabular">{region.fontSettings.offsetY}</span>
                    </div>
                    <input
                      type="range"
                      min="-60"
                      max="60"
                      value={region.fontSettings.offsetY}
                      onChange={(e) => onUpdateFont(region.id, { offsetY: Number(e.target.value) })}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
            </details>
          </div>
        ) : (
          /* Cleaning & SFX Tab */
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">
                {t.studio.inspector.cleanMode}
              </label>
              <div className="space-y-2">
                {(
                  [
                    { id: 'auto', label: t.studio.inspector.cleanAuto },
                    { id: 'manual', label: t.studio.inspector.cleanManual },
                    { id: 'keep', label: t.studio.inspector.cleanKeep },
                  ] as const
                ).map((mode) => (
                  <label
                    key={mode.id}
                    className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 text-xs cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="cleanMode"
                      checked={region.cleanMode === mode.id}
                      onChange={() =>
                        onUpdateRegion(region.id, { cleanMode: mode.id as CleanMode })
                      }
                    />
                    <span>{mode.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-2">
                {t.studio.inspector.sfxMode}
              </label>
              <select
                value={region.sfxMode}
                onChange={(e) =>
                  onUpdateRegion(region.id, { sfxMode: e.target.value as SfxMode })
                }
                className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
              >
                <option value="keep">{t.studio.inspector.sfxKeep}</option>
                <option value="side">{t.studio.inspector.sfxSide}</option>
                <option value="replace">{t.studio.inspector.sfxReplace}</option>
                <option value="artistic">{t.studio.inspector.sfxArtistic}</option>
                <option value="ignore">{t.studio.inspector.sfxIgnore}</option>
              </select>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
