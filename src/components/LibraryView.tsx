import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  ImagePlus,
  Languages,
  Link2,
  PenLine,
  Play,
  Plus,
  Search,
  Trash2,
  WifiOff,
} from 'lucide-react';
import type { LanguageCode, ProjectWithDetails } from '../types/domain';
import { tFor } from '../i18n/translations';

interface LibraryViewProps {
  lang: LanguageCode;
  projects: ProjectWithDetails[];
  loading: boolean;
  onOpenImportModal: (initialTab: 'files' | 'url' | 'companion', targetProjectId?: string) => void;
  onOpenWebtoonImport: () => void;
  onOpenNewProjectModal: () => void;
  onOpenChapterInStudio: (chapterId: string) => void;
  onOpenChapterInReader: (chapterId: string) => void;
  onDeleteProject: (projectId: string) => Promise<void>;
}

type FilterKey =
  | 'all'
  | 'superhero'
  | 'american'
  | 'british'
  | 'european'
  | 'graphic_novel'
  | 'indie'
  | 'manga'
  | 'manhwa'
  | 'webtoon'
  | 'completed'
  | 'incomplete';

export const LibraryView: React.FC<LibraryViewProps> = ({
  lang,
  projects,
  loading,
  onOpenImportModal,
  onOpenWebtoonImport,
  onOpenChapterInStudio,
  onOpenChapterInReader,
  onDeleteProject,
}) => {
  const t = tFor(lang);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const firstChapterAvailable = useMemo(
    () => projects.find((p) => p.chapters.length > 0)?.chapters[0] || null,
    [projects]
  );

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (q && !p.title.toLowerCase().includes(q) && !p.sourceLanguage.toLowerCase().includes(q)) {
        return false;
      }
      if (filter === 'all') return true;
      if (filter === 'completed') return p.completionPercent === 100 && p.chapters.length > 0;
      if (filter === 'incomplete') return p.completionPercent < 100 || p.chapters.length === 0;
      if (filter === 'american') return p.comicFormat === 'american' || p.comicFormat === 'comic';
      return p.comicFormat === filter;
    });
  }, [projects, filter, search]);

  const filterButtons: Array<{ key: FilterKey; label: string }> = [
    { key: 'all', label: t.home.filters.all },
    { key: 'superhero', label: t.home.filters.superhero },
    { key: 'american', label: t.home.filters.american },
    { key: 'british', label: t.home.filters.british },
    { key: 'european', label: t.home.filters.european },
    { key: 'graphic_novel', label: t.home.filters.graphic_novel },
    { key: 'indie', label: t.home.filters.indie },
    { key: 'manga', label: t.home.filters.manga },
    { key: 'manhwa', label: t.home.filters.manhwa },
    { key: 'webtoon', label: t.home.filters.webtoon },
    { key: 'completed', label: t.home.filters.completed },
    { key: 'incomplete', label: t.home.filters.incomplete },
  ];

  const featureCards = [
    {
      id: 'in-bubble',
      title: t.home.feature1Title,
      desc: t.home.feature1Desc,
      icon: <Languages className="w-6 h-6 text-[#EA3829] stroke-[2.25]" />,
      onClick: () => {
        if (firstChapterAvailable) onOpenChapterInStudio(firstChapterAvailable.id);
        else onOpenImportModal('files');
      },
    },
    {
      id: 'edit-bubble',
      title: t.home.feature2Title,
      desc: t.home.feature2Desc,
      icon: <PenLine className="w-6 h-6 text-[#EA3829] stroke-[2.25]" />,
      onClick: () => {
        if (firstChapterAvailable) onOpenChapterInStudio(firstChapterAvailable.id);
        else onOpenImportModal('files');
      },
    },
    {
      id: 'webtoon-slices',
      title: t.home.feature3Title,
      desc: t.home.feature3Desc,
      icon: <BookOpen className="w-6 h-6 text-[#EA3829] stroke-[2.25]" />,
      onClick: () => onOpenWebtoonImport(),
    },
    {
      id: 'offline-read',
      title: t.home.feature4Title,
      desc: t.home.feature4Desc,
      icon: <WifiOff className="w-6 h-6 text-[#EA3829] stroke-[2.25]" />,
      onClick: () => {
        if (firstChapterAvailable) onOpenChapterInReader(firstChapterAvailable.id);
        else onOpenImportModal('files');
      },
    },
  ];

  return (
    <div className="max-w-6xl w-full mx-auto px-4 lg:px-8 py-5 sm:py-7 space-y-8">
      {/* Main Yellow Halftone Hero Card (exact match to Faqqa reference) */}
      <section
        aria-label={t.home.heroTitle}
        className="faqqa-halftone-yellow rounded-[28px] border-[2.5px] border-[#111111] shadow-[6px_6px_0px_#111111] p-6 sm:p-9 lg:p-11"
      >
        <div className="flex flex-col items-start gap-5 max-w-3xl">
          {/* Truthful Coral Red Badge */}
          <span className="inline-flex items-center px-4 py-1.5 rounded-full bg-[#EA3829] text-white border-2 border-[#111111] shadow-[2px_2px_0px_#111111] text-xs sm:text-sm font-extrabold">
            {t.home.badgeText}
          </span>

          {/* Bold Comic Display Headline */}
          <h1 className="font-display-comic text-[1.95rem] sm:text-[2.75rem] lg:text-[3.2rem] font-black leading-[1.16] tracking-tight text-[#111111] text-balance">
            {t.home.heroTitle}
          </h1>

          {/* Description */}
          <p className="text-sm sm:text-base lg:text-lg font-bold text-[#1A1A1A] leading-relaxed max-w-2xl">
            {t.home.heroSubtitle}
          </p>

          {/* Hero Primary Dark CTA + Quick URL Import Option */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => onOpenImportModal('files')}
              className="faqqa-btn-black inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm sm:text-base font-black whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-5 h-5 stroke-[2.75]" />
              <span>{t.home.heroCta}</span>
            </button>

            <button
              type="button"
              onClick={() => onOpenImportModal('url')}
              className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl border-2 border-[#111111] bg-[#FFFDF9] hover:bg-[#FAF5E8] text-[#111111] text-xs sm:text-sm font-extrabold shadow-[3px_3px_0px_#111111] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Link2 className="w-4 h-4 text-[#EA3829]" />
              <span>{t.home.btnImportUrl}</span>
            </button>
          </div>
        </div>
      </section>

      {/* 4 Comic Feature Cards (2x2 on mobile, 4-across on desktop) */}
      <section aria-label={lang === 'ar' ? 'المزايا الرئيسية' : 'Key Features'}>
        <div className="grid grid-cols-1 min-[340px]:grid-cols-2 lg:grid-cols-4 gap-3.5 sm:gap-4">
          {featureCards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={card.onClick}
              className="faqqa-card-interactive rounded-[22px] p-4 sm:p-5 text-start flex flex-col justify-between gap-2.5 cursor-pointer"
            >
              <div className="flex items-center justify-end w-full">
                <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[#FFE01B]/35 dark:bg-[#FFE01B]/15 border-2 border-[#111111]/15 dark:border-white/15">
                  {card.icon}
                </span>
              </div>
              <div className="space-y-1.5">
                <h2 className="font-display-comic text-base sm:text-lg font-black text-[#111111] dark:text-[#FFFDF9] leading-snug">
                  {card.title}
                </h2>
                <p className="text-xs sm:text-[13px] font-medium text-[#524E46] dark:text-slate-300 leading-relaxed">
                  {card.desc}
                </p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* My Library Section */}
      <section className="space-y-5 pt-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h2 className="font-display-comic text-2xl font-black text-[#111111] dark:text-[#FFFDF9]">
              {t.home.allProjects}
            </h2>
            <span className="px-2.5 py-0.5 rounded-full bg-[#FFE01B] text-[#111111] border-2 border-[#111111] text-xs font-black font-mono-tabular">
              {projects.length}
            </span>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-[#524E46] dark:text-slate-400 absolute top-1/2 -translate-y-1/2 start-3.5 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.home.searchPlaceholder}
              aria-label={t.home.searchPlaceholder}
              className="w-full ps-10 pe-3.5 py-2 text-sm font-semibold rounded-2xl border-2 border-[#111111] dark:border-white/25 bg-[#FFFDF9] dark:bg-[#1A1B21] text-[#111111] dark:text-[#FFFDF9] shadow-[3px_3px_0px_#111111] dark:shadow-[3px_3px_0px_#000000] focus:outline-none focus:ring-2 focus:ring-[#FFE01B]"
            />
          </div>
        </div>

        {/* Comic Filter Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {filterButtons.map((btn) => (
            <button
              key={btn.key}
              type="button"
              onClick={() => setFilter(btn.key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-extrabold whitespace-nowrap shrink-0 border-2 transition-all cursor-pointer ${
                filter === btn.key
                  ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                  : 'bg-[#FFFDF9] dark:bg-[#1A1B21] border-[#111111]/20 dark:border-white/15 text-[#4A463E] dark:text-slate-300 hover:border-[#111111] dark:hover:border-[#FFE01B]'
              }`}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {/* Projects Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="faqqa-card h-64 rounded-[22px] animate-pulse"
              />
            ))}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="faqqa-card rounded-[24px] p-10 text-center space-y-4">
            <p className="text-sm font-bold text-[#524E46] dark:text-slate-300">{t.home.emptyLibrary}</p>
            <button
              type="button"
              onClick={() => onOpenImportModal('files')}
              className="faqqa-btn-yellow inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-black cursor-pointer"
            >
              <ImagePlus className="w-4 h-4" />
              <span>{t.home.btnUploadImages}</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredProjects.map((project) => {
              const firstChapter = project.chapters[0];
              return (
                <article
                  key={project.id}
                  className="faqqa-card flex flex-col rounded-[22px] overflow-hidden"
                >
                  <div className="flex gap-4 p-4">
                    {/* Cover Thumbnail */}
                    <div className="w-24 h-32 rounded-xl overflow-hidden bg-[#FAF5E8] dark:bg-[#111216] shrink-0 border-2 border-[#111111] dark:border-white/25 flex items-center justify-center">
                      {project.coverImage ? (
                        <img
                          src={project.coverImage}
                          alt={project.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <BookOpen className="w-8 h-8 text-[#EA3829]" />
                      )}
                    </div>

                    {/* Metadata & Completion Bar */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <h3
                          dir="auto"
                          title={project.title}
                          className="font-display-comic text-base font-black text-[#111111] dark:text-[#FFFDF9] line-clamp-1"
                        >
                          {project.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-[#524E46] dark:text-slate-400">
                          <span className="uppercase px-1.5 py-0.5 rounded bg-[#FFE01B]/45 dark:bg-[#FFE01B]/20 text-[#111111] dark:text-[#FFE01B] text-[10px]">
                            {project.comicFormat}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {project.sourceLanguage.toUpperCase()} → {project.targetLanguage.toUpperCase()}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            <span className="font-mono-tabular">{project.chapters.length}</span> {t.home.chaptersCount}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-1.5 pt-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-[#524E46] dark:text-slate-400">{t.home.completion}</span>
                          <span className="font-mono-tabular font-black text-[#111111] dark:text-[#FFFDF9]">
                            {project.completionPercent}%
                          </span>
                        </div>
                        <div className="w-full h-2.5 rounded-full bg-[#FAF5E8] dark:bg-[#111216] border border-[#111111]/30 dark:border-white/20 overflow-hidden">
                          <div
                            className="h-full bg-[#FFE01B] transition-all"
                            style={{ width: `${project.completionPercent}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Chapters Quick List */}
                  <div className="px-4 py-2.5 border-t-2 border-[#111111]/10 dark:border-white/10 space-y-1.5 bg-[#FAF5E8]/60 dark:bg-[#14151A]">
                    {project.chapters.length === 0 ? (
                      <button
                        type="button"
                        onClick={() => onOpenImportModal('files', project.id)}
                        className="w-full py-1.5 text-xs font-extrabold text-[#EA3829] hover:underline text-start cursor-pointer"
                      >
                        + {t.importModal.title}
                      </button>
                    ) : (
                      project.chapters.slice(0, 3).map((ch) => (
                        <div
                          key={ch.id}
                          className="flex items-center justify-between gap-2 text-xs py-1"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenChapterInStudio(ch.id)}
                            className="truncate text-start font-bold text-[#222222] dark:text-slate-200 hover:text-[#EA3829] dark:hover:text-[#FFE01B] cursor-pointer"
                          >
                            {ch.title}
                          </button>
                          <span className="font-mono-tabular font-bold text-[#524E46] dark:text-slate-400 shrink-0">
                            {ch.pageCount}p
                          </span>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Card Actions Footer */}
                  <div className="px-4 py-3 border-t-2 border-[#111111]/15 dark:border-white/15 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!firstChapter}
                        onClick={() => firstChapter && onOpenChapterInStudio(firstChapter.id)}
                        className="faqqa-btn-yellow inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl disabled:opacity-40 text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>{t.home.openStudio}</span>
                      </button>
                      {firstChapter && (
                        <button
                          type="button"
                          onClick={() => onOpenChapterInReader(firstChapter.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border-2 border-[#111111]/25 dark:border-white/25 hover:border-[#111111] dark:hover:border-[#FFE01B] text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <BookOpen className="w-3.5 h-3.5 text-[#EA3829]" />
                          <span>{t.home.openReader}</span>
                        </button>
                      )}
                    </div>

                    {confirmDeleteId === project.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            await onDeleteProject(project.id);
                            setConfirmDeleteId(null);
                          }}
                          className="px-2.5 py-1 rounded-xl bg-[#EA3829] text-white border-2 border-[#111111] text-xs font-extrabold cursor-pointer"
                        >
                          {t.home.confirmDelete}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-1 text-xs font-bold text-[#524E46] hover:text-[#111111] cursor-pointer"
                        >
                          {t.home.cancel}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-label={`${t.home.deleteProject}: ${project.title}`}
                        onClick={() => setConfirmDeleteId(project.id)}
                        className="p-1.5 rounded-xl text-[#524E46] hover:text-[#EA3829] hover:bg-[#EA3829]/10 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Quiet Privacy Footer Note */}
      <footer className="pt-4 border-t-2 border-[#111111]/10 dark:border-white/10 text-xs font-semibold text-[#524E46] dark:text-slate-400">
        {t.home.privacyNotice}
      </footer>
    </div>
  );
};
