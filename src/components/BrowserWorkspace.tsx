import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bookmark,
  BookmarkCheck,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  EyeOff,
  FileUp,
  Globe,
  Home,
  Images,
  Keyboard,
  Layers,
  Loader2,
  Plus,
  RotateCw,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  BrowserBookmark,
  BrowserCapabilities,
  BrowserDiscoveredImage,
  BrowserHistoryEntry,
  BrowserPrivacyMode,
  BrowserTabSnapshot,
  LanguageCode,
  ProjectWithDetails,
} from '../types/domain';
import { api } from '../utils/api';
import { tFor } from '../i18n/translations';

interface BrowserWorkspaceProps {
  lang: LanguageCode;
  projects: ProjectWithDetails[];
  onOpenLocalImport: (initialTab: 'files' | 'url' | 'companion') => void;
  onChapterImported: (chapterId: string, openTranslator: boolean) => Promise<void>;
}

export const BrowserWorkspace: React.FC<BrowserWorkspaceProps> = ({
  lang,
  projects,
  onOpenLocalImport,
  onChapterImported,
}) => {
  const t = tFor(lang);
  const b = t.browser;

  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);
  const [privacyMode, setPrivacyMode] = useState<BrowserPrivacyMode>('standard');
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [tabs, setTabs] = useState<
    Array<{ id: string; title: string; url: string; privacyMode: BrowserPrivacyMode }>
  >([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [snapshot, setSnapshot] = useState<BrowserTabSnapshot | null>(null);

  const [urlInput, setUrlInput] = useState<string>('pt://home');
  const [loadingNav, setLoadingNav] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [statusNotice, setStatusNotice] = useState<string>('');

  // Sidebars / Panels
  const [activeSidePanel, setActiveSidePanel] = useState<
    'none' | 'importer' | 'bookmarks' | 'history' | 'mobile'
  >('none');

  // Interactive manual input state (never stored or logged)
  const [manualText, setManualText] = useState('');
  const [showManualInputBar, setShowManualInputBar] = useState(false);

  // Collected images state for Import Chapter drawer
  const [collectedImages, setCollectedImages] = useState<BrowserDiscoveredImage[]>([]);
  const [collectingImages, setCollectingImages] = useState(false);
  const [importingChapter, setImportingChapter] = useState(false);

  // Target project settings for Import Chapter
  const [projectTargetMode, setProjectTargetMode] = useState<'new' | 'existing'>(
    projects.length > 0 ? 'existing' : 'new'
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projects[0]?.id || '');
  const [newProjectTitle, setNewProjectTitle] = useState<string>('');
  const [chapterTitle, setChapterTitle] = useState<string>('');

  const viewportImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const syncFromSnapshot = useCallback((snap: BrowserTabSnapshot) => {
    setSnapshot(snap);
    setUrlInput(snap.url);
    if (snap.focusedInput) {
      setShowManualInputBar(true);
    }
    if (snap.title && snap.url !== 'pt://home') {
      setChapterTitle((prev) => prev || snap.title.slice(0, 72));
    }
  }, []);

  // Bootstrap Browser Engine state & ensure initial tab
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const [capRes, stateRes] = await Promise.all([
          api.getBrowserCapabilities(),
          api.getBrowserState(),
        ]);
        if (cancelled) return;
        setCapabilities(capRes.capabilities);
        setPrivacyMode(stateRes.state.privacyMode);
        setBookmarks(stateRes.state.bookmarks);
        setHistory(stateRes.state.history);

        if (stateRes.tabs.length > 0) {
          setTabs(stateRes.tabs);
          const firstId = stateRes.tabs[0].id;
          setActiveTabId(firstId);
          const tabRes = await api.getBrowserTab(firstId);
          if (!cancelled) syncFromSnapshot(tabRes.tab);
        } else {
          const created = await api.createBrowserTab(
            stateRes.state.homeUrl || 'pt://home',
            stateRes.state.privacyMode
          );
          if (cancelled) return;
          setTabs(created.tabs);
          setActiveTabId(created.tab.id);
          syncFromSnapshot(created.tab);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [syncFromSnapshot]);

  const handleSelectTab = async (tabId: string) => {
    setErrorMsg('');
    setActiveTabId(tabId);
    setLoadingNav(true);
    try {
      const res = await api.getBrowserTab(tabId);
      syncFromSnapshot(res.tab);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingNav(false);
    }
  };

  const handleCreateTab = async (targetUrl?: string) => {
    setErrorMsg('');
    setLoadingNav(true);
    try {
      const res = await api.createBrowserTab(targetUrl || 'pt://home', privacyMode);
      setTabs(res.tabs);
      setActiveTabId(res.tab.id);
      setCollectedImages([]);
      syncFromSnapshot(res.tab);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingNav(false);
    }
  };

  const handleCloseTab = async (tabId: string) => {
    setErrorMsg('');
    try {
      const res = await api.closeBrowserTab(tabId);
      setTabs(res.tabs);
      if (tabId === activeTabId) {
        if (res.tabs.length > 0) {
          await handleSelectTab(res.tabs[0].id);
        } else {
          await handleCreateTab('pt://home');
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleNavigate = async (targetUrl: string) => {
    if (!activeTabId) return;
    setErrorMsg('');
    setStatusNotice('');
    setLoadingNav(true);
    try {
      const res = await api.navigateBrowserTab(activeTabId, targetUrl);
      setTabs(res.tabs);
      setHistory(res.history);
      setCollectedImages([]);
      setChapterTitle(res.tab.url !== 'pt://home' ? res.tab.title.slice(0, 72) : '');
      syncFromSnapshot(res.tab);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingNav(false);
    }
  };

  const handleBack = async () => {
    if (!activeTabId) return;
    setLoadingNav(true);
    try {
      const res = await api.backBrowserTab(activeTabId);
      setTabs(res.tabs);
      syncFromSnapshot(res.tab);
    } finally {
      setLoadingNav(false);
    }
  };

  const handleForward = async () => {
    if (!activeTabId) return;
    setLoadingNav(true);
    try {
      const res = await api.forwardBrowserTab(activeTabId);
      setTabs(res.tabs);
      syncFromSnapshot(res.tab);
    } finally {
      setLoadingNav(false);
    }
  };

  const handleReload = async () => {
    if (!activeTabId) return;
    setLoadingNav(true);
    try {
      const res = await api.reloadBrowserTab(activeTabId);
      syncFromSnapshot(res.tab);
    } finally {
      setLoadingNav(false);
    }
  };

  const handleTogglePrivacy = async () => {
    const nextMode: BrowserPrivacyMode = privacyMode === 'standard' ? 'incognito' : 'standard';
    try {
      const res = await api.updateBrowserPrivacy({ privacyMode: nextMode });
      setPrivacyMode(res.state.privacyMode);
      // Open a fresh tab in the newly selected privacy context cleanly
      const tabRes = await api.createBrowserTab(snapshot?.url || 'pt://home', nextMode);
      setTabs(tabRes.tabs);
      setActiveTabId(tabRes.tab.id);
      syncFromSnapshot(tabRes.tab);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleClearHistory = async () => {
    const res = await api.updateBrowserPrivacy({ clearHistory: true });
    setHistory(res.state.history);
    setStatusNotice(lang === 'ar' ? 'تم مسح سجل التصفح.' : 'Browsing history cleared.');
  };

  const handleClearCookies = async () => {
    await api.updateBrowserPrivacy({ clearSessionCookies: true });
    setStatusNotice(
      lang === 'ar' ? 'تم مسح الجلسات وملفات الارتباط.' : 'Session cookies cleared.'
    );
    await handleReload();
  };

  const isCurrentBookmarked = useMemo(() => {
    if (!snapshot?.url || snapshot.url === 'pt://home') return undefined;
    return bookmarks.find((bm) => bm.url === snapshot.url);
  }, [bookmarks, snapshot?.url]);

  const handleToggleBookmark = async () => {
    if (!snapshot?.url || snapshot.url === 'pt://home') return;
    if (isCurrentBookmarked) {
      const res = await api.removeBrowserBookmark(isCurrentBookmarked.id);
      setBookmarks(res.bookmarks);
    } else {
      const res = await api.addBrowserBookmark(snapshot.title || snapshot.url, snapshot.url);
      setBookmarks(res.bookmarks);
    }
  };

  const handleViewportClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!activeTabId || !viewportImgRef.current || !snapshot) return;
    const rect = viewportImgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
    const targetX = Math.round(relX * snapshot.viewportWidth);
    const targetY = Math.round(relY * snapshot.viewportHeight);
    setLoadingNav(true);
    try {
      const res = await api.interactBrowserTab(activeTabId, {
        type: 'click',
        x: targetX,
        y: targetY,
      });
      setTabs(res.tabs);
      syncFromSnapshot(res.tab);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingNav(false);
    }
  };

  const handleScroll = async (deltaY: number) => {
    if (!activeTabId) return;
    try {
      const res = await api.interactBrowserTab(activeTabId, { type: 'scroll', deltaY });
      syncFromSnapshot(res.tab);
    } catch {
      // Ignore transient scroll error
    }
  };

  const handleSendManualText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTabId || !manualText) return;
    setLoadingNav(true);
    try {
      const res = await api.interactBrowserTab(activeTabId, {
        type: 'type',
        text: manualText,
        pressEnter: true,
      });
      setManualText('');
      setTabs(res.tabs);
      syncFromSnapshot(res.tab);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingNav(false);
    }
  };

  const handleOpenImportChapterDrawer = async (autoScrollLazy = true) => {
    if (!activeTabId) return;
    setActiveSidePanel('importer');
    setCollectingImages(true);
    setErrorMsg('');
    try {
      const res = await api.collectTabImages(activeTabId, autoScrollLazy);
      syncFromSnapshot(res.snapshot);
      setCollectedImages(res.images);
      if (res.blockedByProtection) {
        setErrorMsg(b.protection403Title);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCollectingImages(false);
    }
  };

  const handleCaptureScreenshotFallback = async (mode: 'visible' | 'full_page') => {
    if (!activeTabId) return;
    setActiveSidePanel('importer');
    setCollectingImages(true);
    setErrorMsg('');
    try {
      const res = await api.screenshotBrowserTab(activeTabId, mode);
      setCollectedImages((prev) => [...prev, res.image]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCollectingImages(false);
    }
  };

  const toggleImageSelection = (id: string) => {
    setCollectedImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, selected: !img.selected } : img))
    );
  };

  const moveCollectedImage = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= collectedImages.length) return;
    const copy = [...collectedImages];
    const [item] = copy.splice(idx, 1);
    copy.splice(target, 0, item);
    setCollectedImages(copy.map((c, i) => ({ ...c, index: i + 1 })));
  };

  const handleImportPages = async (
    pagesToSend: BrowserDiscoveredImage[],
    openTranslator: boolean
  ) => {
    if (pagesToSend.length === 0) return;
    setImportingChapter(true);
    setErrorMsg('');
    try {
      const useExisting = projectTargetMode === 'existing' && selectedProjectId;
      const result = await api.importBrowserImagesToStudio({
        projectId: useExisting ? selectedProjectId : undefined,
        newProjectConfig: useExisting
          ? undefined
          : {
              title:
                newProjectTitle.trim() ||
                snapshot?.title?.slice(0, 48) ||
                'Western Comic Series',
              comicFormat: 'superhero',
              sourceLanguage: 'en',
              targetLanguage: 'ar',
              readingDirection: 'ltr',
              translationStyle: 'cinematic',
            },
        chapterTitle:
          chapterTitle.trim() || snapshot?.title?.slice(0, 64) || 'Browser Imported Chapter',
        sourceUrl: snapshot?.url && snapshot.url !== 'pt://home' ? snapshot.url : undefined,
        pages: pagesToSend.map((p) => ({
          dataUrl: p.dataUrl,
          width: p.width,
          height: p.height,
        })),
      });
      await onChapterImported(result.chapter.id, openTranslator);
      if (!openTranslator) {
        setStatusNotice(
          lang === 'ar'
            ? `تم حفظ الفصل "${result.chapter.title}" (${result.pages.length} صفحة) كمسودة في المكتبة.`
            : `Saved draft "${result.chapter.title}" (${result.pages.length} pages) to Library.`
        );
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingChapter(false);
    }
  };

  const selectedImages = useMemo(
    () => collectedImages.filter((img) => img.selected),
    [collectedImages]
  );

  const prevLink = snapshot?.chapterLinks.find((l) => l.kind === 'prev');
  const nextLink = snapshot?.chapterLinks.find((l) => l.kind === 'next');
  const externalSafeHref =
    snapshot?.url && /^https?:\/\//i.test(snapshot.url) ? snapshot.url : 'https://globalcomix.com';

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#F8F9FB] dark:bg-[#0D1117]">
      {/* Multi-Tab Strip + Privacy & Utility Toggles */}
      <div className="px-4 lg:px-6 pt-3 pb-2 bg-white dark:bg-[#161B22] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto max-w-full">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`group flex items-center gap-2 px-3 py-1.5 rounded-xl border-2 text-xs font-extrabold transition-all shrink-0 ${
                  isActive
                    ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'bg-[#FAF5E8] dark:bg-[#111216] text-[#111111] dark:text-[#FFFDF9] border-[#111111]/20 dark:border-white/15 hover:border-[#111111]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void handleSelectTab(tab.id)}
                  className="flex items-center gap-1.5 max-w-[160px] truncate cursor-pointer"
                >
                  {tab.privacyMode === 'incognito' ? (
                    <EyeOff className="w-3.5 h-3.5 shrink-0 opacity-80" />
                  ) : (
                    <Globe className="w-3.5 h-3.5 shrink-0 opacity-80" />
                  )}
                  <span className="truncate">{tab.title || 'New Tab'}</span>
                </button>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    aria-label="Close tab"
                    onClick={() => void handleCloseTab(tab.id)}
                    className="opacity-70 hover:opacity-100 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => void handleCreateTab('pt://home')}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{b.newTab}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => void handleTogglePrivacy()}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium cursor-pointer ${
              privacyMode === 'incognito'
                ? 'border-amber-500/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0D1117] text-slate-700 dark:text-slate-300'
            }`}
          >
            <EyeOff className="w-3.5 h-3.5" />
            <span>{privacyMode === 'incognito' ? b.privacyIncognito : b.privacyStandard}</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveSidePanel((p) => (p === 'bookmarks' ? 'none' : 'bookmarks'))
            }
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
              activeSidePanel === 'bookmarks'
                ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                : 'border-[#111111]/20 dark:border-white/15 bg-white dark:bg-[#111216] text-[#111111] dark:text-[#FFFDF9]'
            }`}
          >
            <Bookmark className="w-3.5 h-3.5" />
            <span>{b.bookmarks}</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveSidePanel((p) => (p === 'history' ? 'none' : 'history'))
            }
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
              activeSidePanel === 'history'
                ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                : 'border-[#111111]/20 dark:border-white/15 bg-white dark:bg-[#111216] text-[#111111] dark:text-[#FFFDF9]'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>{b.history}</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveSidePanel((p) => (p === 'mobile' ? 'none' : 'mobile'))
            }
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border-2 text-xs font-bold cursor-pointer ${
              activeSidePanel === 'mobile'
                ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                : 'border-[#111111]/20 dark:border-white/15 bg-white dark:bg-[#111216] text-[#111111] dark:text-[#FFFDF9]'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>{lang === 'ar' ? 'مشاركة Android' : 'Android / Share'}</span>
          </button>
        </div>
      </div>

      {/* Browser Address Bar + Permanent Import Chapter CTA */}
      <div className="px-4 lg:px-6 py-2.5 bg-white dark:bg-[#161B22] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            aria-label={b.back}
            disabled={!snapshot?.canGoBack || loadingNav}
            onClick={() => void handleBack()}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            {lang === 'ar' ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
          </button>
          <button
            type="button"
            aria-label={b.forward}
            disabled={!snapshot?.canGoForward || loadingNav}
            onClick={() => void handleForward()}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            {lang === 'ar' ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
          </button>
          <button
            type="button"
            aria-label={b.reload}
            disabled={loadingNav}
            onClick={() => void handleReload()}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <RotateCw className={`w-4 h-4 ${loadingNav ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            aria-label={b.home}
            disabled={loadingNav}
            onClick={() => void handleNavigate('pt://home')}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <Home className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleNavigate(urlInput);
          }}
          className="flex-1 min-w-[240px] flex items-center gap-2"
        >
          <div className="relative flex-1">
            <input
              type="text"
              dir="ltr"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder={b.urlPlaceholder}
              className="w-full px-3.5 py-2 rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FAF5E8] dark:bg-[#111216] text-sm font-mono text-[#111111] dark:text-[#FFFDF9] focus:outline-none focus:border-[#111111] dark:focus:border-[#FFE01B]"
            />
          </div>
          <button
            type="submit"
            disabled={loadingNav}
            className="px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-700 hover:bg-slate-800 text-white text-xs font-semibold shrink-0 cursor-pointer"
          >
            {b.go}
          </button>
        </form>

        <div className="flex items-center gap-2 shrink-0">
          {snapshot?.url && snapshot.url !== 'pt://home' && (
            <button
              type="button"
              onClick={() => void handleToggleBookmark()}
              title={isCurrentBookmarked ? b.removeBookmark : b.addBookmark}
              className={`p-2 rounded-lg border cursor-pointer ${
                isCurrentBookmarked
                  ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/30 text-amber-600'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {isCurrentBookmarked ? (
                <BookmarkCheck className="w-4 h-4" />
              ) : (
                <Bookmark className="w-4 h-4" />
              )}
            </button>
          )}

          <a
            href={externalSafeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{b.openExternal}</span>
          </a>

          {/* Permanent Import Chapter Button */}
          <button
            type="button"
            data-testid="import-chapter-btn"
            onClick={() => void handleOpenImportChapterDrawer(true)}
            className="faqqa-btn-yellow inline-flex items-center gap-2 px-4 py-2 text-xs whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Images className="w-4 h-4" />
            <span>{b.importChapter}</span>
            <span className="tabular-nums opacity-90">
              ({snapshot?.discoveredImageCount ?? 0})
            </span>
          </button>
        </div>
      </div>

      {/* Chapter Navigation + Scroll + Manual Login Input Bar */}
      <div className="px-4 lg:px-6 py-2 bg-slate-50 dark:bg-[#0D1117] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          {prevLink && (
            <button
              type="button"
              onClick={() => void handleNavigate(prevLink.url)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <span>{b.prevChapter}</span>
            </button>
          )}
          {nextLink && (
            <button
              type="button"
              onClick={() => void handleNavigate(nextLink.url)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 border-[#111111] bg-[#FFE01B] text-[#111111] font-extrabold cursor-pointer"
            >
              <span>{b.nextChapter}</span>
            </button>
          )}
          {snapshot && snapshot.chapterLinks.length > 0 && (
            <select
              aria-label={b.detectedChapters}
              value=""
              onChange={(e) => {
                if (e.target.value) void handleNavigate(e.target.value);
              }}
              className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs"
            >
              <option value="">
                {b.detectedChapters} ({snapshot.chapterLinks.length})
              </option>
              {snapshot.chapterLinks.map((cl) => (
                <option key={cl.url} value={cl.url}>
                  {cl.label}
                </option>
              ))}
            </select>
          )}
          <span className="text-slate-500 dark:text-slate-400 tabular-nums">
            {b.discoveredCount}: {snapshot?.discoveredImageCount ?? 0}
            {snapshot?.httpStatus ? ` · HTTP ${snapshot.httpStatus}` : ''}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleScroll(-500)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <ArrowUp className="w-3.5 h-3.5" />
            <span>{b.scrollUp}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleScroll(500)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <ArrowDown className="w-3.5 h-3.5" />
            <span>{b.scrollDown}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowManualInputBar((v) => !v)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border-2 cursor-pointer font-bold ${
              showManualInputBar
                ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                : 'border-[#111111]/20 dark:border-white/15 bg-white dark:bg-[#1A1B21]'
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" />
            <span>{lang === 'ar' ? 'إدخال نص / تسجيل دخول' : 'Manual Input / Login'}</span>
          </button>
        </div>
      </div>

      {/* Manual Text / Login Field Strip */}
      {showManualInputBar && (
        <form
          onSubmit={handleSendManualText}
          className="px-4 lg:px-6 py-2 bg-[#FFE01B]/15 dark:bg-[#FFE01B]/10 border-b-2 border-[#111111]/15 dark:border-[#FFE01B]/25 flex flex-wrap items-center gap-2 text-xs"
        >
          <span className="font-bold text-[#111111] dark:text-[#FFE01B]">
            {b.inputBarLabel}
            {snapshot?.focusedInput?.placeholder
              ? ` (${snapshot.focusedInput.placeholder})`
              : ''}
            :
          </span>
          <input
            type={snapshot?.focusedInput?.type === 'password' ? 'password' : 'text'}
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder={b.inputBarPlaceholder}
            className="flex-1 min-w-[220px] px-3 py-1.5 rounded-lg border-2 border-[#111111]/25 dark:border-white/20 bg-white dark:bg-[#111216] text-[#111111] dark:text-[#FFFDF9]"
          />
          <button
            type="submit"
            disabled={loadingNav || !manualText}
            className="faqqa-btn-yellow px-3 py-1.5 text-xs disabled:opacity-50 cursor-pointer"
          >
            {b.sendInput}
          </button>
        </form>
      )}

      {/* Protection / 403 / Error Banner (Honest reporting; 403 is never success) */}
      {(errorMsg || (snapshot && snapshot.protectionStatus !== 'clear')) && (
        <div className="px-4 lg:px-6 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/60 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-950 dark:text-amber-200">
          <div className="flex items-start gap-2.5 max-w-3xl">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" />
            <div>
              <div className="font-semibold">
                {snapshot?.protectionStatus === 'http_403_blocked'
                  ? b.protection403Title
                  : b.protectionWarningTitle}
              </div>
              <p className="opacity-90 mt-0.5">
                {errorMsg || snapshot?.protectionMessage}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onOpenLocalImport('companion')}
              className="px-3 py-1.5 rounded-md border border-amber-400 dark:border-amber-700 bg-white dark:bg-[#161B22] font-medium cursor-pointer"
            >
              {b.useExtensionFallback}
            </button>
            <button
              type="button"
              onClick={() => onOpenLocalImport('files')}
              className="px-3 py-1.5 rounded-md bg-amber-700 text-white font-medium cursor-pointer"
            >
              {b.useLocalFilesFallback}
            </button>
          </div>
        </div>
      )}

      {statusNotice && (
        <div className="px-4 lg:px-6 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-200 dark:border-emerald-900/50 text-xs text-emerald-800 dark:text-emerald-200 flex items-center justify-between">
          <span>{statusNotice}</span>
          <button type="button" onClick={() => setStatusNotice('')} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Split Workspace: Interactive Chromium Viewport + Optional Drawer */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left/Center: Live Chromium Viewport */}
        <div className="flex-1 p-4 lg:p-5 overflow-auto flex flex-col items-center">
          {capabilities && !capabilities.serverChromiumAvailable ? (
            <div className="max-w-xl w-full bg-white dark:bg-[#161B22] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-semibold">
                <AlertTriangle className="w-5 h-5" />
                <span>
                  {lang === 'ar'
                    ? 'محرك التصفح الخادمي غير متاح حالياً'
                    : 'Server Chromium Engine Unavailable'}
                </span>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {capabilities.iframeReason}
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={externalSafeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="faqqa-btn-yellow inline-flex items-center gap-2 px-4 py-2 text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>{b.openExternal}</span>
                </a>
                <button
                  type="button"
                  onClick={() => onOpenLocalImport('files')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium cursor-pointer"
                >
                  <FileUp className="w-4 h-4" />
                  <span>{b.useLocalFilesFallback}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="w-full max-w-[1120px] bg-white dark:bg-[#161B22] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm">
              {snapshot?.screenshotDataUrl ? (
                <div className="relative">
                  <img
                    ref={viewportImgRef}
                    src={snapshot.screenshotDataUrl}
                    alt={snapshot.title || 'Browser Viewport'}
                    onClick={(e) => void handleViewportClick(e)}
                    className="w-full h-auto block cursor-pointer select-none"
                  />
                  {loadingNav && (
                    <div className="absolute inset-0 bg-slate-900/20 flex items-center justify-center">
                      <div className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>{lang === 'ar' ? 'جاري التحميل...' : 'Loading...'}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-[460px] flex flex-col items-center justify-center gap-3 text-slate-500">
                  <Loader2 className="w-6 h-6 animate-spin text-[#EA3829] dark:text-[#FFE01B]" />
                  <span className="text-sm">
                    {lang === 'ar'
                      ? 'جاري تشغيل محرك التصفح الداخلي...'
                      : 'Starting internal Chromium browser...'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Side Panel: Smart Importer / Bookmarks / History / Android Share */}
        {activeSidePanel !== 'none' && (
          <aside className="w-full lg:w-[420px] xl:w-[450px] border-t lg:border-t-0 lg:border-s border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22] flex flex-col min-h-0 max-h-[82vh] lg:max-h-none">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                {activeSidePanel === 'importer' && b.drawerTitle}
                {activeSidePanel === 'bookmarks' && b.bookmarks}
                {activeSidePanel === 'history' && b.history}
                {activeSidePanel === 'mobile' && b.mobileBridgeTitle}
              </h2>
              <button
                type="button"
                aria-label="Close panel"
                onClick={() => setActiveSidePanel('none')}
                className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* BOOKMARKS PANEL */}
              {activeSidePanel === 'bookmarks' && (
                <div className="space-y-2">
                  {bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className="flex items-center justify-between gap-2 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117]"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveSidePanel('none');
                          void handleNavigate(bm.url);
                        }}
                        className="text-start flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="text-xs font-semibold truncate text-slate-900 dark:text-white">
                          {bm.title}
                        </div>
                        <div dir="ltr" className="text-[11px] font-mono text-slate-500 truncate">
                          {bm.url}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const res = await api.removeBrowserBookmark(bm.id);
                          setBookmarks(res.bookmarks);
                        }}
                        className="p-1.5 text-slate-400 hover:text-rose-600 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* HISTORY PANEL */}
              {activeSidePanel === 'history' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleClearHistory()}
                      className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      {b.clearHistory}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleClearCookies()}
                      className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      {b.clearCookies}
                    </button>
                  </div>
                  {history.length === 0 ? (
                    <p className="text-xs text-slate-500 text-center py-6">
                      {privacyMode === 'incognito'
                        ? b.privacyIncognito
                        : lang === 'ar'
                          ? 'لا يوجد سجل تصفح محفوظ.'
                          : 'No browsing history recorded yet.'}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {history.map((h) => (
                        <button
                          key={h.id}
                          type="button"
                          onClick={() => {
                            setActiveSidePanel('none');
                            void handleNavigate(h.url);
                          }}
                          className="w-full text-start p-2.5 rounded-xl border-2 border-[#111111]/15 dark:border-white/15 bg-[#FAF5E8] dark:bg-[#111216] hover:border-[#111111] dark:hover:border-[#FFE01B] cursor-pointer"
                        >
                          <div className="text-xs font-semibold truncate">{h.title}</div>
                          <div dir="ltr" className="text-[11px] font-mono text-slate-500 truncate">
                            {h.url}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ANDROID WEBVIEW & MOBILE SHARE PANEL */}
              {activeSidePanel === 'mobile' && (
                <div className="space-y-4 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                  <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0D1117] space-y-2">
                    <div className="font-semibold text-slate-900 dark:text-white">
                      {b.mobileBridgeTitle}
                    </div>
                    <p>{b.mobileBridgeNote}</p>
                    {capabilities && (
                      <div dir="ltr" className="font-mono text-[11px] text-slate-500 pt-1">
                        module: {capabilities.androidModulePath} · endpoint: POST /api/mobile/share-import
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenLocalImport('companion')}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      <span>{b.useExtensionFallback}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenLocalImport('files')}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <FileUp className="w-4 h-4" />
                      <span>{b.useLocalFilesFallback}</span>
                    </button>
                  </div>
                </div>
              )}

              {/* SMART CHAPTER IMPORTER PANEL */}
              {activeSidePanel === 'importer' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={collectingImages}
                      onClick={() => void handleOpenImportChapterDrawer(true)}
                      className="faqqa-btn-yellow flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs disabled:opacity-50 cursor-pointer"
                    >
                      {collectingImages ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span>{b.collectLazy}</span>
                    </button>
                    <button
                      type="button"
                      disabled={collectingImages}
                      onClick={() => void handleCaptureScreenshotFallback('visible')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>{b.screenshotVisible}</span>
                    </button>
                    <button
                      type="button"
                      disabled={collectingImages}
                      onClick={() => void handleCaptureScreenshotFallback('full_page')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>{b.screenshotFull}</span>
                    </button>
                  </div>

                  {collectingImages && (
                    <div className="p-3 rounded-xl border-2 border-[#111111] bg-[#FFE01B]/25 text-xs font-bold text-[#111111] dark:text-[#FFE01B] flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>{b.collecting}</span>
                    </div>
                  )}

                  {collectedImages.length === 0 && !collectingImages ? (
                    <p className="text-xs text-slate-500 text-center py-4">{b.noImagesHint}</p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                        <span className="tabular-nums font-medium">
                          {selectedImages.length} / {collectedImages.length}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setCollectedImages((prev) => prev.map((p) => ({ ...p, selected: true })))
                            }
                            className="underline cursor-pointer"
                          >
                            {b.selectAll}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setCollectedImages((prev) =>
                                prev.map((p) => ({ ...p, selected: !p.isDuplicate }))
                              )
                            }
                            className="underline cursor-pointer"
                          >
                            {b.deselectDuplicates}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-2 max-h-[300px] overflow-y-auto pe-1">
                        {collectedImages.map((img, idx) => (
                          <div
                            key={img.id}
                            className={`flex items-center gap-2.5 p-2 rounded-xl border-2 ${
                              img.selected
                                ? 'border-[#111111] dark:border-[#FFE01B] bg-[#FFE01B]/15 dark:bg-[#FFE01B]/10'
                                : 'border-[#111111]/15 dark:border-white/15 bg-[#FAF5E8] dark:bg-[#111216] opacity-70'
                            }`}
                          >
                            <button
                              type="button"
                              aria-label="Toggle select image"
                              onClick={() => toggleImageSelection(img.id)}
                              className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 cursor-pointer ${
                                img.selected
                                  ? 'bg-[#FFE01B] border-[#111111] text-[#111111]'
                                  : 'border-[#111111]/30 dark:border-white/30 bg-white dark:bg-[#1A1B21]'
                              }`}
                            >
                              {img.selected && <Check className="w-3.5 h-3.5" />}
                            </button>

                            <img
                              src={img.dataUrl}
                              alt={`Page ${idx + 1}`}
                              className="w-12 h-16 object-cover rounded border border-slate-200 dark:border-slate-700 shrink-0"
                            />

                            <div className="flex-1 min-w-0 text-[11px] space-y-0.5">
                              <div className="font-semibold text-slate-900 dark:text-white tabular-nums">
                                #{idx + 1} · {img.width}×{img.height}
                              </div>
                              <div className="text-slate-500 truncate">
                                {img.captureSource}
                                {img.isDuplicate && ` · ${b.duplicateBadge} (#${img.duplicateOfIndex})`}
                              </div>
                              <button
                                type="button"
                                disabled={importingChapter}
                                onClick={() => void handleImportPages([img], true)}
                                className="text-[#EA3829] dark:text-[#FFE01B] hover:underline font-bold cursor-pointer"
                              >
                                {b.sendSinglePage}
                              </button>
                            </div>

                            <div className="flex flex-col gap-1 shrink-0">
                              <button
                                type="button"
                                aria-label={b.moveUp}
                                onClick={() => moveCollectedImage(idx, -1)}
                                disabled={idx === 0}
                                className="p-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 cursor-pointer"
                              >
                                <ChevronUp className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                aria-label={b.moveDown}
                                onClick={() => moveCollectedImage(idx, 1)}
                                disabled={idx === collectedImages.length - 1}
                                className="p-1 rounded border border-slate-200 dark:border-slate-700 disabled:opacity-30 cursor-pointer"
                              >
                                <ChevronDown className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Destination Project & Chapter Form */}
                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
                        <div className="font-semibold text-slate-800 dark:text-slate-200">
                          {b.targetProject}
                        </div>
                        <div className="flex gap-2">
                          {projects.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setProjectTargetMode('existing')}
                              className={`flex-1 py-1.5 px-2 rounded-lg border-2 font-bold cursor-pointer ${
                                projectTargetMode === 'existing'
                                  ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                                  : 'border-[#111111]/20 dark:border-white/20'
                              }`}
                            >
                              {b.existingProject}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setProjectTargetMode('new')}
                            className={`flex-1 py-1.5 px-2 rounded-lg border-2 font-bold cursor-pointer ${
                              projectTargetMode === 'new'
                                ? 'border-[#111111] bg-[#FFE01B] text-[#111111]'
                                : 'border-[#111111]/20 dark:border-white/20'
                            }`}
                          >
                            {b.createNewWesternProject}
                          </button>
                        </div>

                        {projectTargetMode === 'existing' && projects.length > 0 ? (
                          <select
                            value={selectedProjectId}
                            onChange={(e) => setSelectedProjectId(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                          >
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.title} ({p.sourceLanguage.toUpperCase()} → {p.targetLanguage.toUpperCase()})
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={newProjectTitle}
                            onChange={(e) => setNewProjectTitle(e.target.value)}
                            placeholder={b.newProjectTitle}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                          />
                        )}

                        <input
                          type="text"
                          value={chapterTitle}
                          onChange={(e) => setChapterTitle(e.target.value)}
                          placeholder={b.chapterTitle}
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                        />

                        <div className="flex flex-col gap-2 pt-1">
                          <button
                            type="button"
                            disabled={importingChapter || selectedImages.length === 0}
                            onClick={() => void handleImportPages(selectedImages, true)}
                            className="faqqa-btn-yellow w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 disabled:opacity-50 cursor-pointer"
                          >
                            {importingChapter ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Layers className="w-4 h-4" />
                            )}
                            <span>
                              {importingChapter ? b.importing : b.sendToTranslator}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={importingChapter || selectedImages.length === 0}
                            onClick={() => void handleImportPages(selectedImages, false)}
                            className="w-full py-2 px-3 rounded-lg border border-slate-300 dark:border-slate-700 font-medium hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                          >
                            {b.saveDraftLater}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
