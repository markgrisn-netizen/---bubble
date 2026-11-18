import React, { useState } from 'react';
import {
  BookOpen,
  FolderKanban,
  Globe,
  Layers,
  ListChecks,
  Menu,
  Moon,
  Plus,
  Settings,
  Sun,
  X,
} from 'lucide-react';
import type { LanguageCode, ThemeMode } from '../types/domain';
import { tFor } from '../i18n/translations';
import { PWAInstallButton } from './PWAInstallButton';
import { OfflineIndicator } from './OfflineIndicator';

export type AppSection = 'library' | 'browser' | 'studio' | 'reader' | 'glossary' | 'jobs' | 'settings';

interface AppShellProps {
  lang: LanguageCode;
  theme: ThemeMode;
  activeSection: AppSection;
  onNavigate: (section: AppSection) => void;
  onToggleLang: () => void;
  onToggleTheme: () => void;
  onOpenNewProject: () => void;
  activeChapterLabel?: string;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  lang,
  theme,
  activeSection,
  onNavigate,
  onToggleLang,
  onToggleTheme,
  onOpenNewProject,
  activeChapterLabel,
  children,
}) => {
  const t = tFor(lang);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navItems: Array<{ id: AppSection; label: string; icon: React.ReactNode }> = [
    { id: 'library', label: t.nav.library, icon: <FolderKanban className="w-4 h-4" /> },
    { id: 'browser', label: t.nav.browser, icon: <Globe className="w-4 h-4" /> },
    { id: 'studio', label: t.nav.studio, icon: <Layers className="w-4 h-4" /> },
    { id: 'glossary', label: t.nav.glossary, icon: <BookOpen className="w-4 h-4" /> },
    { id: 'settings', label: t.nav.settings, icon: <Settings className="w-4 h-4" /> },
  ];

  // Reader mode uses full-bleed viewport without standard app chrome unless exited
  if (activeSection === 'reader') {
    return <div className="min-h-screen bg-[#111216] text-[#FFFDF9]">{children}</div>;
  }

  const activeLabel =
    activeSection === 'jobs'
      ? t.nav.jobs
      : navItems.find((n) => n.id === activeSection)?.label || t.nav.library;

  return (
    <div
      className={`flex flex-col faqqa-halftone-bg text-[#111111] dark:text-[#FFFDF9] overflow-x-hidden ${
        activeSection === 'studio' ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'
      }`}
    >
      {/* Top Navbar matching Faqqa Pop-Art Comic Design */}
      <header className="sticky top-0 z-30 h-16 px-4 lg:px-8 bg-[#FAF5E8]/95 dark:bg-[#111216]/95 backdrop-blur-sm border-b-[2.5px] border-[#111111] dark:border-[#FFFDF9]/20 flex items-center justify-between gap-4 shrink-0">
        {/* Zone 1: Brand Emblem (Yellow circle with ف) + Bold Wordmark + Mobile Menu Trigger */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            className="md:hidden p-2 rounded-xl border-2 border-[#111111] dark:border-[#FFFDF9]/30 bg-[#FFFDF9] dark:bg-[#1C1D24] text-[#111111] dark:text-[#FFFDF9] shadow-[2px_2px_0px_#111111] dark:shadow-[2px_2px_0px_#000000] cursor-pointer"
          >
            {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>

          <a
            href="#library"
            onClick={(e) => {
              e.preventDefault();
              onNavigate('library');
            }}
            className="inline-flex items-center gap-2.5 group whitespace-nowrap shrink-0"
          >
            <span
              aria-hidden="true"
              className="w-10 h-10 rounded-full bg-[#FFE01B] border-[2.5px] border-[#111111] shadow-[2px_3px_0px_#111111] flex items-center justify-center text-xl font-black text-[#111111] leading-none group-hover:-translate-y-0.5 transition-transform"
            >
              ف
            </span>
            <span className="font-display-comic text-xl sm:text-2xl font-black tracking-tight text-[#111111] dark:text-[#FFFDF9]">
              {t.appName}
            </span>
          </a>
        </div>

        {/* Zone 2: Desktop Navigation Tabs */}
        <nav className="hidden md:flex items-center gap-1.5 lg:gap-2" aria-label="Main Navigation">
          {navItems.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                className={`px-3 py-1.5 rounded-xl text-sm font-extrabold whitespace-nowrap shrink-0 transition-all cursor-pointer border-2 ${
                  isActive
                    ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'border-transparent text-[#333333] dark:text-slate-200 hover:bg-[#FFFDF9] dark:hover:bg-[#1E2028] hover:border-[#111111]/20 dark:hover:border-white/20'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Quick Theme/Lang Toggles (desktop) + Yellow Comic "+ فصل جديد" CTA */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden lg:flex items-center gap-1.5">
            <PWAInstallButton lang={lang} />
            <button
              type="button"
              onClick={() => onNavigate('jobs')}
              aria-label={t.nav.jobs}
              title={t.nav.jobs}
              className={`p-2 rounded-xl border-2 transition-colors cursor-pointer ${
                activeSection === 'jobs'
                  ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                  : 'bg-[#FFFDF9] dark:bg-[#1C1D24] border-[#111111]/25 dark:border-white/20 text-[#111111] dark:text-[#FFFDF9] hover:border-[#111111]'
              }`}
            >
              <ListChecks className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onToggleLang}
              aria-label={lang === 'ar' ? 'Switch interface to English' : 'تبديل الواجهة للعربية'}
              className="px-2.5 py-1.5 rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FFFDF9] dark:bg-[#1C1D24] text-xs font-extrabold text-[#111111] dark:text-[#FFFDF9] hover:border-[#111111] transition-colors cursor-pointer"
            >
              {lang === 'ar' ? 'EN' : 'AR'}
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'التبديل للوضع الداكن'}
              className="p-2 rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FFFDF9] dark:bg-[#1C1D24] text-[#111111] dark:text-[#FFFDF9] hover:border-[#111111] transition-colors cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-[#FFE01B]" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenNewProject}
            className="faqqa-btn-yellow inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-black rounded-2xl whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4 stroke-[2.75]" />
            <span>{t.nav.newProject}</span>
          </button>
        </div>
      </header>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b-[2.5px] border-[#111111] dark:border-white/20 bg-[#FFFDF9] dark:bg-[#1A1B21] px-4 py-3 space-y-1.5 z-20">
          {[...navItems, { id: 'jobs' as AppSection, label: t.nav.jobs, icon: <ListChecks className="w-4 h-4" /> }].map(
            (item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onNavigate(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-extrabold border-2 transition-colors ${
                  activeSection === item.id
                    ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'border-transparent text-[#222222] dark:text-slate-200 hover:bg-[#FAF5E8] dark:hover:bg-[#24262F]'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            )
          )}
          <div className="pt-2 border-t-2 border-[#111111]/10 dark:border-white/10 flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleLang}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl border-2 border-[#111111]/30 dark:border-white/25 text-xs font-extrabold"
            >
              <Globe className="w-4 h-4" />
              <span>{lang === 'ar' ? 'English (LTR)' : 'العربية (RTL)'}</span>
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl border-2 border-[#111111]/30 dark:border-white/25 text-xs font-extrabold"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-[#FFE01B]" /> : <Moon className="w-4 h-4" />}
              <span>{theme === 'dark' ? t.settings.light : t.settings.dark}</span>
            </button>
          </div>
          <div className="pt-1 flex justify-center">
            <PWAInstallButton lang={lang} />
          </div>
        </div>
      )}

      {/* Workspace Breadcrumb Strip (for Studio / Browser / Glossary / Jobs / Settings) */}
      {activeSection !== 'library' && (
        <div className="hidden md:flex items-center justify-between px-6 lg:px-8 py-1.5 bg-[#FFFDF9]/90 dark:bg-[#16171C]/90 border-b border-[#111111]/15 dark:border-white/10 text-xs text-[#444444] dark:text-slate-300">
          <div className="flex items-center gap-2 truncate">
            <span className="font-extrabold text-[#111111] dark:text-[#FFE01B]">{activeLabel}</span>
            {activeChapterLabel && (
              <>
                <span aria-hidden="true">/</span>
                <span className="truncate font-medium">{activeChapterLabel}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 lg:hidden">
            <button
              type="button"
              onClick={() => onNavigate('jobs')}
              className="px-2 py-0.5 rounded-lg border border-[#111111]/25 dark:border-white/20 font-bold"
            >
              {t.nav.jobs}
            </button>
            <button
              type="button"
              onClick={onToggleLang}
              className="px-2 py-0.5 rounded-lg border border-[#111111]/25 dark:border-white/20 font-bold"
            >
              {lang === 'ar' ? 'EN' : 'AR'}
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              className="p-1 rounded-lg border border-[#111111]/25 dark:border-white/20"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-h-0">{children}</main>
      <OfflineIndicator lang={lang} />
    </div>
  );
};
