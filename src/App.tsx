import { useEffect, useState } from 'react';
import type {
  AiProviderId,
  AiSettings,
  ComicFormat,
  LanguageCode,
  ProjectWithDetails,
  ProvidersDetailedStatusMap,
  ProvidersStatusMap,
  ThemeMode,
} from './types/domain';
import { api } from './utils/api';
import { AppShell, type AppSection } from './components/AppShell';
import { LibraryView } from './components/LibraryView';
import { ImportModal } from './components/ImportModal';
import { BrowserWorkspace } from './components/BrowserWorkspace';
import { StudioEditor } from './components/StudioEditor';
import { ChapterReader } from './components/ChapterReader';
import { GlossaryView } from './components/GlossaryView';
import { JobsView } from './components/JobsView';
import { SettingsView } from './components/SettingsView';

const DEFAULT_MODEL_BY_PROVIDER: Record<AiProviderId, string> = {
  gemini: 'gemini-4-hydrogen',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'deepseek/deepseek-chat-v3-0324:free',
  cloudflare: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  deepseek: 'deepseek-chat',
  qwen_studio: 'qwen-plus',
};

const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'gemini',
  visionProvider: 'gemini',
  translationModel: 'gemini-4-hydrogen',
  visionOcrModel: 'gemini-4-hydrogen',
  inpaintingEngine: 'telea_biharmonic',
  creativity: 0.35,
  fidelity: 0.85,
  parallelPages: 2,
  rateLimitPerMinute: 30,
  autoFallback: true,
  allowPaidFallback: false,
  fallbackOrder: ['gemini', 'groq', 'openrouter', 'cloudflare', 'qwen_studio', 'deepseek'],
  providers: {
    gemini: {
      translationModel: 'gemini-4-hydrogen',
      visionModel: 'gemini-4-hydrogen',
      endpointUrl: 'https://generativelanguage.googleapis.com',
    },
    groq: {
      translationModel: 'llama-3.3-70b-versatile',
      visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
      endpointUrl: 'https://api.groq.com/openai/v1',
    },
    openrouter: {
      translationModel: 'deepseek/deepseek-chat-v3-0324:free',
      visionModel: 'qwen/qwen2.5-vl-72b-instruct:free',
      endpointUrl: 'https://openrouter.ai/api/v1',
    },
    cloudflare: {
      translationModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      visionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
      endpointUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1',
      accountId: '',
    },
    deepseek: {
      translationModel: 'deepseek-chat',
      endpointUrl: 'https://api.deepseek.com/v1',
    },
    qwen_studio: {
      translationModel: 'qwen-plus',
      visionModel: 'qwen-vl-max',
      endpointUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
  },
};

const EMPTY_DETAILED_STATUS: ProvidersDetailedStatusMap = {
  gemini: { configured: false, source: 'none' },
  groq: { configured: false, source: 'none' },
  openrouter: { configured: false, source: 'none' },
  cloudflare: { configured: false, source: 'none', hasAccountId: false },
  deepseek: { configured: false, source: 'none' },
  qwen_studio: { configured: false, source: 'none' },
};

const DEFAULT_FONTS = [
  'Cairo',
  'IBM Plex Sans Arabic',
  'Tajawal',
  'Lalezar',
  'Comic Neue',
  'Architects Daughter',
  'Bangers',
  'Patrick Hand',
  'Plus Jakarta Sans',
  'JetBrains Mono',
];

export default function App() {
  const [lang, setLang] = useState<LanguageCode>(() => {
    const saved = localStorage.getItem('pt_lang');
    return saved === 'en' ? 'en' : 'ar';
  });
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('pt_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  const [activeSection, setActiveSection] = useState<AppSection>('library');
  const [projects, setProjects] = useState<ProjectWithDetails[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [activeChapterId, setActiveChapterId] = useState<string>('');

  const [aiSettings, setAiSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [providersStatus, setProvidersStatus] = useState<ProvidersStatusMap>({
    gemini: false,
    groq: false,
    openrouter: false,
    cloudflare: false,
    deepseek: false,
    qwen_studio: false,
  });
  const [providersDetailed, setProvidersDetailed] = useState<ProvidersDetailedStatusMap>(
    EMPTY_DETAILED_STATUS
  );
  const [availableFonts, setAvailableFonts] = useState<string[]>(DEFAULT_FONTS);

  const [studioRefreshKey, setStudioRefreshKey] = useState(0);

  const [importModalState, setImportModalState] = useState<{
    isOpen: boolean;
    initialTab: 'files' | 'url' | 'companion';
    targetProjectId?: string;
    newProjectOnly?: boolean;
    appendChapterId?: string;
    appendChapterTitle?: string;
    appendReadingDirection?: 'ltr' | 'rtl' | 'vertical';
    presetFormat?: ComicFormat;
    presetDirection?: 'ltr' | 'rtl' | 'vertical';
  }>({ isOpen: false, initialTab: 'files' });

  // Sync HTML dir/lang and dark class on documentElement
  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('pt_lang', lang);
  }, [lang]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('pt_theme', theme);
  }, [theme]);

  const refreshProjects = async () => {
    setLoadingProjects(true);
    try {
      const [pRes, sRes] = await Promise.all([api.getProjects(), api.getSettings()]);
      setProjects(pRes.projects);
      setAiSettings(sRes.settings);
      setServerConfigured(sRes.configured);
      if (sRes.providersStatus) {
        setProvidersStatus(sRes.providersStatus);
      }
      if (sRes.providersDetailed) {
        setProvidersDetailed(sRes.providersDetailed);
      }

      if (!activeChapterId) {
        const firstChapter = pRes.projects.find((p) => p.chapters.length > 0)?.chapters[0];
        if (firstChapter) setActiveChapterId(firstChapter.id);
      }
    } catch {
      // If offline, user can still open cached chapters
    } finally {
      setLoadingProjects(false);
    }
  };

  useEffect(() => {
    void refreshProjects();
  }, []);

  const activeChapterLabel = (() => {
    for (const p of projects) {
      const ch = p.chapters.find((c) => c.id === activeChapterId);
      if (ch) return `${p.title} · ${ch.title}`;
    }
    return undefined;
  })();

  return (
    <AppShell
      lang={lang}
      theme={theme}
      activeSection={activeSection}
      onNavigate={setActiveSection}
      onToggleLang={() => setLang((l) => (l === 'ar' ? 'en' : 'ar'))}
      onToggleTheme={() => setTheme((th) => (th === 'dark' ? 'light' : 'dark'))}
      onOpenNewProject={() =>
        setImportModalState({
          isOpen: true,
          initialTab: 'files',
          newProjectOnly: true,
        })
      }
      activeChapterLabel={activeChapterLabel}
    >
      {activeSection === 'library' && (
        <LibraryView
          lang={lang}
          projects={projects}
          loading={loadingProjects}
          onOpenImportModal={(initialTab, targetProjectId) =>
            setImportModalState({
              isOpen: true,
              initialTab,
              targetProjectId,
              newProjectOnly: false,
            })
          }
          onOpenWebtoonImport={() =>
            setImportModalState({
              isOpen: true,
              initialTab: 'files',
              newProjectOnly: true,
              presetFormat: 'webtoon',
              presetDirection: 'vertical',
            })
          }
          onOpenNewProjectModal={() =>
            setImportModalState({
              isOpen: true,
              initialTab: 'files',
              newProjectOnly: true,
            })
          }
          onOpenChapterInStudio={(chId) => {
            setActiveChapterId(chId);
            setActiveSection('studio');
          }}
          onOpenChapterInReader={(chId) => {
            setActiveChapterId(chId);
            setActiveSection('reader');
          }}
          onDeleteProject={async (projectId) => {
            await api.deleteProject(projectId);
            await refreshProjects();
          }}
        />
      )}

      {activeSection === 'browser' && (
        <BrowserWorkspace
          lang={lang}
          projects={projects}
          onOpenLocalImport={(initialTab) =>
            setImportModalState({
              isOpen: true,
              initialTab,
              newProjectOnly: false,
            })
          }
          onChapterImported={async (chapterId, openTranslator) => {
            await refreshProjects();
            setActiveChapterId(chapterId);
            if (openTranslator) {
              setActiveSection('studio');
            }
          }}
        />
      )}

      {activeSection === 'studio' && (
        <StudioEditor
          lang={lang}
          chapterId={activeChapterId}
          refreshKey={studioRefreshKey}
          aiSettings={aiSettings}
          availableFonts={availableFonts}
          onChangeAiProvider={async (providerId: AiProviderId) => {
            const nextModel =
              aiSettings.providers?.[providerId]?.translationModel ||
              DEFAULT_MODEL_BY_PROVIDER[providerId];
            const res = await api.updateSettings({
              provider: providerId,
              translationModel: nextModel,
            });
            setAiSettings(res.settings);
            if (res.providersStatus) setProvidersStatus(res.providersStatus);
            if (res.providersDetailed) setProvidersDetailed(res.providersDetailed);
          }}
          onOpenReader={(chId) => {
            setActiveChapterId(chId);
            setActiveSection('reader');
          }}
          onOpenAddPages={(chId, projId, chTitle, dir) =>
            setImportModalState({
              isOpen: true,
              initialTab: 'files',
              targetProjectId: projId,
              appendChapterId: chId,
              appendChapterTitle: chTitle,
              appendReadingDirection: dir,
              newProjectOnly: false,
            })
          }
          onJobStarted={() => setActiveSection('jobs')}
        />
      )}

      {activeSection === 'reader' && (
        <ChapterReader
          lang={lang}
          chapterId={activeChapterId}
          inpaintingEngine={aiSettings.inpaintingEngine}
          onBackToStudio={() => setActiveSection('studio')}
        />
      )}

      {activeSection === 'glossary' && <GlossaryView lang={lang} projects={projects} />}

      {activeSection === 'jobs' && (
        <JobsView
          lang={lang}
          onOpenChapter={(chId) => {
            setActiveChapterId(chId);
            setActiveSection('studio');
          }}
        />
      )}

      {activeSection === 'settings' && (
        <SettingsView
          lang={lang}
          theme={theme}
          settings={aiSettings}
          serverConfigured={serverConfigured}
          providersStatus={providersStatus}
          providersDetailed={providersDetailed}
          availableFonts={availableFonts}
          onChangeLang={setLang}
          onChangeTheme={setTheme}
          onSettingsUpdated={(next, status, detailed) => {
            setAiSettings(next);
            if (status) {
              setProvidersStatus(status);
              setServerConfigured(Object.values(status).some(Boolean));
            }
            if (detailed) setProvidersDetailed(detailed);
          }}
          onFontAdded={(fontName) =>
            setAvailableFonts((prev) => (prev.includes(fontName) ? prev : [...prev, fontName]))
          }
        />
      )}

      <ImportModal
        lang={lang}
        isOpen={importModalState.isOpen}
        initialTab={importModalState.initialTab}
        initialProjectId={importModalState.targetProjectId}
        appendChapterId={importModalState.appendChapterId}
        appendChapterTitle={importModalState.appendChapterTitle}
        appendReadingDirection={importModalState.appendReadingDirection}
        presetFormat={importModalState.presetFormat}
        presetDirection={importModalState.presetDirection}
        projects={projects}
        newProjectOnly={importModalState.newProjectOnly}
        onClose={() => setImportModalState((s) => ({ ...s, isOpen: false }))}
        onImportedChapter={async (chapterId) => {
          await refreshProjects();
          if (chapterId) {
            setActiveChapterId(chapterId);
            setStudioRefreshKey((k) => k + 1);
            setActiveSection('studio');
          }
        }}
      />
    </AppShell>
  );
}
