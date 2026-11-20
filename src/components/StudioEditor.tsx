import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  Eraser,
  Eye,
  FileArchive,
  Frame,
  Hand,
  ImagePlus,
  Loader2,
  MousePointer,
  Paintbrush,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScanSearch,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquarePlus,
  Trash2,
  Undo2,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  AiProviderId,
  AiSettings,
  Chapter,
  FontSettings,
  LanguageCode,
  ManualStroke,
  Page,
  Point,
  Project,
  ReadingDirection,
  TextRegion,
  TranslationJob,
  TranslationStyle,
} from '../types/domain';
import { tFor } from '../i18n/translations';
import { api } from '../utils/api';
import { polygonToBox } from '../utils/bubbleLayout';
import { fileToImportedPageAsset, importFilesToPages } from '../utils/fileImport';
import {
  buildDuplicatePreventedMessage,
  filterAndDeduplicatePickedAssets,
  NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS,
} from '../utils/nativeImagePicker';
import { BubbleCanvas, type CanvasToolMode } from './BubbleCanvas';
import { BubbleInspector } from './BubbleInspector';
import { ExportModal } from './ExportModal';
import type { RegionQualityAudit } from '../utils/bubbleSegmentation';

const PROVIDER_DISPLAY_NAMES: Record<AiProviderId, string> = {
  gemini: 'Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare Workers AI',
  deepseek: 'DeepSeek',
  qwen_studio: 'Qwen Studio',
};

const ALL_STUDIO_PROVIDER_IDS: AiProviderId[] = [
  'gemini',
  'groq',
  'openrouter',
  'cloudflare',
  'deepseek',
  'qwen_studio',
];

interface StudioEditorProps {
  lang: LanguageCode;
  chapterId: string;
  refreshKey?: number;
  aiSettings: AiSettings;
  availableFonts: string[];
  onChangeAiProvider?: (provider: AiProviderId) => Promise<void> | void;
  onOpenReader: (chapterId: string) => void;
  onOpenAddPages?: (
    chapterId: string,
    projectId: string,
    chapterTitle: string,
    readingDirection: ReadingDirection
  ) => void;
  onJobStarted?: (jobId: string) => void;
}

export const StudioEditor: React.FC<StudioEditorProps> = ({
  lang,
  chapterId,
  refreshKey = 0,
  aiSettings,
  availableFonts,
  onChangeAiProvider,
  onOpenReader,
  onOpenAddPages,
}) => {
  const t = tFor(lang);
  const [project, setProject] = useState<Project | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [activePageId, setActivePageId] = useState<string>('');
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);

  const [toolMode, setToolMode] = useState<CanvasToolMode>('select');
  const [brushSize, setBrushSize] = useState(20);
  const [brushColor, setBrushColor] = useState('#FFFFFF');
  const [zoom, setZoom] = useState(1);
  const [resetSignal, setResetSignal] = useState(0);
  const [compareOriginal, setCompareOriginal] = useState(false);
  const [showGuides, setShowGuides] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedMenuRef = useRef<HTMLDivElement>(null);

  const [undoStack, setUndoStack] = useState<Page[]>([]);
  const [redoStack, setRedoStack] = useState<Page[]>([]);

  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [regionAudits, setRegionAudits] = useState<Record<string, RegionQualityAudit>>({});

  // Batch translation job tracking inside Studio
  const [chapterJob, setChapterJob] = useState<TranslationJob | null>(null);
  const lastSyncedCountsRef = useRef<string>('');

  // Filmstrip drag-reorder, numeric reorder, image replacement & lightweight thumbnail cache
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const [pageOrderDrafts, setPageOrderDrafts] = useState<Record<string, string>>({});
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const addImagesInputRef = useRef<HTMLInputElement>(null);
  const [replacingPageId, setReplacingPageId] = useState<string | null>(null);
  const [pickerNotice, setPickerNotice] = useState<{
    kind: 'info' | 'warning';
    message: string;
  } | null>(null);
  const [thumbCache, setThumbCache] = useState<Record<string, string>>({});
  const thumbInFlightRef = useRef<Set<string>>(new Set());
  const bakedSignatureRef = useRef<Record<string, string>>({});
  const bakeTimerRef = useRef<number | null>(null);
  const [bakePending, setBakePending] = useState(false);

  const computePageRenderSignature = useCallback(
    (pg: Page) =>
      `${pg.id}:${pg.status}:${pg.rotation}:${aiSettings.inpaintingEngine}:${JSON.stringify(
        pg.manualStrokes || []
      )}:${JSON.stringify(
        (pg.regions || []).map((r) => [
          r.id,
          r.translatedText,
          r.boundingBox,
          r.fontSettings,
          r.cleanMode,
          r.sfxMode,
          r.approvalStatus,
        ])
      )}`,
    [aiSettings.inpaintingEngine]
  );

  useEffect(() => {
    if (!busyAction && !bakePending) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busyAction, bakePending]);

  useEffect(() => {
    if (!advancedOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (advancedMenuRef.current && !advancedMenuRef.current.contains(e.target as Node)) {
        setAdvancedOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAdvancedOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [advancedOpen]);

  const handleResetView = () => {
    setZoom(1);
    setResetSignal((s) => s + 1);
  };

  const loadChapterData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!chapterId) return;
      if (!options?.silent) {
        setLoading(true);
        setStatusError('');
      }
      try {
        const [data, jobsRes] = await Promise.all([
          api.getChapter(chapterId),
          api.getJobs(chapterId).catch(() => ({ jobs: [] as TranslationJob[], logs: [] })),
        ]);
        setProject(data.project);
        setChapter(data.chapter);
        const safePages = Array.isArray(data.pages)
          ? data.pages.filter((p): p is Page => Boolean(p && p.id))
          : [];
        for (const pg of safePages) {
          if (pg.processedImage && !bakedSignatureRef.current[pg.id]) {
            bakedSignatureRef.current[pg.id] = computePageRenderSignature(pg);
          }
        }
        setPages(safePages);
        if (jobsRes.jobs.length > 0) {
          setChapterJob(jobsRes.jobs[0]);
        } else {
          setChapterJob(null);
        }
        setActivePageId((prevId) => {
          if (safePages.length === 0) return '';
          if (prevId && safePages.some((p) => p.id === prevId)) return prevId;
          try {
            const raw = localStorage.getItem('faqqa_session_v1');
            const parsed = raw ? JSON.parse(raw) : null;
            const savedPageId = parsed?.pageIdByChapter?.[chapterId];
            if (savedPageId && safePages.some((p) => p.id === savedPageId)) {
              const restored = safePages.find((p) => p.id === savedPageId);
              setSelectedRegionId(restored?.regions?.[0]?.id || null);
              return savedPageId;
            }
          } catch {
            // Ignore malformed storage
          }
          setSelectedRegionId(safePages[0].regions?.[0]?.id || null);
          return safePages[0].id;
        });
      } catch (err) {
        if (!options?.silent) {
          setStatusError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [chapterId, computePageRenderSignature]
  );

  useEffect(() => {
    if (chapterId) {
      void loadChapterData();
    }
  }, [chapterId, refreshKey, loadChapterData]);

  useEffect(() => {
    if (!chapterId || !activePageId) return;
    try {
      const raw = localStorage.getItem('faqqa_session_v1');
      const prev = raw ? JSON.parse(raw) : {};
      const map = prev && typeof prev.pageIdByChapter === 'object' ? prev.pageIdByChapter : {};
      localStorage.setItem(
        'faqqa_session_v1',
        JSON.stringify({
          ...prev,
          chapterId,
          pageIdByChapter: { ...map, [chapterId]: activePageId },
        })
      );
    } catch {
      // Ignore storage error
    }
  }, [chapterId, activePageId]);

  useEffect(() => {
    return () => {
      if (bakeTimerRef.current !== null) {
        window.clearTimeout(bakeTimerRef.current);
      }
    };
  }, []);

  const handleCompositeRendered = useCallback(
    (renderedPage: Page, canvas: HTMLCanvasElement) => {
      if (renderedPage.status !== 'completed') return;
      if (renderedPage.regions.length === 0 && (renderedPage.manualStrokes?.length || 0) === 0) {
        return;
      }
      const sig = computePageRenderSignature(renderedPage);
      if (renderedPage.processedImage && bakedSignatureRef.current[renderedPage.id] === sig) {
        return;
      }

      if (bakeTimerRef.current !== null) {
        window.clearTimeout(bakeTimerRef.current);
      }

      const dataUrl =
        canvas.width * canvas.height > 2_500_000
          ? canvas.toDataURL('image/webp', 0.94)
          : canvas.toDataURL('image/png');

      bakeTimerRef.current = window.setTimeout(async () => {
        setBakePending(true);
        try {
          const res = await api.renderPage(renderedPage.id, dataUrl);
          bakedSignatureRef.current[renderedPage.id] = sig;
          if (res?.page?.processedImage) {
            setPages((all) =>
              all.map((p) =>
                p && p.id === res.page.id ? { ...p, processedImage: res.page.processedImage } : p
              )
            );
          }
        } catch {
          // Keep editing uninterrupted; next render/export will retry
        } finally {
          setBakePending(false);
        }
      }, 650);
    },
    [computePageRenderSignature]
  );

  // Poll active chapter job every 1500ms while queued or running, refreshing pages on progress
  useEffect(() => {
    if (!chapterId || !chapterJob) return;
    if (chapterJob.status !== 'queued' && chapterJob.status !== 'running') return;

    const timer = window.setInterval(async () => {
      try {
        const res = await api.getJobs(chapterId);
        const latest = res.jobs[0];
        if (!latest) return;
        setChapterJob(latest);
        const sig = `${latest.status}:${latest.completedPages}:${latest.failedPages}:${latest.currentBatch}`;
        if (sig !== lastSyncedCountsRef.current) {
          lastSyncedCountsRef.current = sig;
          await loadChapterData({ silent: true });
        }
      } catch {
        // Keep polling gracefully on transient error
      }
    }, 1500);

    return () => window.clearInterval(timer);
  }, [chapterId, chapterJob?.id, chapterJob?.status, loadChapterData]);

  // Lazy offscreen downscaled thumbnail generation for smooth 100+ page filmstrip scrolling
  useEffect(() => {
    let cancelled = false;
    const missing = pages.filter((pg) => {
      const key = `${pg.id}:${pg.originalImage.length}:${pg.contentHash || ''}`;
      return !thumbCache[key] && !thumbInFlightRef.current.has(key);
    });
    if (missing.length === 0) return;

    const queue = missing.slice(0, 12);
    const generateBatch = async () => {
      for (const pg of queue) {
        if (cancelled) return;
        const key = `${pg.id}:${pg.originalImage.length}:${pg.contentHash || ''}`;
        thumbInFlightRef.current.add(key);
        try {
          if (pg.originalImage.length < 32_000) {
            if (!cancelled) setThumbCache((prev) => ({ ...prev, [key]: pg.originalImage }));
            continue;
          }
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('thumb'));
            img.src = pg.originalImage;
          });
          const maxW = 160;
          const scale = Math.min(1, maxW / Math.max(1, img.naturalWidth || 160));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((img.naturalWidth || 160) * scale));
          canvas.height = Math.max(1, Math.round((img.naturalHeight || 220) * scale));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
            if (!cancelled) setThumbCache((prev) => ({ ...prev, [key]: dataUrl }));
          }
        } catch {
          if (!cancelled) setThumbCache((prev) => ({ ...prev, [key]: pg.originalImage }));
        } finally {
          thumbInFlightRef.current.delete(key);
        }
      }
    };

    void generateBatch();
    return () => {
      cancelled = true;
    };
  }, [pages, thumbCache]);

  const activePage = pages.find((p) => p?.id === activePageId) || pages.find((p) => Boolean(p)) || null;
  const selectedRegion =
    activePage?.regions?.find((r) => r?.id === selectedRegionId) || null;

  const pushUndo = (currentPage: Page) => {
    setUndoStack((prev) => [...prev.slice(-24), JSON.parse(JSON.stringify(currentPage))]);
    setRedoStack([]);
  };

  const handleUndo = async () => {
    if (!activePage || undoStack.length === 0) return;
    const prevSnapshot = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setRedoStack((s) => [...s, JSON.parse(JSON.stringify(activePage))]);
    setPages((all) => all.map((p) => (p.id === prevSnapshot.id ? prevSnapshot : p)));
    await api.updatePage(prevSnapshot.id, {
      regions: prevSnapshot.regions,
      manualStrokes: prevSnapshot.manualStrokes,
      rotation: prevSnapshot.rotation,
    });
  };

  const handleRedo = async () => {
    if (!activePage || redoStack.length === 0) return;
    const nextSnapshot = redoStack[redoStack.length - 1];
    setRedoStack((s) => s.slice(0, -1));
    setUndoStack((s) => [...s, JSON.parse(JSON.stringify(activePage))]);
    setPages((all) => all.map((p) => (p.id === nextSnapshot.id ? nextSnapshot : p)));
    await api.updatePage(nextSnapshot.id, {
      regions: nextSnapshot.regions,
      manualStrokes: nextSnapshot.manualStrokes,
      rotation: nextSnapshot.rotation,
    });
  };

  const handleUpdateRegion = (regionId: string, patch: Partial<TextRegion>) => {
    if (!activePage) return;
    pushUndo(activePage);
    const nextRegions = activePage.regions.map((r) =>
      r.id === regionId ? { ...r, ...patch } : r
    );
    setPages((all) =>
      all.map((p) => (p.id === activePage.id ? { ...p, regions: nextRegions } : p))
    );
    void api.updateBubble(regionId, patch);
  };

  const handleUpdateFont = (regionId: string, fontPatch: Partial<FontSettings>) => {
    if (!activePage) return;
    const target = activePage.regions.find((r) => r.id === regionId);
    if (!target) return;
    pushUndo(activePage);
    const mergedFont = { ...target.fontSettings, ...fontPatch };
    setPages((all) =>
      all.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              regions: p.regions.map((r) =>
                r.id === regionId ? { ...r, fontSettings: mergedFont } : r
              ),
            }
          : p
      )
    );
    void api.updateBubble(regionId, { fontSettings: mergedFont });
  };

  const handleUpdateGeometry = (regionId: string, polygon: Point[]) => {
    if (!activePage) return;
    pushUndo(activePage);
    const box = polygonToBox(polygon);
    setPages((all) =>
      all.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              regions: p.regions.map((r) =>
                r.id === regionId
                  ? { ...r, boundingPolygon: polygon, boundingBox: box }
                  : r
              ),
            }
          : p
      )
    );
    void api.updateBubble(regionId, { boundingPolygon: polygon, boundingBox: box });
  };

  const handleCreateRegion = async (box: { x: number; y: number; width: number; height: number }) => {
    if (!activePage) return;
    pushUndo(activePage);
    const res = await api.createBubble({
      pageId: activePage.id,
      regionType: 'dialogue',
      boundingBox: box,
    });
    setPages((all) =>
      all.map((p) => (p && p.id === activePage.id && res?.page ? res.page : p))
    );
    setSelectedRegionId(res.region.id);
    setToolMode('select');
  };

  const handleAddStroke = (stroke: ManualStroke) => {
    if (!activePage) return;
    pushUndo(activePage);
    const nextStrokes = [...(activePage.manualStrokes || []), stroke];
    setPages((all) =>
      all.map((p) => (p && p.id === activePage.id ? { ...p, manualStrokes: nextStrokes } : p))
    );
    void api.cleanPage(activePage.id, nextStrokes);
  };

  const handleAnalyzePage = async () => {
    if (!activePage) return;
    setBusyAction(true);
    setStatusError('');
    try {
      const res = await api.analyzePage(activePage.id);
      if (res?.page) {
        setPages((all) => all.map((p) => (p && p.id === activePage.id ? res.page : p)));
        setSelectedRegionId(res.page.regions?.[0]?.id || null);
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleTranslatePage = async () => {
    if (!activePage) return;
    setBusyAction(true);
    setStatusError('');
    try {
      const res = await api.translatePage(activePage.id);
      if (res?.page) {
        setPages((all) => all.map((p) => (p && p.id === activePage.id ? res.page : p)));
        setSelectedRegionId(res.page.regions?.[0]?.id || null);
      }
      await loadChapterData({ silent: true });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleTranslateFullChapter = async (options?: {
    retryOnlyFailed?: boolean;
    pageIds?: string[];
    forceRetranslate?: boolean;
    batchSize?: number;
  }) => {
    if (!chapter) return;
    setBusyAction(true);
    setStatusError('');
    try {
      const res = await api.startBatchJob(chapter.id, {
        batchSize: 2,
        ...options,
      });
      setChapterJob(res.job);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleControlChapterJob = async (
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed'
  ) => {
    if (!chapterJob) return;
    setStatusError('');
    try {
      const res = await api.controlJob(chapterJob.id, action);
      setChapterJob(res.job);
      await loadChapterData({ silent: true });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRetranslateCurrentBatch = async () => {
    if (!activePage || pages.length === 0) return;
    const idx = pages.findIndex((p) => p.id === activePage.id);
    if (idx === -1) return;
    const pairStart = Math.floor(idx / 2) * 2;
    const pairIds = pages.slice(pairStart, pairStart + 2).map((p) => p.id);
    await handleTranslateFullChapter({
      pageIds: pairIds,
      forceRetranslate: true,
    });
  };

  const handleChangeReadingDirection = async (dir: ReadingDirection) => {
    if (!project || project.readingDirection === dir) return;
    setProject({ ...project, readingDirection: dir });
    try {
      const res = await api.updateProject(project.id, { readingDirection: dir });
      setProject(res.project);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleMovePage = async (pageId: string, dir: -1 | 1) => {
    const idx = pages.findIndex((p) => p.id === pageId);
    const targetIdx = idx + dir;
    if (idx === -1 || targetIdx < 0 || targetIdx >= pages.length || !chapter) return;
    const reordered = [...pages];
    const [item] = reordered.splice(idx, 1);
    reordered.splice(targetIdx, 0, item);
    const res = await api.reorderPages(
      chapter.id,
      reordered.map((p) => p.id)
    );
    setPages(res.pages);
  };

  const handleMovePageToOrder = async (pageId: string, rawNumber: string) => {
    if (!chapter) return;
    const parsed = Number(rawNumber);
    setPageOrderDrafts((prev) => {
      const copy = { ...prev };
      delete copy[pageId];
      return copy;
    });
    if (!Number.isInteger(parsed)) return;
    const clampedIndex = Math.max(0, Math.min(pages.length - 1, parsed - 1));
    const currentIndex = pages.findIndex((p) => p.id === pageId);
    if (currentIndex === -1 || currentIndex === clampedIndex) return;
    const reordered = [...pages];
    const [item] = reordered.splice(currentIndex, 1);
    reordered.splice(clampedIndex, 0, item);
    const res = await api.reorderPages(
      chapter.id,
      reordered.map((p) => p.id)
    );
    setPages(res.pages);
  };

  const handleDropPageOn = async (targetPageId: string) => {
    if (!draggedPageId || draggedPageId === targetPageId || !chapter) {
      setDraggedPageId(null);
      return;
    }
    const fromIdx = pages.findIndex((p) => p.id === draggedPageId);
    const toIdx = pages.findIndex((p) => p.id === targetPageId);
    setDraggedPageId(null);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...pages];
    const [item] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, item);
    const res = await api.reorderPages(
      chapter.id,
      reordered.map((p) => p.id)
    );
    if (Array.isArray(res?.pages)) {
      setPages(res.pages.filter((p): p is Page => Boolean(p && p.id)));
    }
  };

  const handleRotatePage = async (page: Page) => {
    const nextRot = ((page.rotation + 90) % 360) as Page['rotation'];
    const res = await api.updatePage(page.id, { rotation: nextRot });
    if (res?.page) {
      setPages((all) => all.map((p) => (p && p.id === page.id ? res.page : p)));
    }
  };

  const handleDuplicatePage = async (pageId: string) => {
    await api.duplicatePage(pageId);
    await loadChapterData({ silent: true });
  };

  const handleDeletePage = async (pageId: string) => {
    if (pages.length <= 1) return;
    const res = await api.deletePage(pageId);
    const nextPages = Array.isArray(res?.pages)
      ? res.pages.filter((p): p is Page => Boolean(p && p.id))
      : [];
    setPages(nextPages);
    if (activePageId === pageId && nextPages[0]) {
      setActivePageId(nextPages[0].id);
    }
  };

  const handleReplacePageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetId = replacingPageId;
    e.target.value = '';
    setReplacingPageId(null);
    if (!file || !targetId) return;
    setBusyAction(true);
    setStatusError('');
    try {
      const asset = await fileToImportedPageAsset(file);
      const res = await api.replacePageImage(targetId, {
        dataUrl: asset.dataUrl,
        width: asset.width,
        height: asset.height,
        contentHash: asset.contentHash,
      });
      if (res?.page) {
        setPages((all) => all.map((p) => (p && p.id === targetId ? res.page : p)));
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleDirectImagesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const pickedFiles = Array.from(e.target.files || []);
    e.target.value = '';
    if (!chapter || pickedFiles.length === 0) return;

    setBusyAction(true);
    setStatusError('');
    setPickerNotice(null);
    try {
      // Immediately read File bytes & SHA-256 in memory so temporary Android Photo Picker URIs never expire
      const assets = await importFilesToPages(pickedFiles);
      if (assets.length === 0) {
        setStatusError(
          lang === 'ar'
            ? 'لم يتم العثور على صور صالحة في الملفات المختارة.'
            : 'No valid images found in selected files.'
        );
        return;
      }

      const existingHashes = pages.map((p) => p.contentHash || '').filter(Boolean);
      const { accepted, skippedDuplicateCount } = filterAndDeduplicatePickedAssets(
        existingHashes,
        assets
      );

      if (accepted.length > 0) {
        await api.appendChapterPages(
          chapter.id,
          accepted.map((p) => ({
            dataUrl: p.dataUrl,
            width: p.width,
            height: p.height,
            contentHash: p.contentHash,
          }))
        );
        await loadChapterData({ silent: true });
      }

      if (skippedDuplicateCount > 0) {
        setPickerNotice({
          kind: 'warning',
          message: buildDuplicatePreventedMessage(lang, accepted.length, skippedDuplicateCount),
        });
      } else if (accepted.length > 0) {
        setPickerNotice({
          kind: 'info',
          message:
            lang === 'ar'
              ? `تمت إضافة ${accepted.length} ${accepted.length === 1 ? 'صورة جديدة' : 'صور جديدة'} دون بدء الترجمة تلقائياً.`
              : `Added ${accepted.length} new image(s). Ready to translate when you choose.`,
        });
      }
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(false);
    }
  };

  // Compute live page counters for the Studio Batch Progress & Recovery bar
  const chapterStats = useMemo(() => {
    const total = pages.length;
    const completed = pages.filter((p) => p.status === 'completed').length;
    const failed = pages.filter((p) => p.status === 'error').length;
    const inProgress = pages.filter(
      (p) => p.status === 'analyzing' || p.status === 'translating'
    ).length;
    const remaining = Math.max(0, total - completed - failed - inProgress);
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, completed, failed, inProgress, remaining, pct };
  }, [pages]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-[#EA3829] dark:text-[#FFE01B]" />
      </div>
    );
  }

  if (!project || !chapter || !activePage) {
    return (
      <div className="flex-1 flex items-center justify-center p-12 text-sm text-slate-500">
        {statusError || 'Select a chapter from the Library to start editing.'}
      </div>
    );
  }

  const activeIdx = pages.findIndex((p) => p.id === activePage.id);
  const currentPairBatchNumber = activeIdx >= 0 ? Math.floor(activeIdx / 2) + 1 : 1;
  const totalChapterBatches = Math.max(1, Math.ceil(pages.length / 2));

  const jobInProgressCount = chapterJob
    ? Object.values(chapterJob.pageStates || {}).filter((s) => s === 'running').length
    : chapterStats.inProgress;
  const jobQueuedCount = chapterJob
    ? Object.values(chapterJob.pageStates || {}).filter((s) => s === 'queued').length
    : chapterStats.remaining;
  const activeJobRunning = chapterJob?.status === 'running' || chapterJob?.status === 'queued';

  const statusBadgeStyle = (st: Page['status']) => {
    switch (st) {
      case 'completed':
        return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300';
      case 'analyzing':
      case 'translating':
        return 'bg-[#FFE01B] text-[#111111] border border-[#111111]';
      case 'error':
        return 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300';
      default:
        return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void handleReplacePageFile(e)}
      />
      <input
        ref={addImagesInputRef}
        {...NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS}
        data-testid="studio-native-image-input"
        aria-label={t.studio.addImagesBtn}
        className="hidden"
        onChange={(e) => void handleDirectImagesSelected(e)}
      />

      {/* Clean Single-Row Studio Action Toolbar */}
      <div className="px-3 lg:px-4 py-2 bg-white dark:bg-[#161B22] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        {/* Left: Unified Segmented Canvas Tools + History */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-0.5 p-1 rounded-lg bg-slate-100 dark:bg-[#0D1117]">
            {(
              [
                { id: 'select', icon: <MousePointer className="w-3.5 h-3.5" />, label: t.studio.tools.select },
                { id: 'draw', icon: <SquarePlus className="w-3.5 h-3.5" />, label: t.studio.tools.drawRegion },
                { id: 'brush', icon: <Paintbrush className="w-3.5 h-3.5" />, label: t.studio.tools.brush },
                { id: 'eraser', icon: <Eraser className="w-3.5 h-3.5" />, label: t.studio.tools.eraser },
                { id: 'pan', icon: <Hand className="w-3.5 h-3.5" />, label: t.studio.tools.pan },
              ] as const
            ).map((tool) => (
              <button
                key={tool.id}
                type="button"
                title={tool.label}
                aria-label={tool.label}
                aria-pressed={toolMode === tool.id}
                onClick={() => setToolMode(tool.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-extrabold cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  toolMode === tool.id
                    ? 'bg-[#FFE01B] text-[#111111] border border-[#111111] shadow-[1.5px_1.5px_0px_#111111]'
                    : 'text-[#524E46] dark:text-slate-300 hover:text-[#111111] dark:hover:text-white'
                }`}
              >
                {tool.icon}
                <span className="hidden 2xl:inline">{tool.label}</span>
              </button>
            ))}
          </div>

          {(toolMode === 'brush' || toolMode === 'eraser') && (
            <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-slate-100 dark:bg-[#0D1117]">
              <input
                type="range"
                min="6"
                max="60"
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                aria-label="Brush size"
                className="w-16"
              />
              {toolMode === 'brush' && (
                <input
                  type="color"
                  value={brushColor}
                  onChange={(e) => setBrushColor(e.target.value)}
                  aria-label="Brush color"
                  className="w-5 h-5 rounded border border-slate-300 cursor-pointer"
                />
              )}
            </div>
          )}

          <div className="inline-flex items-center gap-0.5 ps-1 border-s border-slate-200 dark:border-slate-800">
            <button
              type="button"
              disabled={undoStack.length === 0}
              onClick={() => void handleUndo()}
              aria-label={t.studio.tools.undo}
              title={t.studio.tools.undo}
              className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 cursor-pointer"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={redoStack.length === 0}
              onClick={() => void handleRedo()}
              aria-label={t.studio.tools.redo}
              title={t.studio.tools.redo}
              className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 cursor-pointer"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Center: Compact Zoom & Natural Fit Reset */}
        <div className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded-lg bg-slate-100 dark:bg-[#0D1117]">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))}
            aria-label={t.studio.tools.zoomOut}
            title={t.studio.tools.zoomOut}
            className="p-1.5 rounded-md text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleResetView}
            title={t.studio.tools.resetZoom}
            aria-label={t.studio.tools.resetZoom}
            className="px-2 py-1 rounded-md text-xs font-mono-tabular font-medium text-slate-800 dark:text-slate-100 hover:bg-white dark:hover:bg-slate-800 cursor-pointer"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.15).toFixed(2))))}
            aria-label={t.studio.tools.zoomIn}
            title={t.studio.tools.zoomIn}
            className="p-1.5 rounded-md text-slate-700 dark:text-slate-200 hover:bg-white dark:hover:bg-slate-800 cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          {zoom !== 1 && (
            <button
              type="button"
              onClick={handleResetView}
              aria-label={t.studio.tools.resetZoom}
              title={t.studio.tools.resetZoom}
              className="p-1.5 rounded-md text-[#EA3829] dark:text-[#FFE01B] hover:bg-white dark:hover:bg-slate-800 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Right: Primary Workflow & Collapsible Advanced Options */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyAction}
            onClick={handleTranslatePage}
            className="faqqa-btn-yellow inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-black whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {busyAction ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>{t.studio.translatePage}</span>
          </button>

          <button
            type="button"
            disabled={busyAction || activeJobRunning}
            onClick={() => void handleTranslateFullChapter({ batchSize: 2 })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-[#111111] dark:border-[#FFE01B] bg-[#FFFDF9] dark:bg-[#1E2028] text-[#111111] dark:text-[#FFE01B] hover:bg-[#FFE01B]/30 text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {activeJobRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            <span>{t.studio.translateAll}</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenReader(chapter.id)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-[#111111]/25 dark:border-white/25 hover:border-[#111111] text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#EA3829]" />
            <span>{t.studio.openReader}</span>
          </button>

          <button
            type="button"
            onClick={() => setExportOpen(true)}
            className="faqqa-btn-black inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.studio.exportChapter}</span>
          </button>

          {/* Collapsible Advanced Controls Menu */}
          <div ref={advancedMenuRef} className="relative">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-haspopup="true"
              onClick={() => setAdvancedOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 text-xs font-bold whitespace-nowrap shrink-0 cursor-pointer ${
                advancedOpen || compareOriginal || showGuides
                  ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                  : 'border-[#111111]/20 dark:border-white/20 text-[#333333] dark:text-slate-200 hover:border-[#111111]'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t.studio.advancedMenu}</span>
            </button>

            {advancedOpen && (
              <div
                role="dialog"
                aria-label={t.studio.advancedMenu}
                className="absolute end-0 mt-2 w-72 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] shadow-xl p-3 space-y-2.5 z-40"
              >
                {onChangeAiProvider && (
                  <div className="space-y-1">
                    <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {t.studio.activeApiLabel}
                    </label>
                    <select
                      aria-label={t.studio.activeApiLabel}
                      title={t.studio.activeApiLabel}
                      value={
                        ALL_STUDIO_PROVIDER_IDS.includes(aiSettings.provider as AiProviderId)
                          ? aiSettings.provider
                          : 'gemini'
                      }
                      onChange={(e) => void onChangeAiProvider(e.target.value as AiProviderId)}
                      className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117] text-xs font-medium cursor-pointer"
                    >
                      <option value="gemini">API: Gemini</option>
                      <option value="groq">API: Groq</option>
                      <option value="openrouter">API: OpenRouter</option>
                      <option value="cloudflare">API: Cloudflare AI</option>
                      <option value="deepseek">API: DeepSeek</option>
                      <option value="qwen_studio">API: Qwen Studio</option>
                    </select>
                  </div>
                )}

                {activePage.lastTranslationMeta && (
                  <div
                    data-testid="studio-advanced-last-meta"
                    className="px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-[#0D1117] border border-slate-200/80 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-300 space-y-0.5"
                  >
                    <div className="font-medium text-slate-500 dark:text-slate-400">
                      {t.studio.lastTranslatedBy}
                    </div>
                    <div dir="ltr" className="font-mono truncate">
                      {PROVIDER_DISPLAY_NAMES[activePage.lastTranslationMeta.providerUsed] ||
                        activePage.lastTranslationMeta.providerUsed}{' '}
                      · {activePage.lastTranslationMeta.modelUsed}
                    </div>
                  </div>
                )}

                <div className="pt-1 border-t border-slate-100 dark:border-slate-800 space-y-1">
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => {
                      setAdvancedOpen(false);
                      void handleAnalyzePage();
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                  >
                    <ScanSearch className="w-3.5 h-3.5 text-slate-500" />
                    <span>{t.studio.analyzePage}</span>
                  </button>

                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => {
                      setAdvancedOpen(false);
                      void handleRetranslateCurrentBatch();
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-[#EA3829]" />
                    <span>{t.studio.retranslateBatchBtn}</span>
                  </button>

                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => {
                      setAdvancedOpen(false);
                      void handleTranslateFullChapter({ batchSize: 2, forceRetranslate: false });
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-[#EA3829]" />
                    <span>{t.studio.translateAll}</span>
                  </button>
                </div>

                <div className="pt-1 border-t border-slate-100 dark:border-slate-800 space-y-1">
                  <button
                    type="button"
                    aria-pressed={compareOriginal}
                    onClick={() => setCompareOriginal((v) => !v)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${
                      compareOriginal
                        ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-medium'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Eye className="w-3.5 h-3.5" />
                      <span>{t.studio.tools.compare}</span>
                    </span>
                    <span className="text-[10px] opacity-75">{compareOriginal ? 'ON' : 'OFF'}</span>
                  </button>

                  <button
                    type="button"
                    aria-pressed={showGuides}
                    title={t.studio.tools.showGuides}
                    onClick={() => setShowGuides((v) => !v)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer ${
                      showGuides
                        ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-medium'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Frame className="w-3.5 h-3.5" />
                      <span>{t.studio.tools.showGuides}</span>
                    </span>
                    <span className="text-[10px] opacity-75">{showGuides ? 'ON' : 'OFF'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Live 2-Page Batch Progress & Recovery Telemetry Bar */}
      <div
        data-testid="studio-batch-progress-bar"
        className="px-3 lg:px-4 py-1.5 bg-slate-50/90 dark:bg-[#0D1117] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0"
      >
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-100">
            <span>{t.studio.batchProgressTitle}</span>
            {chapterJob ? (
              <span
                dir="ltr"
                className="px-1.5 py-0.5 rounded bg-[#FFE01B] border border-[#111111] text-[#111111] font-mono-tabular font-black text-[11px]"
              >
                {t.studio.batchProgressCounter} {chapterJob.currentBatch || 1}/
                {chapterJob.totalBatches || Math.max(1, Math.ceil(chapterJob.totalPages / 2))}
              </span>
            ) : (
              <span
                dir="ltr"
                className="px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono-tabular text-[11px]"
              >
                {t.studio.batchProgressCounter} {currentPairBatchNumber}/{totalChapterBatches}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono-tabular text-slate-600 dark:text-slate-400">
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
              {t.studio.completedLabel}: {chapterStats.completed}/{chapterStats.total}
            </span>
            <span>·</span>
            <span>
              {t.studio.inProgressLabel}: {jobInProgressCount}
            </span>
            <span>·</span>
            <span>
              {t.studio.remainingLabel}: {jobQueuedCount}
            </span>
            {chapterStats.failed > 0 && (
              <>
                <span>·</span>
                <span className="text-rose-600 dark:text-rose-400 font-semibold">
                  {t.studio.failedLabel}: {chapterStats.failed}
                </span>
              </>
            )}
          </div>

          <div className="w-24 h-2 rounded-full bg-[#FAF5E8] dark:bg-slate-800 border border-[#111111]/25 overflow-hidden">
            <div
              className={`h-full transition-all ${
                chapterJob?.status === 'failed'
                  ? 'bg-[#EA3829]'
                  : chapterJob?.status === 'completed'
                  ? 'bg-emerald-500'
                  : 'bg-[#FFE01B]'
              }`}
              style={{ width: `${chapterJob ? chapterJob.progress : chapterStats.pct}%` }}
            />
          </div>
          <span className="font-mono-tabular font-semibold text-slate-800 dark:text-slate-200 text-[11px]">
            {chapterJob ? chapterJob.progress : chapterStats.pct}%
          </span>

          {(chapterJob?.activeProvider || aiSettings.provider) && (
            <span
              dir="ltr"
              className="hidden xl:inline-block font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate max-w-[200px]"
            >
              {PROVIDER_DISPLAY_NAMES[
                (chapterJob?.activeProvider || aiSettings.provider) as AiProviderId
              ] ||
                chapterJob?.activeProvider ||
                aiSettings.provider}{' '}
              · {chapterJob?.activeModel || aiSettings.translationModel}
            </span>
          )}
        </div>

        {/* Recovery & Batch Controls */}
        <div className="flex flex-wrap items-center gap-1.5">
          {chapterJob && (chapterJob.status === 'running' || chapterJob.status === 'queued') && (
            <>
              <button
                type="button"
                onClick={() => void handleControlChapterJob('pause')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#161B22] hover:bg-slate-100 text-[11px] font-medium cursor-pointer"
              >
                <Pause className="w-3 h-3" />
                <span>{t.jobs.pause}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleControlChapterJob('cancel')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 hover:bg-rose-50 text-[11px] font-medium cursor-pointer"
              >
                <Square className="w-3 h-3" />
                <span>{t.jobs.cancelJob}</span>
              </button>
            </>
          )}

          {chapterJob?.status === 'paused' && (
            <button
              type="button"
              onClick={() => void handleControlChapterJob('resume')}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 text-[11px] font-medium cursor-pointer"
            >
              <Play className="w-3 h-3" />
              <span>{t.jobs.resume}</span>
            </button>
          )}

          {(chapterStats.failed > 0 || (chapterJob && chapterJob.failedPages > 0)) && (
            <button
              type="button"
              disabled={busyAction}
              onClick={() =>
                chapterJob
                  ? void handleControlChapterJob('retry_failed')
                  : void handleTranslateFullChapter({ retryOnlyFailed: true, batchSize: 2 })
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700 text-[11px] font-medium cursor-pointer disabled:opacity-50"
            >
              <RotateCw className="w-3 h-3" />
              <span>{t.jobs.retryFailed}</span>
            </button>
          )}

          <button
            type="button"
            disabled={busyAction || activeJobRunning}
            onClick={() => void handleRetranslateCurrentBatch()}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#161B22] hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            <span className="hidden sm:inline">{t.studio.retranslateBatchBtn}</span>
          </button>
        </div>
      </div>

      {statusError && (
        <div
          role="alert"
          className="px-4 py-2 bg-rose-50 dark:bg-rose-950/60 border-b border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-200 flex items-center justify-between gap-3 shrink-0"
        >
          <span>{statusError}</span>
          <button
            type="button"
            onClick={() => setStatusError('')}
            className="underline font-medium shrink-0 cursor-pointer"
          >
            {lang === 'ar' ? 'إغلاق' : 'Dismiss'}
          </button>
        </div>
      )}

      {pickerNotice && (
        <div
          role="alert"
          data-testid="studio-picker-notice"
          className={`px-4 py-2 border-b text-xs font-semibold flex items-center justify-between gap-3 shrink-0 ${
            pickerNotice.kind === 'warning'
              ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-100'
              : 'bg-[#FFE01B]/25 dark:bg-[#FFE01B]/10 border-[#111111]/20 text-[#111111] dark:text-[#FFE01B]'
          }`}
        >
          <span className="flex items-center gap-2">
            {pickerNotice.kind === 'warning' ? (
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <span>{pickerNotice.message}</span>
          </span>
          <button
            type="button"
            onClick={() => setPickerNotice(null)}
            className="underline font-bold shrink-0 cursor-pointer"
          >
            {lang === 'ar' ? 'إغلاق' : 'Dismiss'}
          </button>
        </div>
      )}

      {/* 3-Column Studio Workspace (Comic Canvas Dominant) */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Pages Filmstrip & Ordering Controls */}
        <aside className="w-full lg:w-48 shrink-0 border-b lg:border-b-0 lg:border-e border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22] flex flex-col min-h-0">
          <div className="px-2.5 py-2 border-b border-slate-100 dark:border-slate-800 space-y-2 shrink-0">
            <div className="flex items-center justify-between gap-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
              <span>
                {t.studio.pagesList} ({pages.length})
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="studio-add-images-btn"
                  disabled={busyAction}
                  onClick={() => addImagesInputRef.current?.click()}
                  className="faqqa-btn-yellow inline-flex items-center gap-1 px-2 py-1 rounded-xl text-[11px] font-black cursor-pointer disabled:opacity-50 whitespace-nowrap"
                >
                  <Plus className="w-3 h-3" />
                  <span>{t.studio.addImagesBtn}</span>
                </button>
                {onOpenAddPages && (
                  <button
                    type="button"
                    data-testid="studio-add-pages-btn"
                    title={t.importModal.pickArchives}
                    aria-label={t.importModal.pickArchives}
                    onClick={() =>
                      onOpenAddPages(
                        chapter.id,
                        project.id,
                        chapter.title,
                        project.readingDirection
                      )
                    }
                    className="p-1 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    <FileArchive className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Explicit 3-Mode Reading / Display Selector */}
            <div
              role="group"
              aria-label={t.studio.orderModeShort}
              className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-[#0D1117]"
            >
              {(
                [
                  { id: 'ltr', label: 'LTR' },
                  { id: 'rtl', label: 'RTL' },
                  { id: 'vertical', label: lang === 'ar' ? 'عمودي' : 'Vert' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={project.readingDirection === m.id}
                  onClick={() => void handleChangeReadingDirection(m.id)}
                  className={`py-1 rounded text-[10px] font-extrabold cursor-pointer transition-colors ${
                    project.readingDirection === m.id
                      ? 'bg-[#FFE01B] text-[#111111] border border-[#111111]'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div
            dir={project.readingDirection === 'rtl' ? 'rtl' : 'ltr'}
            className="flex lg:flex-col gap-2 p-2 overflow-x-auto lg:overflow-y-auto flex-1 min-h-0"
          >
            {pages.map((pg, idx) => {
              const isCurrent = pg.id === activePage.id;
              const reviewCount = pg.regions.filter((r) => r.approvalStatus === 'needs_review').length;
              const thumbKey = `${pg.id}:${pg.originalImage.length}:${pg.contentHash || ''}`;
              const thumbSrc = thumbCache[thumbKey] || pg.originalImage;
              const orderDraft = pageOrderDrafts[pg.id] ?? String(pg.pageNumber);

              return (
                <div
                  key={pg.id}
                  draggable
                  onDragStart={() => setDraggedPageId(pg.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => void handleDropPageOn(pg.id)}
                  onDragEnd={() => setDraggedPageId(null)}
                  className={`shrink-0 w-36 lg:w-full rounded-xl border-2 p-1.5 space-y-1.5 transition-colors ${
                    draggedPageId === pg.id ? 'opacity-50' : ''
                  } ${
                    isCurrent
                      ? 'border-[#111111] dark:border-[#FFE01B] bg-[#FFE01B]/25 dark:bg-[#FFE01B]/10 shadow-[2px_2px_0px_#111111]'
                      : 'border-slate-200/80 dark:border-slate-800 hover:border-[#111111]/40 dark:hover:border-slate-700'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActivePageId(pg.id);
                      setSelectedRegionId(pg.regions[0]?.id || null);
                      handleResetView();
                    }}
                    className="w-full text-start space-y-1 cursor-pointer"
                  >
                    <img
                      src={thumbSrc}
                      loading="lazy"
                      alt={`Page ${pg.pageNumber}`}
                      className="w-full h-24 object-contain rounded bg-slate-100 dark:bg-[#0D1117]"
                    />
                    <div className="flex items-center justify-between text-[11px] px-0.5">
                      <span className="font-mono-tabular font-semibold">#{pg.pageNumber}</span>
                      <span
                        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${statusBadgeStyle(
                          pg.status
                        )}`}
                      >
                        {pg.status === 'completed' && <CheckCircle2 className="w-2.5 h-2.5" />}
                        {pg.status === 'error' && <XCircle className="w-2.5 h-2.5" />}
                        {(pg.status === 'analyzing' || pg.status === 'translating') && (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        )}
                        <span className="font-mono-tabular">{pg.regions.length}</span>
                      </span>
                    </div>
                  </button>

                  {reviewCount > 0 && (
                    <div className="text-[10px] text-amber-600 dark:text-amber-400 font-medium px-0.5">
                      {reviewCount} {t.studio.reviewCount}
                    </div>
                  )}

                  {isCurrent && (
                    <div className="space-y-1.5 pt-1 border-t border-slate-200/70 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-0.5">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => void handleMovePage(pg.id, -1)}
                          aria-label={`${t.studio.pageActions.moveUp} #${pg.pageNumber}`}
                          title={t.studio.pageActions.moveUp}
                          className="p-0.5 text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === pages.length - 1}
                          onClick={() => void handleMovePage(pg.id, 1)}
                          aria-label={`${t.studio.pageActions.moveDown} #${pg.pageNumber}`}
                          title={t.studio.pageActions.moveDown}
                          className="p-0.5 text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRotatePage(pg)}
                          aria-label={`${t.studio.pageActions.rotate} #${pg.pageNumber}`}
                          title={t.studio.pageActions.rotate}
                          className="p-0.5 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                        >
                          <RotateCw className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReplacingPageId(pg.id);
                            replaceInputRef.current?.click();
                          }}
                          aria-label={`${t.studio.replaceImage} #${pg.pageNumber}`}
                          title={t.studio.replaceImage}
                          className="p-0.5 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                        >
                          <ImagePlus className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDuplicatePage(pg.id)}
                          aria-label={`${t.studio.pageActions.duplicate} #${pg.pageNumber}`}
                          title={t.studio.pageActions.duplicate}
                          className="p-0.5 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={pages.length <= 1}
                          onClick={() => void handleDeletePage(pg.id)}
                          aria-label={`${t.studio.pageActions.delete} #${pg.pageNumber}`}
                          title={t.studio.pageActions.delete}
                          className="p-0.5 text-rose-500 hover:text-rose-700 disabled:opacity-30 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                        <span>#</span>
                        <input
                          type="number"
                          min={1}
                          max={pages.length}
                          aria-label={`Page order ${pg.pageNumber}`}
                          value={orderDraft}
                          onChange={(e) =>
                            setPageOrderDrafts((prev) => ({ ...prev, [pg.id]: e.target.value }))
                          }
                          onBlur={() => void handleMovePageToOrder(pg.id, orderDraft)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                          className="w-12 px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117] text-center font-mono-tabular text-[11px]"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {activePage.lastTranslationMeta && (
            <div
              data-testid="page-translation-meta"
              className="px-3 py-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5 bg-slate-50/70 dark:bg-[#0D1117]/70 shrink-0"
            >
              <div className="flex items-center justify-between gap-1">
                <span>{t.studio.lastTranslatedBy}</span>
                {activePage.lastTranslationMeta.fallbackUsed && (
                  <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                    {t.studio.fallbackBadge}
                  </span>
                )}
              </div>
              <div
                dir="ltr"
                title={`${activePage.lastTranslationMeta.providerUsed} · ${activePage.lastTranslationMeta.modelUsed}`}
                className="font-mono text-[10px] text-slate-700 dark:text-slate-300 truncate"
              >
                {PROVIDER_DISPLAY_NAMES[activePage.lastTranslationMeta.providerUsed] ||
                  activePage.lastTranslationMeta.providerUsed}{' '}
                · {activePage.lastTranslationMeta.modelUsed}
              </div>
              {activePage.lastTranslationMeta.visionModelUsed && (
                <div
                  dir="ltr"
                  className="font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate"
                >
                  OCR: {activePage.lastTranslationMeta.visionProviderUsed || ''} ·{' '}
                  {activePage.lastTranslationMeta.visionModelUsed}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* Central Interactive Canvas */}
        <BubbleCanvas
          page={activePage}
          selectedRegionId={selectedRegionId}
          toolMode={toolMode}
          brushSize={brushSize}
          brushColor={brushColor}
          zoom={zoom}
          resetSignal={resetSignal}
          compareOriginal={compareOriginal}
          showRegionOverlays={showGuides}
          inpaintingEngine={aiSettings.inpaintingEngine}
          onSelectRegion={setSelectedRegionId}
          onUpdateRegionGeometry={handleUpdateGeometry}
          onCreateRegion={(box) => void handleCreateRegion(box)}
          onAddManualStroke={handleAddStroke}
          onRegionAudits={setRegionAudits}
          onCompositeRendered={handleCompositeRendered}
        />

        {/* Right Bubble & Context Inspector */}
        <BubbleInspector
          lang={lang}
          project={project}
          region={selectedRegion}
          regionAudit={selectedRegion ? regionAudits[selectedRegion.id] : undefined}
          availableFonts={availableFonts}
          busyRegionAction={busyAction}
          onUpdateRegion={handleUpdateRegion}
          onUpdateFont={handleUpdateFont}
          onRetranslateBubble={async (regionId, style, instruction) => {
            setBusyAction(true);
            setStatusError('');
            try {
              const res = await api.retranslateBubble(regionId, style, instruction);
              if (res?.page) {
                setPages((all) => all.map((p) => (p && p.id === activePage.id ? res.page : p)));
              }
            } catch (err) {
              setStatusError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusyAction(false);
            }
          }}
          onDeleteRegion={async (regionId) => {
            const res = await api.deleteBubble(regionId);
            if (res?.page) {
              setPages((all) => all.map((p) => (p && p.id === activePage.id ? res.page : p)));
            }
            setSelectedRegionId(null);
          }}
          onSaveStoryNotes={async (notes) => {
            const updatedMemory = { ...project.storyMemory, recurringNotes: notes };
            const res = await api.updateProject(project.id, { storyMemory: updatedMemory });
            setProject(res.project);
          }}
        />
      </div>

      <ExportModal
        lang={lang}
        isOpen={exportOpen}
        chapterTitle={chapter.title}
        pages={pages}
        currentPageNumber={activePage.pageNumber}
        readingDirection={project.readingDirection}
        inpaintingEngine={aiSettings.inpaintingEngine}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
};
