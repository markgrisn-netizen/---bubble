import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileArchive,
  FolderOpen,
  Globe,
  GripVertical,
  ImagePlus,
  KeyRound,
  Link2,
  Loader2,
  MinusCircle,
  Puzzle,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
  Upload,
  X,
  XCircle,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  ComicFormat,
  LanguageCode,
  ProjectWithDetails,
  ReadingDirection,
  TranslationStyle,
} from '../types/domain';
import { tFor } from '../i18n/translations';
import {
  fileToImportedPageAsset,
  importFilesToPages,
  rotateImageAsset90,
  type ImportedPageAsset,
} from '../utils/fileImport';
import {
  buildDuplicatePreventedMessage,
  filterAndDeduplicatePickedAssets,
  NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS,
} from '../utils/nativeImagePicker';
import {
  clearStagedPickerDraft,
  loadStagedPickerDraft,
  saveStagedPickerDraft,
} from '../utils/offlineDb';
import { annotateDuplicatesByHash, deduplicateByHash } from '../utils/pageBatchUtils';
import {
  api,
  ApiRequestError,
  type ImportStageDiagnostic,
  type UrlInspectResponse,
} from '../utils/api';

interface ImportModalProps {
  lang: LanguageCode;
  isOpen: boolean;
  initialTab: 'files' | 'url' | 'companion';
  initialProjectId?: string;
  appendChapterId?: string;
  appendChapterTitle?: string;
  appendReadingDirection?: ReadingDirection;
  presetFormat?: ComicFormat;
  presetDirection?: ReadingDirection;
  projects: ProjectWithDetails[];
  newProjectOnly?: boolean;
  onClose: () => void;
  onImportedChapter: (chapterId: string) => Promise<void>;
}

export const ImportModal: React.FC<ImportModalProps> = ({
  lang,
  isOpen,
  initialTab,
  initialProjectId,
  appendChapterId,
  appendChapterTitle,
  appendReadingDirection,
  presetFormat,
  presetDirection,
  projects,
  newProjectOnly = false,
  onClose,
  onImportedChapter,
}) => {
  const t = tFor(lang);
  const isAppendMode = Boolean(appendChapterId);

  const [tab, setTab] = useState<'files' | 'url' | 'companion'>(initialTab);
  const [targetMode, setTargetMode] = useState<'new' | 'existing'>(
    initialProjectId ? 'existing' : projects.length > 0 ? 'existing' : 'new'
  );
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialProjectId || projects[0]?.id || ''
  );

  const [projectTitle, setProjectTitle] = useState('');
  const [chapterTitle, setChapterTitle] = useState(lang === 'ar' ? 'العدد #01' : 'Issue #01');
  const [comicFormat, setComicFormat] = useState<ComicFormat>('superhero');
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('ar');
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>('ltr');
  const [translationStyle, setTranslationStyle] = useState<TranslationStyle>('cinematic');

  // Staging / File import state
  const [extractedPages, setExtractedPages] = useState<ImportedPageAsset[]>([]);
  const [stagingOrderMode, setStagingOrderMode] = useState<ReadingDirection>('ltr');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [extractProgress, setExtractProgress] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState<{ pct: number; uploaded: number; total: number } | null>(null);
  const [pickerNotice, setPickerNotice] = useState<{ kind: 'info' | 'warning'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Direct URL import state
  const [chapterUrl, setChapterUrl] = useState('');
  const [customCookie, setCustomCookie] = useState('');
  const [showSessionOptions, setShowSessionOptions] = useState(false);
  const [inspectMeta, setInspectMeta] = useState<UrlInspectResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<ImportStageDiagnostic[]>([]);
  const [failureContext, setFailureContext] = useState<{
    category?: string;
    stage?: string;
    httpStatus?: number;
  } | null>(null);
  const [previewErrors, setPreviewErrors] = useState<Record<number, boolean>>({});
  const [urlImages, setUrlImages] = useState<
    Array<{ index: number; url: string; alt: string; selected: boolean; referer?: string }>
  >([]);

  // Browser Companion session state
  const [companionSession, setCompanionSession] = useState<{
    id: string;
    pairingBundle: string;
    status: 'waiting' | 'collecting' | 'completed' | 'expired';
    pages: Array<{
      id: string;
      pageNumber: number;
      imageUrl: string;
      width: number;
      height: number;
      captureMethod: string;
    }>;
    chapterId?: string;
  } | null>(null);
  const [copiedPairing, setCopiedPairing] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  const imagePickerInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetIdxRef = useRef<number | null>(null);
  const existingChapterHashesRef = useRef<string[]>([]);
  const wasOpenRef = useRef(false);

  const draftStorageKey =
    isAppendMode && appendChapterId ? `faqqa_picker_append_${appendChapterId}` : 'faqqa_picker_new';

  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!justOpened) return;

    setTab(isAppendMode ? 'files' : initialTab);
    setErrorMsg('');
    setPickerNotice(null);
    setUploadProgress(null);
    setPreviewIndex(null);
    setPreviewZoom(1);
    existingChapterHashesRef.current = [];

    if (isAppendMode && appendChapterId) {
      void api
        .getChapter(appendChapterId)
        .then((res) => {
          existingChapterHashesRef.current = res.pages
            .map((p) => p.contentHash || '')
            .filter(Boolean);
        })
        .catch(() => {
          existingChapterHashesRef.current = [];
        });
    }

    if (isAppendMode) {
      setExtractedPages([]);
      setStagingOrderMode(appendReadingDirection || 'ltr');
      setReadingDirection(appendReadingDirection || 'ltr');
    } else if (newProjectOnly) {
      setTargetMode('new');
      if (presetFormat) setComicFormat(presetFormat);
      if (presetDirection) {
        setReadingDirection(presetDirection);
        setStagingOrderMode(presetDirection);
      }
    } else if (initialProjectId) {
      setTargetMode('existing');
      setSelectedProjectId(initialProjectId);
      const matched = projects.find((p) => p.id === initialProjectId);
      if (matched) {
        setReadingDirection(matched.readingDirection);
        setStagingOrderMode(matched.readingDirection);
      }
    } else if (projects.length > 0) {
      setTargetMode('existing');
      if (!selectedProjectId) {
        setSelectedProjectId(projects[0].id);
      }
    } else {
      setTargetMode('new');
    }

    void loadStagedPickerDraft(draftStorageKey).then((saved) => {
      if (saved.length > 0) {
        setExtractedPages(saved);
      }
    });
  }, [
    isOpen,
    initialTab,
    initialProjectId,
    newProjectOnly,
    projects,
    selectedProjectId,
    isAppendMode,
    appendChapterId,
    appendReadingDirection,
    presetFormat,
    presetDirection,
    draftStorageKey,
  ]);

  // Live poll Browser Companion session while waiting/collecting
  useEffect(() => {
    if (!isOpen || tab !== 'companion' || !companionSession?.id) return;
    if (companionSession.status === 'completed' || companionSession.status === 'expired') return;

    const timer = window.setInterval(async () => {
      try {
        const res = await api.getBrowserSession(companionSession.id);
        setCompanionSession((prev) =>
          prev
            ? {
                ...prev,
                status: res.session.status,
                pages: res.session.pages,
                chapterId: res.session.chapterId,
              }
            : prev
        );
      } catch {
        // Ignore transient poll errors
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isOpen, tab, companionSession?.id, companionSession?.status]);

  const annotatedPages = useMemo(
    () => annotateDuplicatesByHash(extractedPages),
    [extractedPages]
  );
  const duplicateCount = useMemo(
    () => annotatedPages.filter((p) => p.isDuplicate).length,
    [annotatedPages]
  );

  if (!isOpen) return null;

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg('');
    setPickerNotice(null);
    setBusy(true);
    try {
      // Immediately materialize File bytes, dataUrl, and SHA-256 hash in onChange
      const assets = await importFilesToPages(Array.from(fileList), (pct, statusText) => {
        setExtractProgress(`${pct}% · ${statusText}`);
      });
      if (assets.length === 0) {
        setErrorMsg(
          lang === 'ar'
            ? 'لم يتم العثور على صور صالحة في الملفات المختارة.'
            : 'No valid images found in selected files.'
        );
      } else {
        const existingHashes = [
          ...existingChapterHashesRef.current,
          ...extractedPages.map((p) => p.contentHash).filter(Boolean),
        ];
        const { accepted, skippedDuplicateCount } = filterAndDeduplicatePickedAssets(
          existingHashes,
          assets
        );

        const nextPages = accepted.length > 0 ? [...extractedPages, ...accepted] : extractedPages;
        if (accepted.length > 0) {
          setExtractedPages(nextPages);
          void saveStagedPickerDraft(draftStorageKey, nextPages);
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
                ? `تمت إضافة ${accepted.length} ${accepted.length === 1 ? 'صورة' : 'صور'} إلى القائمة بنجاح.`
                : `Added ${accepted.length} image(s) to the list.`,
          });
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setExtractProgress('');
      if (imagePickerInputRef.current) imagePickerInputRef.current.value = '';
      if (archiveInputRef.current) archiveInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const handleMoveStagedPage = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || toIdx < 0 || toIdx >= extractedPages.length) return;
    setExtractedPages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      void saveStagedPickerDraft(draftStorageKey, next);
      return next;
    });
  };

  const handleRotateStagedPage = async (idx: number) => {
    const target = extractedPages[idx];
    if (!target) return;
    try {
      const rotated = await rotateImageAsset90(target);
      setExtractedPages((prev) => {
        const next = prev.map((p, i) => (i === idx ? rotated : p));
        void saveStagedPickerDraft(draftStorageKey, next);
        return next;
      });
    } catch {
      // Ignore rotation failure
    }
  };

  const handleReplaceStagedFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const targetIdx = replaceTargetIdxRef.current;
    e.target.value = '';
    replaceTargetIdxRef.current = null;
    if (!file || targetIdx === null) return;
    try {
      const nextAsset = await fileToImportedPageAsset(file);
      setExtractedPages((prev) => {
        const next = prev.map((p, i) => (i === targetIdx ? nextAsset : p));
        void saveStagedPickerDraft(draftStorageKey, next);
        return next;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCloseWithCleanup = () => {
    setExtractedPages([]);
    setPickerNotice(null);
    void clearStagedPickerDraft(draftStorageKey);
    onClose();
  };

  const handleInspectUrl = async () => {
    if (!chapterUrl.trim()) return;
    setErrorMsg('');
    setFailureContext(null);
    setDiagnostics([]);
    setInspectMeta(null);
    setUrlImages([]);
    setPreviewErrors({});
    setBusy(true);
    try {
      const res = await api.inspectUrl(chapterUrl.trim(), customCookie.trim() || undefined);
      setInspectMeta(res);
      setDiagnostics(res.diagnostics || []);
      setUrlImages(res.images);
      if (res.pageTitle && (!chapterTitle.trim() || chapterTitle === 'الفصل 01' || chapterTitle === 'Chapter 01')) {
        setChapterTitle(res.pageTitle);
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMsg(err.message);
        setDiagnostics(err.diagnostics || []);
        setFailureContext({
          category: err.category,
          stage: err.stage,
          httpStatus: err.httpStatus,
        });
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleStartCompanionSession = async () => {
    setErrorMsg('');
    if (targetMode === 'new' && !projectTitle.trim()) {
      setErrorMsg(lang === 'ar' ? 'يرجى إدخال اسم العمل أولاً.' : 'Please enter a series title first.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createBrowserSession({
        projectId: targetMode === 'existing' ? selectedProjectId : undefined,
        newProjectConfig:
          targetMode === 'new'
            ? {
                title: projectTitle.trim(),
                comicFormat,
                sourceLanguage,
                targetLanguage,
                readingDirection,
                translationStyle,
              }
            : undefined,
        chapterTitle: chapterTitle.trim() || (lang === 'ar' ? 'فصل من المتصفح' : 'Browser Chapter'),
        targetUrl: chapterUrl.trim() || undefined,
      });
      setCompanionSession({
        id: res.session.id,
        pairingBundle: res.pairingBundle,
        status: res.session.status,
        pages: res.session.pages,
        chapterId: res.session.chapterId,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenInBrowserFallback = async () => {
    setErrorMsg('');
    setFailureContext(null);
    setTab('companion');
    if (!companionSession && (targetMode === 'existing' || projectTitle.trim())) {
      await handleStartCompanionSession();
    }
  };

  const handleCompleteCompanionImport = async () => {
    if (!companionSession) return;
    if (companionSession.status === 'completed' && companionSession.chapterId) {
      await onImportedChapter(companionSession.chapterId);
      onClose();
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      const res = await api.completeBrowserSession(companionSession.id, chapterTitle.trim());
      await onImportedChapter(res.chapter.id);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateOrImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (isAppendMode && appendChapterId) {
      if (extractedPages.length === 0) {
        setErrorMsg(
          lang === 'ar'
            ? 'يرجى اختيار صفحة واحدة على الأقل لإضافتها للفصل.'
            : 'Please add at least one image to append.'
        );
        return;
      }
      setBusy(true);
      setUploadProgress({ pct: 0, uploaded: 0, total: extractedPages.length });
      try {
        await api.appendChapterPages(
          appendChapterId,
          extractedPages.map((p) => ({
            dataUrl: p.dataUrl,
            width: p.width,
            height: p.height,
            contentHash: p.contentHash,
          })),
          (pct, uploaded, total) => setUploadProgress({ pct, uploaded, total })
        );
        void clearStagedPickerDraft(draftStorageKey);
        setExtractedPages([]);
        await onImportedChapter(appendChapterId);
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setUploadProgress(null);
      }
      return;
    }

    if (tab === 'companion') {
      await handleCompleteCompanionImport();
      return;
    }

    if (targetMode === 'new' && !projectTitle.trim()) {
      setErrorMsg(lang === 'ar' ? 'يرجى إدخال اسم العمل.' : 'Please enter a series title.');
      return;
    }

    if (!newProjectOnly) {
      if (tab === 'files' && extractedPages.length === 0) {
        setErrorMsg(
          lang === 'ar'
            ? 'يرجى رفع صورة أو فصل ZIP/CBZ/PDF أولاً.'
            : 'Please upload at least one image or archive first.'
        );
        return;
      }
      if (tab === 'url' && urlImages.filter((u) => u.selected).length === 0) {
        setErrorMsg(
          lang === 'ar'
            ? 'يرجى فحص الرابط واختيار صفحة واحدة على الأقل.'
            : 'Please inspect a URL and select at least one page.'
        );
        return;
      }
    }

    setBusy(true);
    try {
      let projectId = selectedProjectId;
      if (targetMode === 'new' || !projectId) {
        const created = await api.createProject({
          title: projectTitle.trim(),
          comicFormat,
          sourceLanguage,
          targetLanguage,
          readingDirection: stagingOrderMode || readingDirection,
          translationStyle,
        });
        projectId = created.project.id;
      }

      if (newProjectOnly && extractedPages.length === 0 && urlImages.length === 0) {
        await onImportedChapter('');
        onClose();
        return;
      }

      if (tab === 'files') {
        setUploadProgress({ pct: 0, uploaded: 0, total: extractedPages.length });
        const res = await api.uploadChapter(
          {
            projectId,
            title: chapterTitle.trim() || 'Chapter 01',
            pages: extractedPages.map((p) => ({
              dataUrl: p.dataUrl,
              width: p.width,
              height: p.height,
              contentHash: p.contentHash,
            })),
          },
          (pct, uploaded, total) => setUploadProgress({ pct, uploaded, total })
        );
        await onImportedChapter(res.chapter.id);
      } else {
        const selectedUrls = urlImages.filter((u) => u.selected).map((u) => u.url);
        const res = await api.importUrlChapter({
          projectId,
          title: chapterTitle.trim() || 'Imported Chapter',
          sourceUrl: chapterUrl.trim(),
          selectedImageUrls: selectedUrls,
          requiredReferer: inspectMeta?.requiredReferer,
          customCookie: customCookie.trim() || undefined,
        });
        await onImportedChapter(res.chapter.id);
      }
      void clearStagedPickerDraft(draftStorageKey);
      setExtractedPages([]);
      onClose();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrorMsg(err.message);
        if (err.diagnostics?.length) setDiagnostics(err.diagnostics);
        setFailureContext({
          category: err.category,
          stage: err.stage,
          httpStatus: err.httpStatus,
        });
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const previewAsset = previewIndex !== null ? extractedPages[previewIndex] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        isAppendMode
          ? t.importModal.appendToChapterTitle
          : newProjectOnly
          ? t.home.btnNewProject
          : t.importModal.title
      }
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 overflow-y-auto"
    >
      <div className="w-full max-w-4xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22] shadow-xl overflow-hidden my-auto">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              {isAppendMode
                ? `${t.importModal.appendToChapterTitle}${appendChapterTitle ? ` · ${appendChapterTitle}` : ''}`
                : newProjectOnly
                ? t.home.btnNewProject
                : t.importModal.title}
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {t.importModal.openEndedHint}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCloseWithCleanup}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleCreateOrImport} className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Project/Chapter setup hidden in append mode */}
          {!isAppendMode && (
            <>
              {!newProjectOnly && projects.length > 0 && (
                <div className="flex items-center gap-2 p-1 rounded-lg bg-slate-100 dark:bg-[#0D1117] w-fit">
                  <button
                    type="button"
                    onClick={() => setTargetMode('new')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                      targetMode === 'new'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {t.importModal.createNewProject}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTargetMode('existing')}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                      targetMode === 'existing'
                        ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {t.importModal.existingProject}
                  </button>
                </div>
              )}

              {targetMode === 'existing' && projects.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.projectTarget}
                    </label>
                    <select
                      value={selectedProjectId}
                      onChange={(e) => {
                        setSelectedProjectId(e.target.value);
                        const proj = projects.find((p) => p.id === e.target.value);
                        if (proj) {
                          setReadingDirection(proj.readingDirection);
                          setStagingOrderMode(proj.readingDirection);
                        }
                      }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.chapterTitle}
                    </label>
                    <input
                      type="text"
                      value={chapterTitle}
                      onChange={(e) => setChapterTitle(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.projectTitle} *
                    </label>
                    <input
                      type="text"
                      required
                      value={projectTitle}
                      onChange={(e) => setProjectTitle(e.target.value)}
                      placeholder={lang === 'ar' ? 'مثال: طليعة القمة — Apex Vanguard' : 'e.g. Apex Vanguard'}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.chapterTitle}
                    </label>
                    <input
                      type="text"
                      value={chapterTitle}
                      onChange={(e) => setChapterTitle(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.comicFormat}
                    </label>
                    <select
                      value={comicFormat}
                      onChange={(e) => {
                        const fmt = e.target.value as ComicFormat;
                        setComicFormat(fmt);
                        const nextDir: ReadingDirection =
                          fmt === 'webtoon' || fmt === 'manhwa'
                            ? 'vertical'
                            : fmt === 'manga'
                            ? 'rtl'
                            : 'ltr';
                        setReadingDirection(nextDir);
                        setStagingOrderMode(nextDir);
                      }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    >
                      <option value="superhero">{t.home.filters.superhero}</option>
                      <option value="american">{t.home.filters.american}</option>
                      <option value="british">{t.home.filters.british}</option>
                      <option value="european">{t.home.filters.european}</option>
                      <option value="graphic_novel">{t.home.filters.graphic_novel}</option>
                      <option value="indie">{t.home.filters.indie}</option>
                      <option value="manga">{t.home.filters.manga}</option>
                      <option value="manhwa">{t.home.filters.manhwa}</option>
                      <option value="manhua">{t.home.filters.manhua}</option>
                      <option value="webtoon">{t.home.filters.webtoon}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.readingDir}
                    </label>
                    <select
                      value={readingDirection}
                      onChange={(e) => {
                        const dir = e.target.value as ReadingDirection;
                        setReadingDirection(dir);
                        setStagingOrderMode(dir);
                      }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    >
                      <option value="ltr">{t.importModal.dirLtr}</option>
                      <option value="rtl">{t.importModal.dirRtl}</option>
                      <option value="vertical">{t.importModal.dirVertical}</option>
                    </select>
                  </div>

                  {/* 1-Click Primary Language Pair Presets */}
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.primaryPairLabel}
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSourceLanguage('en');
                          setTargetLanguage('ar');
                          if (comicFormat === 'manga') setComicFormat('superhero');
                          setReadingDirection('ltr');
                          setStagingOrderMode('ltr');
                        }}
                        className={`px-3 py-2 rounded-xl border-2 text-xs font-extrabold transition-colors cursor-pointer ${
                          sourceLanguage === 'en' && targetLanguage === 'ar'
                            ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                            : 'border-[#111111]/20 dark:border-white/20 hover:border-[#111111] dark:hover:border-[#FFE01B]'
                        }`}
                      >
                        {t.importModal.presetEnAr}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSourceLanguage('ar');
                          setTargetLanguage('en');
                          if (comicFormat === 'manga') setComicFormat('superhero');
                          setReadingDirection('ltr');
                          setStagingOrderMode('ltr');
                        }}
                        className={`px-3 py-2 rounded-xl border-2 text-xs font-extrabold transition-colors cursor-pointer ${
                          sourceLanguage === 'ar' && targetLanguage === 'en'
                            ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                            : 'border-[#111111]/20 dark:border-white/20 hover:border-[#111111] dark:hover:border-[#FFE01B]'
                        }`}
                      >
                        {t.importModal.presetArEn}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.sourceLang}
                    </label>
                    <select
                      value={sourceLanguage}
                      onChange={(e) => setSourceLanguage(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    >
                      <option value="en">English</option>
                      <option value="ar">العربية (Arabic)</option>
                      <option value="fr">French (Bande Dessinée)</option>
                      <option value="ja">Japanese (Secondary Manga)</option>
                      <option value="ko">Korean (Secondary Manhwa)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.importModal.targetLang}
                    </label>
                    <select
                      value={targetLanguage}
                      onChange={(e) => setTargetLanguage(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    >
                      <option value="ar">العربية الفصحى (Arabic)</option>
                      <option value="en">English (Comic Lettering)</option>
                    </select>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                      {t.studio.inspector.translationStyle}
                    </label>
                    <select
                      value={translationStyle}
                      onChange={(e) => setTranslationStyle(e.target.value as TranslationStyle)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                    >
                      {Object.entries(t.styles).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Import Source Tabs */}
          <div className={`${!isAppendMode ? 'border-t border-slate-200 dark:border-slate-800 pt-4' : ''} space-y-4`}>
            {!isAppendMode && (
              <div className="flex flex-wrap items-center gap-1.5 border-b-2 border-[#111111]/15 dark:border-white/15 pb-2">
                <button
                  type="button"
                  onClick={() => setTab('url')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-extrabold rounded-xl border-2 whitespace-nowrap cursor-pointer ${
                    tab === 'url'
                      ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'border-transparent text-[#524E46] dark:text-slate-300 hover:bg-[#FAF5E8] dark:hover:bg-[#22242C]'
                  }`}
                >
                  <Link2 className="w-4 h-4" />
                  <span>{t.importModal.tabUrl}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('companion')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-extrabold rounded-xl border-2 whitespace-nowrap cursor-pointer ${
                    tab === 'companion'
                      ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'border-transparent text-[#524E46] dark:text-slate-300 hover:bg-[#FAF5E8] dark:hover:bg-[#22242C]'
                  }`}
                >
                  <Puzzle className="w-4 h-4" />
                  <span>{t.importModal.tabCompanion}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('files')}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-extrabold rounded-xl border-2 whitespace-nowrap cursor-pointer ${
                    tab === 'files'
                      ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'border-transparent text-[#524E46] dark:text-slate-300 hover:bg-[#FAF5E8] dark:hover:bg-[#22242C]'
                  }`}
                >
                  <FileArchive className="w-4 h-4" />
                  <span>{t.importModal.tabFiles}</span>
                </button>
              </div>
            )}

            {tab === 'files' || isAppendMode ? (
              <div className="space-y-4">
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void handleFilesSelected(e.dataTransfer.files);
                  }}
                  className="rounded-2xl border-2 border-dashed border-[#111111]/40 dark:border-white/25 bg-[#FAF5E8]/80 dark:bg-[#111216] p-5 text-center space-y-3"
                >
                  <Upload className="w-8 h-8 mx-auto text-[#EA3829]" />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {t.importModal.dropzoneTitle}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t.importModal.dropzoneSub}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      data-testid="import-add-images-btn"
                      onClick={() => imagePickerInputRef.current?.click()}
                      className="faqqa-btn-yellow inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <ImagePlus className="w-4 h-4" />
                      <span>{t.importModal.pickImages}</span>
                    </button>
                    <button
                      type="button"
                      data-testid="import-archive-btn"
                      onClick={() => archiveInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border-2 border-[#111111]/20 dark:border-slate-700 text-xs font-bold hover:border-[#111111] dark:hover:bg-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FileArchive className="w-4 h-4 text-[#EA3829]" />
                      <span>{t.importModal.pickArchives}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => folderInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white dark:bg-slate-800 border-2 border-[#111111]/20 dark:border-slate-700 text-xs font-bold hover:border-[#111111] dark:hover:bg-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <FolderOpen className="w-4 h-4" />
                      <span>{t.importModal.pickFolder}</span>
                    </button>
                  </div>
                  <input
                    ref={imagePickerInputRef}
                    {...NATIVE_ANDROID_PHOTO_PICKER_INPUT_PROPS}
                    data-testid="import-native-image-input"
                    aria-label={t.importModal.pickImages}
                    onChange={(e) => void handleFilesSelected(e.target.files)}
                    className="hidden"
                  />
                  <input
                    ref={archiveInputRef}
                    type="file"
                    multiple
                    accept=".pdf,.zip,.cbz,application/pdf,application/zip"
                    aria-label={t.importModal.pickArchives}
                    onChange={(e) => void handleFilesSelected(e.target.files)}
                    className="hidden"
                  />
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                    onChange={(e) => void handleFilesSelected(e.target.files)}
                    className="hidden"
                  />
                  <input
                    ref={replaceInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => void handleReplaceStagedFile(e)}
                    className="hidden"
                  />
                </div>

                {extractProgress && (
                  <div className="flex items-center gap-2 text-xs font-bold text-[#111111] dark:text-[#FFE01B]">
                    <Loader2 className="w-4 h-4 animate-spin text-[#EA3829]" />
                    <span>{extractProgress}</span>
                  </div>
                )}

                {pickerNotice && (
                  <div
                    role="alert"
                    data-testid="import-picker-notice"
                    className={`p-2.5 rounded-xl border-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold ${
                      pickerNotice.kind === 'warning'
                        ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/50 text-amber-900 dark:text-amber-100'
                        : 'border-[#111111]/25 bg-[#FFE01B]/25 dark:bg-[#FFE01B]/10 text-[#111111] dark:text-[#FFE01B]'
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
                      className="underline font-bold cursor-pointer"
                    >
                      {lang === 'ar' ? 'إغلاق' : 'Dismiss'}
                    </button>
                  </div>
                )}

                {/* 3 Explicit Ordering / Display Modes */}
                <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-xl border-2 border-[#111111]/15 dark:border-white/15 bg-[#FAF5E8]/80 dark:bg-[#14151A]">
                  <span className="text-xs font-extrabold text-[#111111] dark:text-[#FFFDF9]">
                    {t.importModal.orderModeLabel}:
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        { id: 'ltr', label: t.importModal.modeLtr },
                        { id: 'rtl', label: t.importModal.modeRtl },
                        { id: 'vertical', label: t.importModal.modeVertical },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={stagingOrderMode === m.id}
                        onClick={() => {
                          setStagingOrderMode(m.id);
                          setReadingDirection(m.id);
                        }}
                        className={`px-2.5 py-1 rounded-xl border-2 text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer ${
                          stagingOrderMode === m.id
                            ? 'border-[#111111] bg-[#FFE01B] text-[#111111] shadow-[2px_2px_0px_#111111]'
                            : 'border-[#111111]/20 dark:border-white/20 text-[#524E46] dark:text-slate-300'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Duplicate SHA-256 Warning Banner */}
                {duplicateCount > 0 && (
                  <div className="p-2.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900 dark:text-amber-100">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                      <span>
                        {t.importModal.duplicateAlert} (<strong className="font-mono-tabular">{duplicateCount}</strong>)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setExtractedPages((prev) => {
                          const next = deduplicateByHash(prev);
                          void saveStagedPickerDraft(draftStorageKey, next);
                          return next;
                        })
                      }
                      className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {t.importModal.removeDuplicates}
                    </button>
                  </div>
                )}

                {extractedPages.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                      <span>
                        {t.importModal.detectedPages}:{' '}
                        <strong className="font-mono-tabular text-slate-900 dark:text-white">
                          {extractedPages.length}
                        </strong>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setExtractedPages([]);
                          void clearStagedPickerDraft(draftStorageKey);
                        }}
                        className="text-rose-600 hover:underline cursor-pointer"
                      >
                        {t.importModal.deselectAll}
                      </button>
                    </div>
                    <div
                      dir={stagingOrderMode === 'rtl' ? 'rtl' : 'ltr'}
                      className={
                        stagingOrderMode === 'vertical'
                          ? 'flex flex-col gap-2 max-h-72 overflow-y-auto p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117]'
                          : 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2.5 max-h-72 overflow-y-auto p-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117]'
                      }
                    >
                      {annotatedPages.map((pg, idx) => (
                        <div
                          key={pg.id}
                          dir="ltr"
                          draggable
                          onDragStart={() => setDragIndex(idx)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragIndex !== null && dragIndex !== idx) {
                              handleMoveStagedPage(dragIndex, idx);
                            }
                            setDragIndex(null);
                          }}
                          className={`relative rounded-lg overflow-hidden border bg-white dark:bg-[#161B22] p-1.5 space-y-1.5 ${
                            pg.isDuplicate
                              ? 'border-amber-500 ring-1 ring-amber-400'
                              : 'border-slate-200 dark:border-slate-700'
                          } ${stagingOrderMode === 'vertical' ? 'flex items-center gap-3' : ''}`}
                        >
                          <div className={`relative ${stagingOrderMode === 'vertical' ? 'w-20 h-24 shrink-0' : 'w-full h-24'}`}>
                            <img
                              src={pg.dataUrl}
                              alt={pg.filename}
                              loading="lazy"
                              className="w-full h-full object-contain rounded bg-slate-100 dark:bg-[#0D1117]"
                            />
                            {pg.isDuplicate && (
                              <span className="absolute top-1 start-1 px-1 py-0.5 rounded bg-amber-600 text-white text-[9px] font-semibold">
                                {t.importModal.duplicateTag}
                              </span>
                            )}
                          </div>

                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center justify-between gap-1 text-[10px]">
                              <span className="inline-flex items-center gap-0.5 text-slate-400 cursor-grab" title="Drag to reorder">
                                <GripVertical className="w-3 h-3" />
                              </span>
                              <input
                                type="number"
                                min={1}
                                max={extractedPages.length}
                                value={idx + 1}
                                aria-label={`Order for ${pg.filename}`}
                                onChange={(e) => {
                                  const nextPos = Number(e.target.value) - 1;
                                  if (Number.isInteger(nextPos) && nextPos >= 0 && nextPos < extractedPages.length) {
                                    handleMoveStagedPage(idx, nextPos);
                                  }
                                }}
                                className="w-10 px-1 py-0.5 text-center font-mono-tabular rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117] text-[10px]"
                              />
                              <span className="truncate text-slate-500 dark:text-slate-400 flex-1 text-end">
                                {pg.filename}
                              </span>
                            </div>

                            <div className="flex items-center justify-between gap-0.5 pt-1 border-t border-slate-100 dark:border-slate-800">
                              <button
                                type="button"
                                title={t.importModal.previewZoom}
                                aria-label={`${t.importModal.previewZoom} ${pg.filename}`}
                                onClick={() => {
                                  setPreviewIndex(idx);
                                  setPreviewZoom(1);
                                }}
                                className="p-1 rounded text-slate-500 hover:text-[#111111] dark:hover:text-[#FFE01B] hover:bg-[#FFE01B]/30 cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                title={t.importModal.rotatePage}
                                aria-label={`${t.importModal.rotatePage} ${pg.filename}`}
                                onClick={() => void handleRotateStagedPage(idx)}
                                className="p-1 rounded text-slate-500 hover:text-[#111111] dark:hover:text-[#FFE01B] hover:bg-[#FFE01B]/30 cursor-pointer"
                              >
                                <RotateCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                title={t.importModal.replaceImage}
                                aria-label={`${t.importModal.replaceImage} ${pg.filename}`}
                                onClick={() => {
                                  replaceTargetIdxRef.current = idx;
                                  replaceInputRef.current?.click();
                                }}
                                className="p-1 rounded text-slate-500 hover:text-[#111111] dark:hover:text-[#FFE01B] hover:bg-[#FFE01B]/30 cursor-pointer"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                title={t.studio.pageActions.delete}
                                aria-label={`${t.studio.pageActions.delete} ${pg.filename}`}
                                onClick={() =>
                                  setExtractedPages((prev) => {
                                    const next = prev.filter((_, i) => i !== idx);
                                    void saveStagedPickerDraft(draftStorageKey, next);
                                    return next;
                                  })
                                }
                                className="p-1 rounded text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : tab === 'url' ? (
              <div className="space-y-3">
                <p className="text-xs text-slate-500 dark:text-slate-400">{t.importModal.urlNotice}</p>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={chapterUrl}
                    onChange={(e) => setChapterUrl(e.target.value)}
                    placeholder={t.importModal.urlPlaceholder}
                    aria-label={t.importModal.urlLabel}
                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                  />
                  <button
                    type="button"
                    disabled={busy || !chapterUrl.trim()}
                    onClick={handleInspectUrl}
                    className="faqqa-btn-black px-4 py-2 rounded-xl text-sm font-black disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : t.importModal.analyzeUrl}
                  </button>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowSessionOptions((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>{t.importModal.sessionOptions}</span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        showSessionOptions ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {showSessionOptions && (
                    <div className="mt-2 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117] space-y-1.5">
                      <input
                        type="text"
                        value={customCookie}
                        onChange={(e) => setCustomCookie(e.target.value)}
                        placeholder={t.importModal.cookiePlaceholder}
                        className="w-full px-3 py-1.5 text-xs font-mono rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22]"
                      />
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {t.importModal.cookieHelp}
                      </p>
                    </div>
                  )}
                </div>

                {inspectMeta && (
                  <div className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117] flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500 dark:text-slate-400">
                        {t.importModal.detectedAdapter}:
                      </span>
                      <strong className="font-semibold text-slate-900 dark:text-white">
                        {inspectMeta.adapterName}
                      </strong>
                      <code className="px-1.5 py-0.5 text-[11px] rounded bg-slate-200/70 dark:bg-slate-800 font-mono">
                        {inspectMeta.sourceMethod}
                      </code>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] font-mono-tabular text-slate-500 dark:text-slate-400">
                      <span>
                        {inspectMeta.redirectChain.length} {t.importModal.redirectsLabel}
                      </span>
                      <span>
                        {inspectMeta.cookiesCaptured} {t.importModal.cookiesLabel}
                      </span>
                    </div>
                  </div>
                )}

                {inspectMeta?.warnings && inspectMeta.warnings.length > 0 && (
                  <div className="p-2.5 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                    {inspectMeta.warnings.map((w, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                {urlImages.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span>
                        {t.importModal.detectedPages}:{' '}
                        <strong className="font-mono-tabular">
                          {urlImages.filter((u) => u.selected).length}/{urlImages.length}
                        </strong>
                      </span>
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setUrlImages((imgs) => imgs.map((im) => ({ ...im, selected: true })))
                          }
                          className="font-bold text-[#EA3829] hover:underline cursor-pointer"
                        >
                          {t.importModal.selectAll}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setUrlImages((imgs) => imgs.map((im) => ({ ...im, selected: false })))
                          }
                          className="text-slate-500 hover:underline cursor-pointer"
                        >
                          {t.importModal.deselectAll}
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 max-h-52 overflow-y-auto p-2 rounded-lg border border-slate-200 dark:border-slate-800">
                      {urlImages.map((img) => {
                        const proxySrc = `/api/chapters/import/proxy-image?url=${encodeURIComponent(
                          img.url
                        )}&referer=${encodeURIComponent(
                          img.referer || inspectMeta?.requiredReferer || chapterUrl.trim()
                        )}${
                          customCookie.trim()
                            ? `&cookie=${encodeURIComponent(customCookie.trim())}`
                            : ''
                        }`;
                        const hasPreviewErr = Boolean(previewErrors[img.index]);
                        return (
                          <button
                            key={img.index}
                            type="button"
                            onClick={() =>
                              setUrlImages((prev) =>
                                prev.map((x) =>
                                  x.index === img.index ? { ...x, selected: !x.selected } : x
                                )
                              )
                            }
                            className={`relative rounded border-2 overflow-hidden text-start cursor-pointer ${
                              img.selected
                                ? 'border-[#111111] ring-2 ring-[#FFE01B]'
                                : 'border-slate-200 dark:border-slate-700 opacity-50'
                            }`}
                          >
                            {hasPreviewErr ? (
                              <div className="w-full h-24 bg-slate-100 dark:bg-slate-900 flex flex-col items-center justify-center p-1 text-center text-[10px] text-amber-700 dark:text-amber-300">
                                <AlertTriangle className="w-4 h-4 mb-1" />
                                <span className="line-clamp-2">{t.importModal.previewProxyError}</span>
                              </div>
                            ) : (
                              <img
                                src={proxySrc}
                                alt={img.alt}
                                onError={() =>
                                  setPreviewErrors((prev) => ({ ...prev, [img.index]: true }))
                                }
                                className="w-full h-24 object-cover bg-slate-100 dark:bg-slate-900"
                              />
                            )}
                            <div className="p-1 flex items-center justify-between text-[10px] font-mono-tabular">
                              <span>#{img.index}</span>
                              {img.selected ? (
                                <CheckSquare className="w-3.5 h-3.5 text-[#EA3829]" />
                              ) : (
                                <Square className="w-3.5 h-3.5 text-slate-400" />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {diagnostics.length > 0 && (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0D1117]/70 p-3 space-y-2">
                    <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                      {t.importModal.diagnosticsTitle}
                    </div>
                    <div className="space-y-1.5">
                      {diagnostics.map((d, idx) => (
                        <div
                          key={`${d.stage}-${idx}`}
                          className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-400"
                        >
                          {d.status === 'ok' && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                          )}
                          {d.status === 'warn' && (
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                          )}
                          {d.status === 'failed' && (
                            <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                          )}
                          {d.status === 'skipped' && (
                            <MinusCircle className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">
                              {d.stage}
                            </span>
                            {typeof d.httpStatus === 'number' && (
                              <span className="mx-1.5 font-mono text-[10px] text-slate-500">
                                HTTP {d.httpStatus}
                              </span>
                            )}
                            {typeof d.latencyMs === 'number' && (
                              <span className="font-mono text-[10px] text-slate-400">
                                ({d.latencyMs}ms)
                              </span>
                            )}
                            <span className="mx-1 text-slate-500">—</span>
                            <span className="break-words">{d.detail}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {t.importModal.companionExplain}
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="url"
                    value={chapterUrl}
                    onChange={(e) => setChapterUrl(e.target.value)}
                    placeholder={t.importModal.urlPlaceholder}
                    aria-label={t.importModal.urlLabel}
                    className="flex-1 min-w-[220px] px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                  />
                  {chapterUrl.trim() && /^https?:\/\//i.test(chapterUrl.trim()) && (
                    <a
                      href={chapterUrl.trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-[#EA3829]" />
                      <span>{t.importModal.openTargetTab}</span>
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleStartCompanionSession}
                    className="faqqa-btn-black inline-flex items-center gap-1.5 px-4 py-2 rounded-xl disabled:opacity-50 text-xs font-black whitespace-nowrap cursor-pointer"
                  >
                    <Globe className="w-3.5 h-3.5" />
                    <span>{t.importModal.startSession}</span>
                  </button>
                </div>

                {companionSession && (
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117] p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="font-mono text-slate-700 dark:text-slate-300">
                        Session: <strong>{companionSession.id}</strong> ·{' '}
                        <span className="uppercase">{companionSession.status}</span>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await navigator.clipboard.writeText(companionSession.pairingBundle);
                          setCopiedPairing(true);
                          setTimeout(() => setCopiedPairing(false), 2000);
                        }}
                        className="faqqa-btn-yellow inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black cursor-pointer"
                      >
                        {copiedPairing ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{copiedPairing ? t.importModal.copiedPairing : t.importModal.copyPairing}</span>
                      </button>
                    </div>

                    <textarea
                      readOnly
                      rows={2}
                      value={companionSession.pairingBundle}
                      aria-label="Browser Companion Pairing Code"
                      className="w-full p-2 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-[11px] font-mono text-slate-600 dark:text-slate-300"
                    />

                    <div className="flex items-center justify-between text-xs pt-1">
                      <span className="text-slate-600 dark:text-slate-400">
                        {t.importModal.receivedPagesLabel}:{' '}
                        <strong className="font-mono-tabular text-slate-900 dark:text-white">
                          {companionSession.pages.length}
                        </strong>
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await api.getBrowserSession(companionSession.id);
                          setCompanionSession((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  status: res.session.status,
                                  pages: res.session.pages,
                                  chapterId: res.session.chapterId,
                                }
                              : prev
                          );
                        }}
                        className="inline-flex items-center gap-1 font-bold text-[#EA3829] dark:text-[#FFE01B] hover:underline cursor-pointer"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>{lang === 'ar' ? 'تحديث' : 'Refresh'}</span>
                      </button>
                    </div>

                    {companionSession.pages.length === 0 ? (
                      <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                        <Loader2 className="w-4 h-4 animate-spin text-[#EA3829]" />
                        <span>{t.importModal.waitingExtension}</span>
                      </div>
                    ) : (
                      <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-44 overflow-y-auto pt-1">
                        {companionSession.pages.map((pg) => (
                          <div
                            key={pg.id}
                            className="rounded border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900"
                          >
                            <img
                              src={pg.imageUrl}
                              alt={`Page ${pg.pageNumber}`}
                              className="w-full h-20 object-cover"
                            />
                            <div className="p-1 text-[10px] font-mono-tabular flex justify-between">
                              <span>#{pg.pageNumber}</span>
                              <span className="text-slate-400 truncate">{pg.captureMethod}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setShowInstallGuide((v) => !v)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer"
                    >
                      <Puzzle className="w-4 h-4 text-[#EA3829]" />
                      <span>{t.importModal.installGuideTitle}</span>
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform ${showInstallGuide ? 'rotate-180' : ''}`}
                      />
                    </button>
                    <a
                      href="/api/browser-import/extension-bundle.zip"
                      download="faqqa-browser-companion.zip"
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-700"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{t.importModal.downloadExtensionZip}</span>
                    </a>
                  </div>
                  {showInstallGuide && (
                    <ol className="list-decimal list-inside text-[11px] text-slate-600 dark:text-slate-400 space-y-1 pt-1">
                      <li>
                        {lang === 'ar'
                          ? 'نزّل حزمة الإضافة وفك ضغطها (أو ابنِ مجلد browser-extension عبر npm run build:extension).'
                          : 'Download & unzip the extension bundle (or run npm run build:extension to build browser-extension/dist).'}
                      </li>
                      <li>
                        {lang === 'ar'
                          ? 'افتح chrome://extensions في متصفح Chrome أو Edge وفعّل وضع المطور (Developer Mode) ثم اختر Load Unpacked للمجلد المفكوك.'
                          : 'Open chrome://extensions, enable Developer Mode, click Load Unpacked, and select the unzipped folder.'}
                      </li>
                      <li>
                        {lang === 'ar'
                          ? 'افتح الفصل في المتصفح وتأكد من ظهوره، ثم الصق كود الربط داخل الإضافة واضغط Connect ثم Capture و Send to Translator.'
                          : 'Open the manga chapter yourself, paste the Pairing Code in the extension, capture visible pages, and click Send to Translator.'}
                      </li>
                    </ol>
                  )}
                </div>
              </div>
            )}
          </div>

          {uploadProgress && (
            <div className="space-y-1.5 p-3 rounded-xl border-2 border-[#111111] bg-[#FFE01B]/25 dark:bg-[#FFE01B]/10">
              <div className="flex justify-between text-xs font-extrabold text-[#111111] dark:text-[#FFE01B]">
                <span>{t.importModal.uploadingChunked}</span>
                <span className="font-mono-tabular">
                  {uploadProgress.uploaded}/{uploadProgress.total} ({uploadProgress.pct}%)
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-[#FAF5E8] dark:bg-[#111216] border border-[#111111]/30 overflow-hidden">
                <div
                  className="h-full bg-[#FFE01B] transition-all"
                  style={{ width: `${uploadProgress.pct}%` }}
                />
              </div>
            </div>
          )}

          {errorMsg && (
            failureContext?.category === 'WAF_OR_CAPTCHA' || failureContext?.category === 'IP_OR_GEO_BLOCK' ? (
              <div
                role="alert"
                className="p-3.5 rounded-xl border-2 border-[#111111] bg-[#FFE01B]/25 dark:bg-amber-950/40 text-xs text-[#111111] dark:text-amber-100 space-y-2.5"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#EA3829]" />
                  <div className="space-y-1">
                    <div className="font-black">{t.importModal.wafGuidanceTitle}</div>
                    <p className="text-[#333333] dark:text-amber-200 leading-relaxed">
                      {t.importModal.wafGuidanceBody}
                    </p>
                    <p className="font-mono text-[11px] text-[#524E46] dark:text-amber-300">
                      {failureContext.category} · HTTP {failureContext.httpStatus || 403}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleOpenInBrowserFallback}
                    className="faqqa-btn-yellow inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-black cursor-pointer"
                  >
                    <Puzzle className="w-4 h-4" />
                    <span>{t.importModal.openInBrowserCta}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                role="alert"
                className="p-3 rounded-xl border-2 border-[#EA3829] bg-[#EA3829]/10 dark:bg-rose-950/40 text-xs text-[#EA3829] dark:text-rose-300 space-y-1"
              >
                {failureContext && (failureContext.category || failureContext.stage) && (
                  <div className="font-mono text-[11px] font-semibold text-[#111111] dark:text-rose-200">
                    {[
                      failureContext.category,
                      failureContext.stage ? `@ ${failureContext.stage}` : '',
                      failureContext.httpStatus ? `HTTP ${failureContext.httpStatus}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
                <div>{errorMsg}</div>
              </div>
            )
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t-2 border-[#111111]/10 dark:border-white/10">
            <button
              type="button"
              onClick={handleCloseWithCleanup}
              className="px-4 py-2 rounded-xl border-2 border-[#111111]/25 dark:border-white/25 text-sm font-bold hover:border-[#111111] cursor-pointer"
            >
              {t.home.cancel}
            </button>
            <button
              type="submit"
              disabled={
                busy ||
                (isAppendMode && extractedPages.length === 0) ||
                (!isAppendMode && tab === 'companion' && (!companionSession || companionSession.pages.length === 0))
              }
              className="faqqa-btn-yellow inline-flex items-center gap-2 px-5 py-2 rounded-xl disabled:opacity-50 text-sm font-black whitespace-nowrap shrink-0 cursor-pointer"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>
                {isAppendMode
                  ? t.importModal.appendConfirm
                  : tab === 'companion'
                  ? t.importModal.completeCompanionImport
                  : newProjectOnly && extractedPages.length === 0 && urlImages.length === 0
                  ? t.home.btnNewProject
                  : t.importModal.startImport}
              </span>
            </button>
          </div>
        </form>
      </div>

      {/* Pre-upload Page Preview Lightbox with Zoom */}
      {previewAsset && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.importModal.previewZoom}
          className="fixed inset-0 z-[60] bg-slate-950/85 flex flex-col p-4"
        >
          <div className="flex items-center justify-between text-white pb-3">
            <div className="text-xs font-mono-tabular">
              #{(previewIndex ?? 0) + 1}/{extractedPages.length} · {previewAsset.filename} ({previewAsset.width}×{previewAsset.height})
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                aria-label={t.studio.tools.zoomOut}
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 cursor-pointer"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-xs font-mono-tabular w-12 text-center">
                {Math.round(previewZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setPreviewZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                aria-label={t.studio.tools.zoomIn}
                className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 cursor-pointer"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setPreviewIndex(null)}
                aria-label="Close preview"
                className="p-2 rounded-lg bg-slate-800 hover:bg-rose-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto flex items-center justify-center">
            <img
              src={previewAsset.dataUrl}
              alt={previewAsset.filename}
              style={{ transform: `scale(${previewZoom})`, transformOrigin: 'center center' }}
              className="max-w-full max-h-full object-contain rounded shadow-2xl transition-transform"
            />
          </div>
        </div>
      )}
    </div>
  );
};
