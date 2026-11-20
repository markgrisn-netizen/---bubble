import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  DownloadCloud,
  Eye,
  EyeOff,
  Infinity as InfinityIcon,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  ScrollText,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AiSettings,
  Chapter,
  LanguageCode,
  Page,
  Project,
  TextRegion,
} from '../types/domain';
import { tFor } from '../i18n/translations';
import { api } from '../utils/api';
import { renderCompositePageToCanvas } from '../utils/inpainting';
import { computeContainRect } from '../utils/coordinateTransform';
import {
  getOfflineChapter,
  listOfflineChapters,
  removeOfflineChapter,
  saveChapterRecoverySnapshot,
  updateOfflineChapterLastReadPage,
} from '../utils/offlineDb';
import { verifyAndRecoverPageAsset } from '../utils/assetRecovery';
import { useAppLifecycle } from '../utils/appLifecycle';
import {
  getOfflineDownloadTasks,
  startChapterOfflineDownload,
  subscribeOfflineDownloads,
  type OfflineDownloadTask,
} from '../utils/offlineDownloadManager';
import {
  computeCurrentPageFromScroll,
  computeReaderPageFrameSize,
  computeReadingProgressPercent,
  computeRenderWindow,
  DEFAULT_READER_PREFERENCES,
  getNextInfiniteVisibleCount,
  getPageSpacingPx,
  isLightBackgroundHex,
  normalizeReaderPreferences,
  READER_BACKGROUND_SWATCHES,
  READER_PREFS_STORAGE_KEY,
  type PageSpacingPreset,
  type PageViewportSpan,
  type PageWidthMode,
  type ReaderMode,
  type ReaderPreferences,
} from '../utils/readerUtils';

interface ChapterReaderProps {
  lang: LanguageCode;
  chapterId: string;
  inpaintingEngine: AiSettings['inpaintingEngine'];
  onBackToStudio: () => void;
}

interface StreamItem {
  key: string;
  streamIndex: number;
  page: Page;
  chapter: Chapter;
  isFirstOfExtraChapter: boolean;
}

const POSITION_STORAGE_PREFIX = 'faqqa_reader_pos_v1_';

function loadSavedReaderPrefs(): ReaderPreferences {
  try {
    const raw = localStorage.getItem(READER_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_READER_PREFERENCES;
    return normalizeReaderPreferences(JSON.parse(raw) as Partial<ReaderPreferences>);
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
}

function loadSavedChapterPosition(chapterId: string): number | null {
  try {
    const raw = localStorage.getItem(`${POSITION_STORAGE_PREFIX}${chapterId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pageIndex?: number };
    if (typeof parsed.pageIndex === 'number' && parsed.pageIndex >= 0) {
      return Math.floor(parsed.pageIndex);
    }
    return null;
  } catch {
    return null;
  }
}

function persistChapterPosition(chapterId: string, pageIndex: number): void {
  try {
    localStorage.setItem(
      `${POSITION_STORAGE_PREFIX}${chapterId}`,
      JSON.stringify({ pageIndex, updatedAt: Date.now() })
    );
  } catch {
    // Ignore storage quota errors
  }
}

interface ReaderPageSlotProps {
  item: StreamItem;
  showOriginal: boolean;
  inpaintingEngine: AiSettings['inpaintingEngine'];
  prefs: ReaderPreferences;
  zoom: number;
  viewportSize: { w: number; h: number };
  inRenderWindow: boolean;
  isLightBg: boolean;
  registerSlotRef: (streamIndex: number, el: HTMLDivElement | null) => void;
  onSelectBubble: (region: TextRegion | null) => void;
  onShowTranslated?: () => void;
  t: ReturnType<typeof tFor>;
}

const ReaderPageSlot: React.FC<ReaderPageSlotProps> = React.memo(
  ({
    item,
    showOriginal,
    inpaintingEngine,
    prefs,
    zoom,
    viewportSize,
    inRenderWindow,
    isLightBg,
    registerSlotRef,
    onSelectBubble,
    onShowTranslated,
    t,
  }) => {
    const { page, streamIndex } = item;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const [naturalSize, setNaturalSize] = useState({
      w: page.width || 900,
      h: page.height || 1200,
    });
    const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
    const [retryNonce, setRetryNonce] = useState(0);
    const [recoveredDataUrl, setRecoveredDataUrl] = useState<string | null>(null);
    const recoveryTriedRef = useRef(false);
    const [thumbUrl, setThumbUrl] = useState<string | null>(null);
    const thumbCapturedRef = useRef(false);

    useEffect(() => {
      recoveryTriedRef.current = false;
      setRecoveredDataUrl(null);
    }, [page.id, page.originalImage]);

    const effectivePage = useMemo(
      () =>
        recoveredDataUrl
          ? { ...page, originalImage: recoveredDataUrl, assetMissing: false }
          : page,
      [page, recoveredDataUrl]
    );

    const attemptLocalAssetRecovery = useCallback(async (): Promise<boolean> => {
      if (recoveryTriedRef.current) return false;
      recoveryTriedRef.current = true;
      try {
        const res = await verifyAndRecoverPageAsset(page, { forceProbe: true });
        if (res.recovered && (res.dataUrl || res.page.originalImage)) {
          setRecoveredDataUrl(res.dataUrl || res.page.originalImage);
          setStatus('loading');
          setRetryNonce((n) => n + 1);
          return true;
        }
      } catch {
        // Fall through to per-page isolated error UI
      }
      return false;
    }, [page]);

    const hasBakedComposite =
      !showOriginal && Boolean(page.processedImage && page.processedImage.startsWith('data:'));
    const missingOriginalOffline = showOriginal && !effectivePage.originalImage;
    const needsCompositeCanvas =
      !showOriginal &&
      !hasBakedComposite &&
      (page.regions.length > 0 ||
        (page.manualStrokes?.length || 0) > 0 ||
        (page.rotation || 0) !== 0);

    // Sync natural dimensions if page prop updates
    useEffect(() => {
      if (page.width > 0 && page.height > 0) {
        setNaturalSize((prev) =>
          prev.w === page.width && prev.h === page.height
            ? prev
            : { w: page.width, h: page.height }
        );
      }
    }, [page.width, page.height]);

    // Composite canvas rendering (translated bubbles, manual strokes, rotation)
    useEffect(() => {
      if (!inRenderWindow || !needsCompositeCanvas) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      let cancelled = false;
      setStatus('loading');

      void renderCompositePageToCanvas(canvas, effectivePage, {
        showOriginalOnly: showOriginal,
        showText: !showOriginal,
        inpaintingEngine,
      })
        .then(() => {
          if (cancelled || !canvas) return;
          if (canvas.width > 0 && canvas.height > 0) {
            setNaturalSize({ w: canvas.width, h: canvas.height });
            // Capture lightweight 160px thumbnail once for instant re-entry after LRU eviction
            if (!thumbCapturedRef.current) {
              try {
                const targetW = 160;
                const targetH = Math.max(
                  1,
                  Math.round((canvas.height / canvas.width) * targetW)
                );
                const thumbCanvas = document.createElement('canvas');
                thumbCanvas.width = targetW;
                thumbCanvas.height = targetH;
                const tCtx = thumbCanvas.getContext('2d');
                if (tCtx) {
                  tCtx.drawImage(canvas, 0, 0, targetW, targetH);
                  thumbCapturedRef.current = true;
                  setThumbUrl(thumbCanvas.toDataURL('image/jpeg', 0.55));
                }
              } catch {
                // Ignore tainted canvas thumbnail extraction failures
              }
            }
          }
          setStatus('loaded');
        })
        .catch(async () => {
          const recovered = await attemptLocalAssetRecovery();
          if (!recovered && !cancelled) {
            setStatus('error');
          }
        });

      return () => {
        cancelled = true;
      };
    }, [
      inRenderWindow,
      needsCompositeCanvas,
      effectivePage,
      showOriginal,
      inpaintingEngine,
      retryNonce,
      attemptLocalAssetRecovery,
    ]);

    // Original/unmodified or pre-rendered offline composite image check on remount
    useLayoutEffect(() => {
      if (!inRenderWindow || needsCompositeCanvas) return;
      if (missingOriginalOffline) {
        setStatus('loaded');
        return;
      }
      const imgEl = imgRef.current;
      if (!imgEl) {
        setStatus('loading');
        return;
      }
      if (imgEl.complete) {
        if (imgEl.naturalWidth > 0) {
          setNaturalSize({ w: imgEl.naturalWidth, h: imgEl.naturalHeight });
          setStatus('loaded');
        } else {
          setStatus('error');
        }
      } else {
        setStatus('loading');
      }
    }, [
      inRenderWindow,
      needsCompositeCanvas,
      missingOriginalOffline,
      hasBakedComposite,
      page.processedImage,
      effectivePage.originalImage,
      retryNonce,
    ]);

    const frame = computeReaderPageFrameSize({
      naturalWidth: naturalSize.w,
      naturalHeight: naturalSize.h,
      viewportWidth: viewportSize.w,
      viewportHeight: viewportSize.h,
      pageWidthMode: prefs.pageWidth,
      zoom,
    });

    const contain = computeContainRect(
      naturalSize.w,
      naturalSize.h,
      frame.width,
      frame.height
    );

    const handleBindRef = useCallback(
      (node: HTMLDivElement | null) => {
        registerSlotRef(streamIndex, node);
      },
      [registerSlotRef, streamIndex]
    );

    const slotBgClass =
      status === 'loaded'
        ? 'bg-transparent'
        : isLightBg
        ? 'bg-black/5'
        : 'bg-white/[0.04]';

    return (
      <div
        ref={handleBindRef}
        dir="ltr"
        data-testid="reader-page-frame"
        data-page-index={streamIndex}
        data-page-number={page.pageNumber}
        style={{
          width: `${frame.width}px`,
          height: `${frame.height}px`,
          maxWidth: zoom <= 1.01 ? '100%' : undefined,
          filter:
            prefs.brightness !== 100
              ? `brightness(${prefs.brightness / 100})`
              : undefined,
        }}
        className={`relative shrink-0 overflow-hidden select-none mx-auto ${slotBgClass}`}
      >
        {!inRenderWindow && status !== 'error' ? (
          // Evicted far-off page placeholder keeping exact aspect-ratio height
          <div className="w-full h-full relative flex items-center justify-center">
            {thumbUrl && (
              <img
                src={thumbUrl}
                alt=""
                aria-hidden="true"
                className="w-full h-full object-contain blur-[2px] opacity-60"
              />
            )}
            <span
              className={`absolute px-2.5 py-1 rounded-md text-xs font-mono-tabular ${
                isLightBg
                  ? 'bg-black/10 text-black/60'
                  : 'bg-black/50 text-white/60'
              }`}
            >
              {page.pageNumber}
            </span>
          </div>
        ) : status === 'error' ? (
          // Isolated per-page error card — never blocks neighboring pages
          <div
            data-testid={`page-error-${page.pageNumber}`}
            className={`w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center border ${
              isLightBg
                ? 'bg-red-50/90 border-red-200 text-red-900'
                : 'bg-rose-950/40 border-rose-500/30 text-rose-100'
            }`}
          >
            <AlertTriangle className="w-8 h-8 text-rose-500" />
            <div className="space-y-1">
              <div className="text-sm font-bold">
                {t.reader.loadError} (#{page.pageNumber})
              </div>
            </div>
            <button
              type="button"
              data-testid={`retry-page-${page.pageNumber}`}
              onClick={() => {
                setStatus('loading');
                setRetryNonce((n) => n + 1);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#FFE01B] text-[#111216] text-xs font-bold hover:brightness-95 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t.reader.retryPage}</span>
            </button>
          </div>
        ) : (
          <>
            {missingOriginalOffline ? (
              <div
                className={`w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center border ${
                  isLightBg
                    ? 'bg-amber-50 border-amber-200 text-amber-950'
                    : 'bg-slate-900/90 border-slate-700 text-slate-200'
                }`}
              >
                <CloudOff className="w-7 h-7 text-amber-400" />
                <p className="text-xs sm:text-sm font-semibold max-w-xs">
                  {t.reader.missingOriginalsOfflineNote}
                </p>
                {onShowTranslated && (
                  <button
                    type="button"
                    onClick={onShowTranslated}
                    className="px-3.5 py-2 rounded-lg bg-[#FFE01B] text-[#111216] text-xs font-black cursor-pointer"
                  >
                    {t.reader.returnToTranslated}
                  </button>
                )}
              </div>
            ) : needsCompositeCanvas ? (
              <canvas
                ref={canvasRef}
                data-testid={`page-canvas-${page.pageNumber}`}
                className={`w-full h-full block object-contain ${
                  status === 'loaded' ? 'visible' : 'invisible'
                }`}
              />
            ) : (
              <img
                ref={imgRef}
                key={`${page.id}-${retryNonce}-${recoveredDataUrl ? 'rec' : 'raw'}-${showOriginal ? 'orig' : hasBakedComposite ? 'baked' : 'tr'}`}
                src={hasBakedComposite ? page.processedImage! : effectivePage.originalImage}
                alt={`Page ${page.pageNumber}`}
                decoding="async"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                    setNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
                  }
                  setStatus('loaded');
                }}
                onError={async () => {
                  const recovered = await attemptLocalAssetRecovery();
                  if (!recovered) {
                    setStatus('error');
                  }
                }}
                className={`w-full h-full block object-contain ${
                  status === 'loaded' ? 'visible' : 'invisible'
                }`}
              />
            )}

            {/* Loading shimmer & subtle spinner overlay */}
            {(status === 'loading' || status === 'idle') && !missingOriginalOffline && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
                <Loader2
                  className={`w-6 h-6 animate-spin ${
                    isLightBg ? 'text-black/50' : 'text-white/60'
                  }`}
                />
                <span
                  className={`text-[11px] font-mono-tabular ${
                    isLightBg ? 'text-black/50' : 'text-white/50'
                  }`}
                >
                  {t.reader.pageCounterOf} {page.pageNumber}
                </span>
              </div>
            )}

            {/* Bubble tap hotspots pinned accurately over translated text boxes */}
            {!showOriginal && status === 'loaded' && page.regions.length > 0 && (
              <div
                style={{
                  left: `${contain.offsetX}px`,
                  top: `${contain.offsetY}px`,
                  width: `${contain.contentWidth}px`,
                  height: `${contain.contentHeight}px`,
                }}
                className="absolute pointer-events-none"
              >
                {page.regions.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-label={`Inspect original text for bubble ${r.readingOrder}`}
                    onClick={() => onSelectBubble(r)}
                    style={{
                      left: `${(r.boundingBox.x / 1000) * 100}%`,
                      top: `${(r.boundingBox.y / 1000) * 100}%`,
                      width: `${(r.boundingBox.width / 1000) * 100}%`,
                      height: `${(r.boundingBox.height / 1000) * 100}%`,
                    }}
                    className="absolute pointer-events-auto bg-transparent rounded cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFE01B]"
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }
);

export const ChapterReader: React.FC<ChapterReaderProps> = ({
  lang,
  chapterId,
  inpaintingEngine,
  onBackToStudio,
}) => {
  const t = tFor(lang);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const infiniteSentinelRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const visibleIndicesRef = useRef<Set<number>>(new Set([0, 1, 2]));
  const observerRef = useRef<IntersectionObserver | null>(null);
  const patchTimerRef = useRef<number | null>(null);
  const initialRestoredForChapterRef = useRef<string | null>(null);
  const programmaticJumpUntilRef = useRef<number>(0);

  const [viewportSize, setViewportSize] = useState({ w: 960, h: 720 });
  const [activeChapterId, setActiveChapterId] = useState(chapterId);
  const [project, setProject] = useState<Project | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [projectChapters, setProjectChapters] = useState<Chapter[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [extraChapters, setExtraChapters] = useState<Array<{ chapter: Chapter; pages: Page[] }>>([]);
  const [loadingExtraChapter, setLoadingExtraChapter] = useState(false);

  const [prefs, setPrefs] = useState<ReaderPreferences>(() => loadSavedReaderPrefs());
  const [infiniteVisibleCount, setInfiniteVisibleCount] = useState(8);
  const [renderWindow, setRenderWindow] = useState<{ start: number; end: number }>({
    start: 0,
    end: 7,
  });

  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const [progressPct, setProgressPct] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toolbarHidden, setToolbarHidden] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState('1');

  const [isOfflineSaved, setIsOfflineSaved] = useState(false);
  const [loadedFromOffline, setLoadedFromOffline] = useState(false);
  const [confirmRemoveOfflineOpen, setConfirmRemoveOfflineOpen] = useState(false);
  const [activeOfflineTask, setActiveOfflineTask] = useState<OfflineDownloadTask | null>(null);
  const [inspectedRegion, setInspectedRegion] = useState<TextRegion | null>(null);

  // Sync external chapterId prop
  useEffect(() => {
    setActiveChapterId(chapterId);
  }, [chapterId]);

  // Persist reader preferences whenever changed
  useEffect(() => {
    try {
      localStorage.setItem(READER_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage failures
    }
  }, [prefs]);

  // Measure actual scroll clientWidth / clientHeight (avoids scrollbar overflow on mobile & desktop)
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setViewportSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [toolbarHidden]);

  // Subscribe to download manager task for active chapter
  useEffect(() => {
    const syncTask = () => {
      const task =
        getOfflineDownloadTasks().find((dt) => dt.taskId === `ch:${activeChapterId}`) || null;
      setActiveOfflineTask(task);
      if (task?.status === 'completed') {
        setIsOfflineSaved(true);
      }
    };
    syncTask();
    return subscribeOfflineDownloads(syncTask);
  }, [activeChapterId]);

  // Load chapter + sibling chapters (with full offline IndexedDB fallback)
  useEffect(() => {
    let cancelled = false;
    initialRestoredForChapterRef.current = null;
    setExtraChapters([]);
    setInfiniteVisibleCount(8);
    visibleIndicesRef.current = new Set([0, 1, 2]);
    setRenderWindow({ start: 0, end: 7 });

    const loadOfflineSiblings = async (projId: string) => {
      const allOff = await listOfflineChapters();
      if (cancelled) return;
      const siblings = allOff
        .filter((b) => (b.projectId || b.project.id) === projId)
        .map((b) => b.chapter)
        .sort((a, b) => a.chapterNumber - b.chapterNumber);
      if (siblings.length > 0) {
        setProjectChapters(siblings);
      }
    };

    async function load() {
      const offline = await getOfflineChapter(activeChapterId).catch(() => null);
      if (offline && !cancelled) {
        setIsOfflineSaved(true);
      } else if (!cancelled) {
        setIsOfflineSaved(false);
      }

      try {
        const res = await api.getChapter(activeChapterId);
        if (cancelled) return;
        setProject(res.project);
        setChapter(res.chapter);
        setPages(res.pages);
        setLoadedFromOffline(false);

        const localIdx = loadSavedChapterPosition(activeChapterId);
        const startIdx = Math.max(
          0,
          Math.min(
            Math.max(0, res.pages.length - 1),
            localIdx !== null
              ? localIdx
              : ((offline?.lastReadPage ?? res.chapter.lastReadPage ?? 1) - 1)
          )
        );
        setCurrentPageIdx(startIdx);
        setJumpInput(String(startIdx + 1));
        if (startIdx >= 6) {
          setInfiniteVisibleCount(startIdx + 6);
        }

        // Load sibling chapters for seamless Infinite next-chapter streaming & chapter selector
        api
          .getProject(res.project.id)
          .then((projData) => {
            if (!cancelled) {
              const sorted = [...projData.chapters].sort(
                (a, b) => a.chapterNumber - b.chapterNumber
              );
              setProjectChapters(sorted);
            }
          })
          .catch(() => {
            void loadOfflineSiblings(res.project.id);
          });
      } catch {
        if (offline && !cancelled) {
          setProject(offline.project);
          setChapter(offline.chapter);
          setPages(offline.pages);
          setLoadedFromOffline(true);
          const localIdx = loadSavedChapterPosition(activeChapterId);
          const offlineSavedPage = offline.lastReadPage ?? offline.chapter.lastReadPage ?? 1;
          const startIdx = Math.max(
            0,
            Math.min(
              Math.max(0, offline.pages.length - 1),
              localIdx !== null ? localIdx : offlineSavedPage - 1
            )
          );
          setCurrentPageIdx(startIdx);
          setJumpInput(String(startIdx + 1));
          if (startIdx >= 6) {
            setInfiniteVisibleCount(startIdx + 6);
          }
          await loadOfflineSiblings(offline.project.id);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeChapterId]);

  useAppLifecycle({
    onHide: () => {
      if (!chapter) return;
      persistChapterPosition(chapter.id, currentPageIdx);
      void updateOfflineChapterLastReadPage(chapter.id, currentPageIdx + 1);
      if (project) {
        void saveChapterRecoverySnapshot({
          chapterId: chapter.id,
          projectId: project.id,
          project,
          chapter,
          pages,
          activeJob: null,
          lastUpdatedAt: new Date().toISOString(),
        });
      }
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        void api.updateChapter(chapter.id, { lastReadPage: currentPageIdx + 1 }).catch(() => {});
      }
    },
    onResume: async () => {
      if (!activeChapterId) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      try {
        const res = await api.getChapter(activeChapterId);
        setProject(res.project);
        setChapter(res.chapter);
        setPages(res.pages);
      } catch {
        // Keep current/offline pages seamlessly if network unavailable
      }
    },
  });

  // Build stream items according to active reading mode
  const allLoadedStreamItems: StreamItem[] = useMemo(() => {
    if (!chapter) return [];
    const items: StreamItem[] = pages.map((page, idx) => ({
      key: `${chapter.id}-${page.id}`,
      streamIndex: idx,
      page,
      chapter,
      isFirstOfExtraChapter: false,
    }));

    if (prefs.mode === 'infinite') {
      for (const extra of extraChapters) {
        extra.pages.forEach((page, pIdx) => {
          const idx = items.length;
          items.push({
            key: `${extra.chapter.id}-${page.id}`,
            streamIndex: idx,
            page,
            chapter: extra.chapter,
            isFirstOfExtraChapter: pIdx === 0,
          });
        });
      }
    }
    return items;
  }, [chapter, pages, prefs.mode, extraChapters]);

  const displayedStreamItems: StreamItem[] = useMemo(() => {
    if (prefs.mode === 'infinite') {
      return allLoadedStreamItems.slice(0, infiniteVisibleCount);
    }
    return allLoadedStreamItems;
  }, [allLoadedStreamItems, prefs.mode, infiniteVisibleCount]);

  // Helper to get next un-appended chapter in project for Infinite mode
  const nextAvailableChapter = useMemo(() => {
    if (!chapter || projectChapters.length === 0) return null;
    const loadedIds = new Set([chapter.id, ...extraChapters.map((e) => e.chapter.id)]);
    const currentIdx = projectChapters.findIndex((c) => c.id === chapter.id);
    if (currentIdx === -1) return null;
    for (let i = currentIdx + 1; i < projectChapters.length; i++) {
      if (!loadedIds.has(projectChapters[i].id)) {
        return projectChapters[i];
      }
    }
    return null;
  }, [chapter, projectChapters, extraChapters]);

  const fetchNextChapterIfNeeded = useCallback(async () => {
    if (prefs.mode !== 'infinite' || !nextAvailableChapter || loadingExtraChapter) return;
    setLoadingExtraChapter(true);
    try {
      const res = await api.getChapter(nextAvailableChapter.id);
      setExtraChapters((prev) => {
        if (prev.some((x) => x.chapter.id === res.chapter.id)) return prev;
        return [...prev, { chapter: res.chapter, pages: res.pages }];
      });
    } catch {
      const offlineNext = await getOfflineChapter(nextAvailableChapter.id).catch(() => null);
      if (offlineNext) {
        setExtraChapters((prev) => {
          if (prev.some((x) => x.chapter.id === offlineNext.chapter.id)) return prev;
          return [...prev, { chapter: offlineNext.chapter, pages: offlineNext.pages }];
        });
      }
    } finally {
      setLoadingExtraChapter(false);
    }
  }, [prefs.mode, nextAvailableChapter, loadingExtraChapter]);

  // Setup shared IntersectionObserver for lazy-loading & active canvas window eviction
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || prefs.mode === 'paginated') return;

    const total = displayedStreamItems.length;
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const rawIdx = (entry.target as HTMLElement).dataset.pageIndex;
          const idx = rawIdx !== undefined ? Number(rawIdx) : NaN;
          if (!Number.isFinite(idx)) continue;
          if (entry.isIntersecting) {
            if (!visibleIndicesRef.current.has(idx)) {
              visibleIndicesRef.current.add(idx);
              changed = true;
            }
          } else if (visibleIndicesRef.current.has(idx)) {
            visibleIndicesRef.current.delete(idx);
            changed = true;
          }
        }
        if (changed) {
          const nextWin = computeRenderWindow(
            Array.from(visibleIndicesRef.current),
            total,
            5
          );
          setRenderWindow((prev) =>
            prev.start === nextWin.start && prev.end === nextWin.end ? prev : nextWin
          );
        }
      },
      {
        root: vp,
        rootMargin: '1200px 0px 1200px 0px',
        threshold: 0.01,
      }
    );

    observerRef.current = io;
    for (const el of slotRefs.current.values()) {
      io.observe(el);
    }

    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [prefs.mode, displayedStreamItems.length]);

  const registerSlotRef = useCallback((streamIndex: number, el: HTMLDivElement | null) => {
    const existing = slotRefs.current.get(streamIndex);
    if (existing && observerRef.current) {
      observerRef.current.unobserve(existing);
    }
    if (el) {
      slotRefs.current.set(streamIndex, el);
      if (observerRef.current) {
        observerRef.current.observe(el);
      }
    } else {
      slotRefs.current.delete(streamIndex);
    }
  }, []);

  // Infinite mode progressive batch loader & next-chapter sentinel
  useEffect(() => {
    const vp = viewportRef.current;
    const sentinel = infiniteSentinelRef.current;
    if (!vp || !sentinel || prefs.mode !== 'infinite') return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setInfiniteVisibleCount((curr) =>
          getNextInfiniteVisibleCount(curr, allLoadedStreamItems.length, 8)
        );
        if (infiniteVisibleCount + 8 >= allLoadedStreamItems.length) {
          void fetchNextChapterIfNeeded();
        }
      },
      {
        root: vp,
        rootMargin: '800px 0px',
      }
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [
    prefs.mode,
    allLoadedStreamItems.length,
    infiniteVisibleCount,
    fetchNextChapterIfNeeded,
  ]);

  // Schedule debounced local IndexedDB + backend persistence for lastReadPage
  const schedulePositionSave = useCallback(
    (chapId: string, pageIdx: number, immediateOffline = false) => {
      persistChapterPosition(chapId, pageIdx);
      if (immediateOffline) {
        void updateOfflineChapterLastReadPage(chapId, pageIdx + 1);
      }
      if (patchTimerRef.current !== null) {
        window.clearTimeout(patchTimerRef.current);
      }
      patchTimerRef.current = window.setTimeout(() => {
        void updateOfflineChapterLastReadPage(chapId, pageIdx + 1);
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
          void api.updateChapter(chapId, { lastReadPage: pageIdx + 1 }).catch(() => {});
        }
      }, immediateOffline ? 80 : 300);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (patchTimerRef.current !== null) {
        window.clearTimeout(patchTimerRef.current);
      }
    };
  }, []);

  // Scroll to a specific stream page index accurately
  const scrollToStreamPage = useCallback(
    (targetIdx: number, behavior: ScrollBehavior = 'smooth') => {
      const clamped = Math.max(0, Math.min(Math.max(0, pages.length - 1), targetIdx));
      setCurrentPageIdx(clamped);
      setJumpInput(String(clamped + 1));
      setProgressPct(
        computeReadingProgressPercent(
          0,
          0,
          0,
          clamped,
          pages.length,
          prefs.mode === 'paginated' ? 'paginated' : 'web'
        )
      );
      if (chapter) {
        schedulePositionSave(chapter.id, clamped, true);
      }

      if (prefs.mode === 'paginated') {
        return;
      }

      if (prefs.mode === 'infinite' && clamped >= infiniteVisibleCount) {
        setInfiniteVisibleCount(clamped + 6);
      }

      programmaticJumpUntilRef.current = Date.now() + (behavior === 'smooth' ? 850 : 250);
      requestAnimationFrame(() => {
        const vp = viewportRef.current;
        const targetEl = slotRefs.current.get(clamped);
        if (vp && targetEl) {
          const vpRect = vp.getBoundingClientRect();
          const elRect = targetEl.getBoundingClientRect();
          const nextTop = Math.max(0, vp.scrollTop + (elRect.top - vpRect.top));
          vp.scrollTo({ top: nextTop, behavior });
        }
      });
    },
    [pages.length, prefs.mode, chapter, infiniteVisibleCount, schedulePositionSave]
  );

  // Restore saved reading position once chapter & viewport mount
  useEffect(() => {
    if (!chapter || pages.length === 0 || viewportSize.w <= 0) return;
    if (initialRestoredForChapterRef.current === chapter.id) return;
    initialRestoredForChapterRef.current = chapter.id;

    const localIdx = loadSavedChapterPosition(chapter.id);
    const targetIdx = Math.max(
      0,
      Math.min(
        pages.length - 1,
        localIdx !== null ? localIdx : (chapter.lastReadPage || 1) - 1
      )
    );

    if (targetIdx > 0 && prefs.mode !== 'paginated') {
      programmaticJumpUntilRef.current = Date.now() + 300;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const vp = viewportRef.current;
          const slot = slotRefs.current.get(targetIdx);
          if (vp && slot) {
            const vpRect = vp.getBoundingClientRect();
            const elRect = slot.getBoundingClientRect();
            vp.scrollTo({
              top: Math.max(0, vp.scrollTop + (elRect.top - vpRect.top)),
              behavior: 'auto',
            });
          }
        });
      });
    } else if (prefs.mode === 'paginated') {
      setProgressPct(
        computeReadingProgressPercent(0, 0, 0, targetIdx, pages.length, 'paginated')
      );
    }
  }, [chapter, pages.length, viewportSize.w, prefs.mode]);

  // Track scroll position -> currentPageIdx, progressPct, back-to-top, and saved reading position
  const handleViewportScroll = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    setShowBackToTop(vp.scrollTop > 320);

    if (prefs.mode === 'paginated') return;
    if (Date.now() < programmaticJumpUntilRef.current) return;

    const vpRect = vp.getBoundingClientRect();
    const spans: PageViewportSpan[] = [];

    for (const [idx, el] of slotRefs.current.entries()) {
      const r = el.getBoundingClientRect();
      spans.push({
        index: idx,
        top: r.top - vpRect.top,
        bottom: r.bottom - vpRect.top,
      });
    }
    spans.sort((a, b) => a.index - b.index);

    const activeStreamIdx = computeCurrentPageFromScroll(spans, vpRect.height);
    const activeItem = displayedStreamItems[activeStreamIdx];
    const primaryIdx =
      activeItem && chapter && activeItem.chapter.id === chapter.id
        ? activeItem.page.pageNumber - 1
        : Math.min(Math.max(0, pages.length - 1), activeStreamIdx);

    setCurrentPageIdx(primaryIdx);
    setJumpInput(String(primaryIdx + 1));

    const pct = computeReadingProgressPercent(
      vp.scrollTop,
      vp.scrollHeight,
      vp.clientHeight,
      primaryIdx,
      pages.length,
      prefs.mode
    );
    setProgressPct(pct);

    if (chapter) {
      schedulePositionSave(chapter.id, primaryIdx);
    }
  }, [prefs.mode, displayedStreamItems, chapter, pages.length, schedulePositionSave]);

  // Keyboard navigation in Paginated mode & Esc to close popovers
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
        setJumpOpen(false);
        setInspectedRegion(null);
        return;
      }
      if (prefs.mode !== 'paginated' || pages.length === 0) return;
      const isRtl = project?.readingDirection !== 'ltr';
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        scrollToStreamPage(isRtl ? currentPageIdx + 1 : currentPageIdx - 1, 'auto');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        scrollToStreamPage(isRtl ? currentPageIdx - 1 : currentPageIdx + 1, 'auto');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [prefs.mode, pages.length, project?.readingDirection, currentPageIdx, scrollToStreamPage]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement && rootRef.current) {
      await rootRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const handleSaveOffline = () => {
    if (!project || !chapter) return;
    startChapterOfflineDownload({
      projectId: project.id,
      chapterId: chapter.id,
      title: chapter.title,
      includeOriginals: true,
      inpaintingEngine,
    });
  };

  const handleRemoveOffline = async () => {
    await removeOfflineChapter(activeChapterId);
    setIsOfflineSaved(false);
    setConfirmRemoveOfflineOpen(false);
  };

  const scrollToTop = () => {
    viewportRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const spacingPx = getPageSpacingPx(prefs.spacing);
  const isLightBg = isLightBackgroundHex(prefs.backgroundColor);
  const isRtlPaginated = project?.readingDirection !== 'ltr';
  const currentChapterIndex = projectChapters.findIndex((c) => c.id === activeChapterId);
  const prevChapter = currentChapterIndex > 0 ? projectChapters[currentChapterIndex - 1] : null;
  const nextChapter =
    currentChapterIndex >= 0 && currentChapterIndex < projectChapters.length - 1
      ? projectChapters[currentChapterIndex + 1]
      : null;

  const updatePref = <K extends keyof ReaderPreferences>(
    key: K,
    value: ReaderPreferences[K]
  ) => {
    setPrefs((prev) => normalizeReaderPreferences({ ...prev, [key]: value }));
  };

  return (
    <div
      ref={rootRef}
      data-testid="chapter-reader-root"
      data-reader-mode={prefs.mode}
      data-reader-spacing={prefs.spacing}
      data-reader-width={prefs.pageWidth}
      style={{ backgroundColor: prefs.backgroundColor }}
      className={`h-[100dvh] w-full flex flex-col overflow-hidden transition-colors duration-200 ${
        isLightBg ? 'text-slate-900' : 'text-slate-100'
      }`}
    >
      {/* Always-visible top Reading Progress Bar */}
      <div
        aria-hidden="true"
        className="w-full h-1 bg-black/25 shrink-0 z-40 relative"
      >
        <div
          data-testid="reader-progress-bar"
          style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          className="h-full bg-[#FFE01B] transition-[width] duration-150"
        />
      </div>

      {/* Collapsible Top Reader Toolbar */}
      {!toolbarHidden && (
        <header
          data-testid="reader-toolbar"
          className="shrink-0 z-30 px-2 sm:px-4 py-2 bg-[#12161F]/95 text-slate-100 border-b border-slate-800 backdrop-blur-md flex flex-wrap items-center justify-between gap-1.5 sm:gap-2"
        >
          {/* Left: Back + Chapter Title + Chapter Picker */}
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            <button
              type="button"
              onClick={onBackToStudio}
              className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs font-medium cursor-pointer shrink-0"
            >
              {lang === 'ar' ? (
                <ArrowRight className="w-4 h-4" />
              ) : (
                <ArrowLeft className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{t.reader.backToStudio}</span>
            </button>

            {projectChapters.length > 1 ? (
              <select
                value={activeChapterId}
                onChange={(e) => setActiveChapterId(e.target.value)}
                aria-label="Chapter selector"
                className="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs font-semibold truncate max-w-[100px] sm:max-w-[220px]"
              >
                {projectChapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs sm:text-sm font-semibold truncate max-w-[108px] sm:max-w-xs">
                {chapter?.title || 'Reader'}
              </div>
            )}

            {loadedFromOffline && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-400 shrink-0">
                <CloudOff className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Offline</span>
              </span>
            )}
          </div>

          {/* Right: Page Counter + Original Toggle + Reader Settings + Offline + Hide Bar */}
          <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
            {/* Live Page Counter & Quick Jump Popover Trigger */}
            <div className="relative">
              <button
                type="button"
                data-testid="reader-page-counter"
                onClick={() => {
                  setJumpInput(String(currentPageIdx + 1));
                  setJumpOpen((v) => !v);
                  setSettingsOpen(false);
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-mono-tabular font-semibold cursor-pointer"
                title={t.reader.jumpToPage}
              >
                <span>
                  {pages.length > 0 ? currentPageIdx + 1 : 0} / {pages.length}
                </span>
              </button>

              {jumpOpen && pages.length > 0 && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const parsed = Number(jumpInput);
                    if (Number.isFinite(parsed) && parsed >= 1) {
                      scrollToStreamPage(parsed - 1, 'auto');
                      setJumpOpen(false);
                    }
                  }}
                  className="absolute top-full mt-2 end-0 z-50 w-52 rounded-xl border border-slate-700 bg-[#141822] p-3 shadow-2xl space-y-2"
                >
                  <label className="block text-[11px] font-semibold text-slate-300">
                    {t.reader.jumpToPage} (1 - {pages.length})
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={pages.length}
                      value={jumpInput}
                      onChange={(e) => setJumpInput(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs text-white"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 rounded-lg bg-[#FFE01B] text-[#111216] text-xs font-black cursor-pointer shrink-0"
                    >
                      OK
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Translated vs Original Toggle */}
            <button
              type="button"
              data-testid="reader-toggle-original-btn"
              onClick={() => setShowOriginal((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
                showOriginal
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : 'border-slate-700 hover:bg-slate-800'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {showOriginal ? t.reader.showOriginal : t.reader.showTranslated}
              </span>
            </button>

            {/* BatCave Reader Display Settings Button */}
            <button
              type="button"
              data-testid="reader-settings-btn"
              onClick={() => {
                setSettingsOpen((v) => !v);
                setJumpOpen(false);
              }}
              aria-expanded={settingsOpen}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${
                settingsOpen
                  ? 'bg-[#FFE01B] text-[#111216] border-[#FFE01B]'
                  : 'border-slate-700 hover:bg-slate-800 text-slate-100'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t.reader.settingsTitle}</span>
            </button>

            {/* Offline Save / Saved */}
            {isOfflineSaved ? (
              <button
                type="button"
                data-testid="reader-remove-offline-btn"
                onClick={() => setConfirmRemoveOfflineOpen(true)}
                title={t.reader.removeOffline}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-emerald-700 bg-emerald-950/60 text-emerald-300 text-xs font-medium cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span className="hidden md:inline">{t.reader.savedOffline}</span>
              </button>
            ) : (
              <button
                type="button"
                data-testid="reader-save-offline-btn"
                disabled={activeOfflineTask?.status === 'downloading' || pages.length === 0}
                onClick={handleSaveOffline}
                title={t.reader.saveOffline}
                className="faqqa-btn-yellow inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-black cursor-pointer disabled:opacity-40"
              >
                {activeOfflineTask?.status === 'downloading' ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="font-mono-tabular">{activeOfflineTask.progress}%</span>
                  </>
                ) : (
                  <>
                    <DownloadCloud className="w-3.5 h-3.5" />
                    <span className="hidden md:inline">{t.reader.saveOffline}</span>
                  </>
                )}
              </button>
            )}

            {/* Hide Toolbar Toggle */}
            <button
              type="button"
              data-testid="reader-toggle-toolbar-btn"
              onClick={() => {
                setToolbarHidden(true);
                setSettingsOpen(false);
                setJumpOpen(false);
              }}
              title={t.reader.hideToolbar}
              aria-label={t.reader.hideToolbar}
              className="p-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 cursor-pointer"
            >
              <EyeOff className="w-4 h-4" />
            </button>

            {/* Fullscreen Toggle */}
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              aria-label={isFullscreen ? t.reader.exitFullscreen : t.reader.fullscreen}
              className="hidden sm:inline-flex p-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 cursor-pointer"
            >
              {isFullscreen ? (
                <Minimize2 className="w-4 h-4" />
              ) : (
                <Maximize2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </header>
      )}

      {/* Discrete floating restore button when toolbar is hidden */}
      {toolbarHidden && (
        <button
          type="button"
          data-testid="reader-show-toolbar-btn"
          onClick={() => setToolbarHidden(false)}
          aria-label={t.reader.showToolbar}
          className="fixed top-3 end-3 z-50 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#12161F]/90 text-white border border-slate-700 shadow-lg text-xs font-semibold hover:bg-slate-800 cursor-pointer"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-[#FFE01B]" />
          <span>{t.reader.showToolbar}</span>
        </button>
      )}

      {/* BatCave-style Reader Display Settings Drawer / Modal */}
      {settingsOpen && (
        <div
          role="dialog"
          aria-label={t.reader.settingsTitle}
          data-testid="reader-settings-panel"
          className="fixed inset-x-3 top-16 sm:top-14 sm:inset-x-auto sm:end-4 z-50 sm:w-[396px] max-h-[80vh] overflow-y-auto rounded-2xl border border-slate-700 bg-[#141822]/98 text-slate-100 p-4 shadow-2xl space-y-4 backdrop-blur-md"
        >
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
            <div className="flex items-center gap-2 text-sm font-bold">
              <SlidersHorizontal className="w-4 h-4 text-[#FFE01B]" />
              <span>{t.reader.settingsTitle}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="reader-reset-prefs-btn"
                onClick={() => {
                  setPrefs(DEFAULT_READER_PREFERENCES);
                  setZoom(1);
                }}
                className="text-[11px] text-slate-300 hover:text-[#FFE01B] underline cursor-pointer"
              >
                {t.reader.resetPrefs}
              </button>
              <button
                type="button"
                data-testid="reader-settings-close-btn"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close settings"
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 1. Reading Mode: Web (default) | Paginated | Infinite */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-slate-300">
              {t.reader.readingModeLabel}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'web', label: 'Web', icon: ScrollText },
                  { id: 'paginated', label: 'Paginated', icon: BookOpen },
                  { id: 'infinite', label: 'Infinite', icon: InfinityIcon },
                ] as Array<{ id: ReaderMode; label: string; icon: React.ComponentType<{ className?: string }> }>
              ).map((opt) => {
                const Icon = opt.icon;
                const active = prefs.mode === opt.id;
                const localized =
                  opt.id === 'web'
                    ? t.reader.modeWeb
                    : opt.id === 'paginated'
                    ? t.reader.modePaginated
                    : t.reader.modeInfinite;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`reader-mode-${opt.id}`}
                    onClick={() => updatePref('mode', opt.id)}
                    className={`flex flex-col items-center justify-center gap-0.5 px-2 py-2 rounded-xl border text-[11px] font-bold transition cursor-pointer ${
                      active
                        ? 'bg-[#FFE01B] text-[#111216] border-[#FFE01B]'
                        : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4 mb-0.5" />
                    <span className="leading-tight text-center">{localized}</span>
                    {lang === 'ar' && (
                      <span
                        className={`text-[9px] font-mono-tabular uppercase ${
                          active ? 'text-[#111216]/75' : 'text-slate-400'
                        }`}
                      >
                        {opt.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {prefs.mode === 'web'
                ? t.reader.modeWebHint
                : prefs.mode === 'paginated'
                ? t.reader.modePaginatedHint
                : t.reader.modeInfiniteHint}
            </p>
          </div>

          {/* 2. Space Between Pages: None (0px default) | Small (8px) | Large (24px) */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-slate-300">
              {t.reader.spacingLabel}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'none', label: t.reader.spacingNone },
                  { id: 'small', label: t.reader.spacingSmall },
                  { id: 'large', label: t.reader.spacingLarge },
                ] as Array<{ id: PageSpacingPreset; label: string }>
              ).map((sp) => (
                <button
                  key={sp.id}
                  type="button"
                  data-testid={`reader-spacing-${sp.id}`}
                  onClick={() => updatePref('spacing', sp.id)}
                  className={`px-2.5 py-2 rounded-xl border text-xs font-bold transition cursor-pointer ${
                    prefs.spacing === sp.id
                      ? 'bg-[#FFE01B] text-[#111216] border-[#FFE01B]'
                      : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {sp.label}
                </button>
              ))}
            </div>
          </div>

          {/* 3. Background Color */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-slate-300">
              {t.reader.backgroundLabel}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {READER_BACKGROUND_SWATCHES.map((swatch) => {
                const selected =
                  prefs.backgroundColor.toLowerCase() === swatch.color.toLowerCase();
                return (
                  <button
                    key={swatch.id}
                    type="button"
                    data-testid={`reader-bg-${swatch.id}`}
                    title={lang === 'ar' ? swatch.labelAr : swatch.labelEn}
                    aria-label={lang === 'ar' ? swatch.labelAr : swatch.labelEn}
                    onClick={() => updatePref('backgroundColor', swatch.color)}
                    style={{ backgroundColor: swatch.color }}
                    className={`w-8 h-8 rounded-full border-2 transition cursor-pointer ${
                      selected
                        ? 'border-[#FFE01B] ring-2 ring-[#FFE01B]/40 scale-105'
                        : 'border-slate-600 hover:scale-105'
                    }`}
                  />
                );
              })}
              <label className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-700 bg-slate-900 text-[11px] cursor-pointer">
                <input
                  type="color"
                  data-testid="reader-bg-custom"
                  value={prefs.backgroundColor}
                  onChange={(e) => updatePref('backgroundColor', e.target.value)}
                  className="w-5 h-5 rounded cursor-pointer bg-transparent border-0 p-0"
                />
                <span className="font-mono-tabular uppercase text-[10px]">
                  {prefs.backgroundColor}
                </span>
              </label>
            </div>
          </div>

          {/* 4. Page Width: Fit Width (default) | Fit Screen */}
          <div className="space-y-1.5">
            <div className="text-xs font-bold text-slate-300">
              {t.reader.pageWidthLabel}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { id: 'fit_width', label: t.reader.fitWidth },
                  { id: 'fit_screen', label: t.reader.fitScreen },
                ] as Array<{ id: PageWidthMode; label: string }>
              ).map((pw) => (
                <button
                  key={pw.id}
                  type="button"
                  data-testid={`reader-width-${pw.id}`}
                  onClick={() => updatePref('pageWidth', pw.id)}
                  className={`px-3 py-2 rounded-xl border text-xs font-bold transition cursor-pointer ${
                    prefs.pageWidth === pw.id
                      ? 'bg-[#FFE01B] text-[#111216] border-[#FFE01B]'
                      : 'border-slate-700 bg-slate-900/70 text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {pw.label}
                </button>
              ))}
            </div>
          </div>

          {/* 5. Brightness Slider + Zoom */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-300 inline-flex items-center gap-1.5">
                <Sun className="w-3.5 h-3.5 text-[#FFE01B]" />
                {t.reader.brightnessLabel}
              </span>
              <span className="font-mono-tabular text-slate-300">{prefs.brightness}%</span>
            </div>
            <input
              type="range"
              data-testid="reader-brightness-slider"
              min={40}
              max={130}
              step={5}
              value={prefs.brightness}
              onChange={(e) => updatePref('brightness', Number(e.target.value))}
              className="w-full accent-[#FFE01B] cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-800 text-xs">
            <span className="font-bold text-slate-300">{t.importModal.previewZoom}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))
                }
                aria-label={t.studio.tools.zoomOut}
                className="p-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 cursor-pointer"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="px-2 py-1 rounded-md font-mono-tabular bg-slate-900 border border-slate-700 cursor-pointer"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={() =>
                  setZoom((z) => Math.min(2.5, Number((z + 0.15).toFixed(2))))
                }
                aria-label={t.studio.tools.zoomIn}
                className="p-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 cursor-pointer"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Scrollable Reader Viewport */}
      <div
        ref={viewportRef}
        data-testid="reader-viewport"
        onScroll={handleViewportScroll}
        className={`flex-1 min-h-0 overflow-y-auto relative ${
          zoom > 1.01 ? 'overflow-x-auto' : 'overflow-x-hidden'
        }`}
      >
        {prefs.mode === 'paginated' ? (
          pages[currentPageIdx] && (
            <div className="min-h-full w-full flex flex-col items-center justify-between py-3 px-2 sm:px-4 gap-3">
              <div className="flex-1 w-full flex items-center justify-center min-h-0">
                <ReaderPageSlot
                  item={{
                    key: `paginated-${pages[currentPageIdx].id}`,
                    streamIndex: currentPageIdx,
                    page: pages[currentPageIdx],
                    chapter: chapter!,
                    isFirstOfExtraChapter: false,
                  }}
                  showOriginal={showOriginal}
                  inpaintingEngine={inpaintingEngine}
                  prefs={prefs}
                  zoom={zoom}
                  viewportSize={{
                    w: viewportSize.w,
                    h: Math.max(240, viewportSize.h - 68),
                  }}
                  inRenderWindow={true}
                  isLightBg={isLightBg}
                  registerSlotRef={registerSlotRef}
                  onSelectBubble={setInspectedRegion}
                  onShowTranslated={() => setShowOriginal(false)}
                  t={t}
                />
              </div>

              <div className="flex items-center justify-center gap-3 pb-2 shrink-0">
                <button
                  type="button"
                  data-testid="paginated-prev-btn"
                  disabled={
                    isRtlPaginated
                      ? currentPageIdx >= pages.length - 1
                      : currentPageIdx <= 0
                  }
                  onClick={() =>
                    scrollToStreamPage(
                      isRtlPaginated ? currentPageIdx + 1 : currentPageIdx - 1,
                      'auto'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-700 bg-[#141822]/90 text-slate-100 hover:bg-slate-800 disabled:opacity-30 text-xs font-bold cursor-pointer"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span>
                    {isRtlPaginated ? t.reader.nextPage : t.reader.prevPage}
                  </span>
                </button>
                <span className="font-mono-tabular text-xs font-bold px-2.5 py-1 rounded-lg bg-black/30">
                  {currentPageIdx + 1} / {pages.length}
                </span>
                <button
                  type="button"
                  data-testid="paginated-next-btn"
                  disabled={
                    isRtlPaginated
                      ? currentPageIdx <= 0
                      : currentPageIdx >= pages.length - 1
                  }
                  onClick={() =>
                    scrollToStreamPage(
                      isRtlPaginated ? currentPageIdx - 1 : currentPageIdx + 1,
                      'auto'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-700 bg-[#141822]/90 text-slate-100 hover:bg-slate-800 disabled:opacity-30 text-xs font-bold cursor-pointer"
                >
                  <span>
                    {isRtlPaginated ? t.reader.prevPage : t.reader.nextPage}
                  </span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )
        ) : (
          /* Web (default) & Infinite Continuous Vertical Column */
          <div
            data-testid="reader-vertical-stream"
            style={{ gap: `${spacingPx}px` }}
            className="w-full flex flex-col items-center p-0 m-0"
          >
            {displayedStreamItems.map((item) => {
              const inWin =
                item.streamIndex >= renderWindow.start &&
                item.streamIndex <= renderWindow.end;
              return (
                <React.Fragment key={item.key}>
                  {item.isFirstOfExtraChapter && (
                    <div
                      data-testid="reader-chapter-divider"
                      className={`w-full max-w-[920px] px-4 py-3 text-center text-xs font-bold border-y ${
                        isLightBg
                          ? 'bg-black/5 border-black/10 text-slate-800'
                          : 'bg-white/5 border-white/10 text-slate-200'
                      }`}
                    >
                      {t.reader.chapterDivider}: {item.chapter.title}
                    </div>
                  )}
                  <ReaderPageSlot
                    item={item}
                    showOriginal={showOriginal}
                    inpaintingEngine={inpaintingEngine}
                    prefs={prefs}
                    zoom={zoom}
                    viewportSize={viewportSize}
                    inRenderWindow={inWin}
                    isLightBg={isLightBg}
                    registerSlotRef={registerSlotRef}
                    onSelectBubble={setInspectedRegion}
                    onShowTranslated={() => setShowOriginal(false)}
                    t={t}
                  />
                </React.Fragment>
              );
            })}

            {/* Infinite Mode Sentinel & Next Chapter Auto-Loader */}
            {prefs.mode === 'infinite' && (
              <div
                ref={infiniteSentinelRef}
                data-testid="reader-infinite-sentinel"
                className="w-full py-6 flex flex-col items-center justify-center gap-2 text-xs opacity-70"
              >
                {(infiniteVisibleCount < allLoadedStreamItems.length ||
                  loadingExtraChapter ||
                  nextAvailableChapter) && (
                  <div className="inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t.reader.loadMorePages}</span>
                  </div>
                )}
              </div>
            )}

            {/* End-of-Chapter Prev/Next Chapter Bar for Web mode */}
            {prefs.mode === 'web' && (prevChapter || nextChapter) && pages.length > 0 && (
              <div className="w-full max-w-[920px] px-4 py-6 flex items-center justify-center gap-3">
                {prevChapter && (
                  <button
                    type="button"
                    onClick={() => setActiveChapterId(prevChapter.id)}
                    className="px-4 py-2 rounded-xl border border-slate-700 bg-[#141822]/90 text-slate-100 hover:bg-slate-800 text-xs font-bold cursor-pointer"
                  >
                    {t.reader.prevChapter}: {prevChapter.title}
                  </button>
                )}
                {nextChapter && (
                  <button
                    type="button"
                    onClick={() => setActiveChapterId(nextChapter.id)}
                    className="px-4 py-2 rounded-xl bg-[#FFE01B] text-[#111216] hover:brightness-95 text-xs font-black cursor-pointer"
                  >
                    {t.reader.nextChapter}: {nextChapter.title}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Back to Top button when scrolled */}
      {showBackToTop && prefs.mode !== 'paginated' && (
        <button
          type="button"
          data-testid="reader-back-to-top-btn"
          onClick={scrollToTop}
          aria-label={t.reader.backToTop}
          className="fixed bottom-5 end-4 sm:end-6 z-40 inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-full bg-[#FFE01B] text-[#111216] border-2 border-[#111216] shadow-xl text-xs font-black hover:brightness-95 cursor-pointer"
        >
          <ArrowUp className="w-4 h-4" />
          <span className="hidden sm:inline">{t.reader.backToTop}</span>
        </button>
      )}

      {/* Tap Bubble Popover showing Original Text */}
      {inspectedRegion && (
        <div
          role="dialog"
          aria-label="Original Bubble Text"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[92vw] max-w-md rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl space-y-2 text-white"
        >
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              #{inspectedRegion.readingOrder} ·{' '}
              {inspectedRegion.sourceLanguage.toUpperCase()}
              {inspectedRegion.speaker ? ` · ${inspectedRegion.speaker}` : ''}
            </span>
            <button
              type="button"
              onClick={() => setInspectedRegion(null)}
              className="text-slate-300 hover:text-white cursor-pointer"
            >
              ✕
            </button>
          </div>
          <div className="text-sm font-medium text-white">
            {inspectedRegion.originalText}
          </div>
          <div className="text-xs font-bold text-[#FFE01B]">
            {inspectedRegion.translatedText}
          </div>
        </div>
      )}

      {/* Confirmation Modal before removing local offline chapter */}
      {confirmRemoveOfflineOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.home.confirmDeleteLocalTitle}
          data-testid="reader-confirm-delete-local-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#141822] text-slate-100 p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-white">
                {t.home.confirmDeleteLocalTitle}
              </h3>
              <button
                type="button"
                onClick={() => setConfirmRemoveOfflineOpen(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
              {t.home.confirmDeleteLocalBody}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRemoveOfflineOpen(false)}
                className="px-3.5 py-2 rounded-xl border border-slate-700 text-xs font-bold text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                {t.home.cancel}
              </button>
              <button
                type="button"
                data-testid="reader-confirm-delete-local-btn"
                onClick={() => void handleRemoveOffline()}
                className="px-3.5 py-2 rounded-xl bg-[#EA3829] text-white text-xs font-black hover:brightness-110 cursor-pointer"
              >
                {t.home.confirmDeleteLocalBtn}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
