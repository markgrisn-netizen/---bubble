import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  Globe,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  CharacterMemory,
  GlossaryCategory,
  GlossaryEntry,
  GlossaryScope,
  GlossarySuggestion,
  LanguageCode,
  ProjectWithDetails,
} from '../types/domain';
import { tFor } from '../i18n/translations';
import { api } from '../utils/api';
import { exportGlossaryCsv, normalizeGlossaryCategory, parseGlossaryCsv } from '../utils/bubbleLayout';
import { GLOBAL_GLOSSARY_PROJECT_ID } from '../utils/glossaryMatcher';

interface GlossaryViewProps {
  lang: LanguageCode;
  projects: ProjectWithDetails[];
}

const GLOSSARY_CATEGORIES: GlossaryCategory[] = [
  'character',
  'title',
  'team',
  'power',
  'ability',
  'place',
  'military',
  'scientific',
  'fantasy',
  'sfx',
  'term',
];

export const GlossaryView: React.FC<GlossaryViewProps> = ({ lang, projects }) => {
  const t = tFor(lang);
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id || '');
  const [activeTab, setActiveTab] = useState<'project' | 'global' | 'suggestions'>('project');

  const [projectEntries, setProjectEntries] = useState<GlossaryEntry[]>([]);
  const [globalEntries, setGlobalEntries] = useState<GlossaryEntry[]>([]);
  const [overriddenGlobalIds, setOverriddenGlobalIds] = useState<string[]>([]);
  const [overridingProjectIds, setOverridingProjectIds] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<GlossarySuggestion[]>([]);
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, string>>({});

  const [characters, setCharacters] = useState<CharacterMemory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<'all' | GlossaryCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Add form state
  const [originalTerm, setOriginalTerm] = useState('');
  const [translatedTerm, setTranslatedTerm] = useState('');
  const [category, setCategory] = useState<GlossaryCategory>('character');
  const [notes, setNotes] = useState('');

  // Inline Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editOriginal, setEditOriginal] = useState('');
  const [editTranslated, setEditTranslated] = useState('');
  const [editCategory, setEditCategory] = useState<GlossaryCategory>('term');
  const [editNotes, setEditNotes] = useState('');

  const [charName, setCharName] = useState('');
  const [charTranslated, setCharTranslated] = useState('');
  const [charStyle, setCharStyle] = useState('');
  const [charRelations, setCharRelations] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const loadData = async (pid: string) => {
    if (!pid) {
      const gGlobal = await api.getGlobalGlossary();
      setGlobalEntries(gGlobal.entries || []);
      return;
    }
    const [gRes, pRes, sRes] = await Promise.all([
      api.getGlossary(pid, true),
      api.getProject(pid),
      api.getGlossarySuggestions(pid),
    ]);
    setProjectEntries(gRes.projectEntries || []);
    setGlobalEntries(gRes.globalEntries || []);
    setOverriddenGlobalIds(gRes.overriddenGlobalIds || []);
    setOverridingProjectIds(gRes.overridingProjectIds || []);
    setCharacters(pRes.project.storyMemory.characters || []);
    setSuggestions(sRes.suggestions || []);
  };

  useEffect(() => {
    void loadData(selectedProjectId);
  }, [selectedProjectId]);

  const activeScope: GlossaryScope = activeTab === 'global' ? 'global' : 'project';

  const handleAddTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!originalTerm.trim() || !translatedTerm.trim()) return;
    if (activeScope === 'project' && !selectedProjectId) return;

    await api.addGlossaryTerm({
      projectId: activeScope === 'global' ? GLOBAL_GLOSSARY_PROJECT_ID : selectedProjectId,
      scope: activeScope,
      originalTerm: originalTerm.trim(),
      translatedTerm: translatedTerm.trim(),
      category,
      notes: notes.trim(),
    });
    setOriginalTerm('');
    setTranslatedTerm('');
    setNotes('');
    await loadData(selectedProjectId);
  };

  const startEdit = (entry: GlossaryEntry) => {
    setEditingId(entry.id);
    setEditOriginal(entry.originalTerm);
    setEditTranslated(entry.translatedTerm);
    setEditCategory(entry.category);
    setEditNotes(entry.notes || '');
  };

  const saveEdit = async () => {
    if (!editingId || !editOriginal.trim() || !editTranslated.trim()) return;
    await api.updateGlossaryTerm(editingId, {
      originalTerm: editOriginal.trim(),
      translatedTerm: editTranslated.trim(),
      category: editCategory,
      notes: editNotes.trim(),
    });
    setEditingId(null);
    await loadData(selectedProjectId);
  };

  const handleDeleteTerm = async (id: string) => {
    await api.deleteGlossaryTerm(id);
    await loadData(selectedProjectId);
  };

  const handleApproveSuggestion = async (sugg: GlossarySuggestion, scope: GlossaryScope) => {
    const edited = (suggestionEdits[sugg.id] ?? sugg.suggestedTranslation).trim();
    await api.approveGlossarySuggestion(sugg.id, {
      scope,
      projectId: scope === 'project' ? selectedProjectId : undefined,
      translatedTerm: edited || sugg.suggestedTranslation,
      category: sugg.category,
      notes: sugg.notes,
    });
    await loadData(selectedProjectId);
  };

  const handleDismissSuggestion = async (id: string) => {
    await api.dismissGlossarySuggestion(id);
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  };

  const handleAddCharacter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId || !charName.trim() || !charTranslated.trim()) return;
    const pRes = await api.getProject(selectedProjectId);
    const nextChars: CharacterMemory[] = [
      ...(pRes.project.storyMemory.characters || []),
      {
        id: `char-${Date.now()}`,
        name: charName.trim(),
        translatedName: charTranslated.trim(),
        speechStyle: charStyle.trim(),
        relations: charRelations.trim(),
      },
    ];
    await api.updateProject(selectedProjectId, {
      storyMemory: { ...pRes.project.storyMemory, characters: nextChars },
    });
    setCharacters(nextChars);
    setCharName('');
    setCharTranslated('');
    setCharStyle('');
    setCharRelations('');
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    const targetPid = activeScope === 'global' ? GLOBAL_GLOSSARY_PROJECT_ID : selectedProjectId;
    if (!targetPid) return;
    const text = await file.text();
    let parsed: Array<Omit<GlossaryEntry, 'id' | 'projectId'>> = [];
    if (file.name.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        parsed = json
          .filter((x) => x.originalTerm && x.translatedTerm)
          .map((x) => ({
            originalTerm: String(x.originalTerm),
            translatedTerm: String(x.translatedTerm),
            category: normalizeGlossaryCategory(x.category),
            notes: String(x.notes || ''),
          }));
      }
    } else {
      parsed = parseGlossaryCsv(text);
    }
    if (parsed.length > 0) {
      await api.importGlossaryTerms(targetPid, parsed);
      await loadData(selectedProjectId);
    }
  };

  const downloadText = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const currentScopeEntries = activeTab === 'global' ? globalEntries : projectEntries;
  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return currentScopeEntries.filter((e) => {
      if (categoryFilter !== 'all' && e.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        e.originalTerm.toLowerCase().includes(q) ||
        e.translatedTerm.toLowerCase().includes(q) ||
        (e.notes || '').toLowerCase().includes(q)
      );
    });
  }, [currentScopeEntries, categoryFilter, searchQuery]);

  const overriddenGlobalSet = useMemo(() => new Set(overriddenGlobalIds), [overriddenGlobalIds]);
  const overridingProjectSet = useMemo(
    () => new Set(overridingProjectIds),
    [overridingProjectIds]
  );

  return (
    <div className="max-w-6xl w-full mx-auto px-4 lg:px-8 py-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white">{t.glossary.title}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t.glossary.subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            aria-label={t.glossary.selectProject}
            className="px-3 py-2 rounded-xl border-2 border-[#111111]/20 dark:border-slate-700 bg-white dark:bg-[#161B22] text-sm font-bold"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs font-bold cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t.glossary.importCsv}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                exportGlossaryCsv(currentScopeEntries),
                `glossary-${activeScope}.csv`,
                'text/csv;charset=utf-8'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs font-bold cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.glossary.exportCsv}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                JSON.stringify(currentScopeEntries, null, 2),
                `glossary-${activeScope}.json`,
                'application/json'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs font-bold cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.glossary.exportJson}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json"
            onChange={(e) => void handleImportFile(e.target.files?.[0])}
            className="hidden"
          />
        </div>
      </div>

      {/* Personal Glossary Scope Tabs: Project | Global | AI Suggestions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="glossary-tab-project"
          onClick={() => setActiveTab('project')}
          className={`px-4 py-2 rounded-xl text-xs font-black border-2 cursor-pointer transition-all ${
            activeTab === 'project'
              ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
              : 'bg-white dark:bg-[#161B22] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
          }`}
        >
          {t.glossary.tabProject} ({projectEntries.length})
        </button>
        <button
          type="button"
          data-testid="glossary-tab-global"
          onClick={() => setActiveTab('global')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black border-2 cursor-pointer transition-all ${
            activeTab === 'global'
              ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
              : 'bg-white dark:bg-[#161B22] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
          <span>
            {t.glossary.tabGlobal} ({globalEntries.length})
          </span>
        </button>
        <button
          type="button"
          data-testid="glossary-tab-suggestions"
          onClick={() => setActiveTab('suggestions')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black border-2 cursor-pointer transition-all ${
            activeTab === 'suggestions'
              ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
              : 'bg-white dark:bg-[#161B22] border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{t.glossary.tabSuggestions}</span>
          {suggestions.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-md bg-[#EA3829] text-white text-[10px] font-black">
              {suggestions.length}
            </span>
          )}
        </button>
      </div>

      {activeTab === 'suggestions' ? (
        <section className="space-y-3" data-testid="glossary-suggestions-list">
          {suggestions.length === 0 ? (
            <div className="faqqa-card p-8 rounded-[22px] text-center text-sm text-slate-500 dark:text-slate-400">
              {t.glossary.noSuggestions}
            </div>
          ) : (
            suggestions.map((sugg) => {
              const draftVal = suggestionEdits[sugg.id] ?? sugg.suggestedTranslation;
              return (
                <div
                  key={sugg.id}
                  className="faqqa-card p-4 rounded-[20px] flex flex-col md:flex-row md:items-center justify-between gap-3"
                >
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-black text-slate-900 dark:text-white">
                        {sugg.originalTerm}
                      </span>
                      <span className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                        {t.glossary.categories[sugg.category] || sugg.category}
                      </span>
                      <span className="text-[11px] font-mono-tabular text-slate-500">
                        ×{sugg.occurrences} {t.glossary.occurrencesLabel}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={draftVal}
                      onChange={(e) =>
                        setSuggestionEdits((prev) => ({ ...prev, [sugg.id]: e.target.value }))
                      }
                      aria-label={sugg.originalTerm}
                      className="w-full max-w-md px-3 py-1.5 text-sm font-bold rounded-xl border border-slate-200 dark:border-slate-700 bg-[#FAF5E8] dark:bg-[#111216]"
                    />
                    {sugg.notes && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">{sugg.notes}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleApproveSuggestion(sugg, 'project')}
                      className="faqqa-btn-yellow inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-black cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{t.glossary.approveInProject}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleApproveSuggestion(sugg, 'global')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-[#111111] dark:border-white/25 bg-white dark:bg-[#161B22] text-xs font-black cursor-pointer"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>{t.glossary.approveAsGlobal}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDismissSuggestion(sugg.id)}
                      className="px-3 py-2 rounded-xl text-xs font-bold text-slate-500 hover:text-rose-600 cursor-pointer"
                    >
                      {t.glossary.dismissSuggestion}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </section>
      ) : (
        <>
          {/* Add Term Form */}
          <form
            onSubmit={handleAddTerm}
            className="faqqa-card grid grid-cols-1 md:grid-cols-5 gap-3 p-4 rounded-[22px]"
          >
            <input
              type="text"
              required
              value={originalTerm}
              onChange={(e) => setOriginalTerm(e.target.value)}
              placeholder={t.glossary.originalTerm}
              aria-label={t.glossary.originalTerm}
              className="px-3 py-2 text-sm rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FAF5E8] dark:bg-[#111216]"
            />
            <input
              type="text"
              required
              value={translatedTerm}
              onChange={(e) => setTranslatedTerm(e.target.value)}
              placeholder={t.glossary.translatedTerm}
              aria-label={t.glossary.translatedTerm}
              className="px-3 py-2 text-sm rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FAF5E8] dark:bg-[#111216]"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as GlossaryCategory)}
              aria-label={t.glossary.category}
              className="px-3 py-2 text-sm rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FAF5E8] dark:bg-[#111216]"
            >
              {GLOSSARY_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t.glossary.categories[cat]}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t.glossary.notes}
              aria-label={t.glossary.notes}
              className="px-3 py-2 text-sm rounded-xl border-2 border-[#111111]/25 dark:border-white/20 bg-[#FAF5E8] dark:bg-[#111216]"
            />
            <button
              type="submit"
              className="faqqa-btn-yellow inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-sm font-black cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>{t.glossary.addTerm}</span>
            </button>
          </form>

          {/* Search & Category Filter */}
          <div className="space-y-3">
            <div className="relative max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t.glossary.searchPlaceholder}
                aria-label={t.glossary.searchPlaceholder}
                className="w-full ps-9 pe-3 py-2 text-sm rounded-xl border-2 border-[#111111]/20 dark:border-slate-700 bg-white dark:bg-[#161B22]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCategoryFilter('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-extrabold border-2 cursor-pointer transition-all ${
                  categoryFilter === 'all'
                    ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                    : 'bg-[#FFFDF9] dark:bg-[#1A1B21] border-[#111111]/20 dark:border-white/15 text-[#524E46] dark:text-slate-300'
                }`}
              >
                {t.glossary.allCategories}
              </button>
              {GLOSSARY_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-extrabold border-2 cursor-pointer transition-all ${
                    categoryFilter === cat
                      ? 'bg-[#FFE01B] text-[#111111] border-[#111111] shadow-[2px_2px_0px_#111111]'
                      : 'bg-[#FFFDF9] dark:bg-[#1A1B21] border-[#111111]/20 dark:border-white/15 text-[#524E46] dark:text-slate-300'
                  }`}
                >
                  {t.glossary.categories[cat]}
                </button>
              ))}
            </div>
          </div>

          {/* Glossary Table with Inline Edit */}
          <div className="faqqa-card rounded-[22px] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-start">
                <thead className="bg-slate-50 dark:bg-[#0D1117] border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500">
                  <tr>
                    <th className="py-3 px-4 font-semibold text-start">Original</th>
                    <th className="py-3 px-4 font-semibold text-start">Translation</th>
                    <th className="py-3 px-4 font-semibold text-start">{t.glossary.category}</th>
                    <th className="py-3 px-4 font-semibold text-start">{t.glossary.notes}</th>
                    <th className="py-3 px-4 font-semibold text-end">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredEntries.map((entry) => {
                    const isEditing = editingId === entry.id;
                    const isOverridden = overriddenGlobalSet.has(entry.id);
                    const overridesGlobal = overridingProjectSet.has(entry.id);

                    return (
                      <tr key={entry.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                        <td className="py-2.5 px-4 font-bold">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editOriginal}
                              onChange={(e) => setEditOriginal(e.target.value)}
                              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                            />
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span>{entry.originalTerm}</span>
                              {overridesGlobal && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">
                                  {t.glossary.overridesGlobalBadge}
                                </span>
                              )}
                              {isOverridden && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 text-[10px] font-bold">
                                  {t.glossary.overriddenBadge}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-4 font-extrabold text-[#EA3829] dark:text-[#FFE01B]">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editTranslated}
                              onChange={(e) => setEditTranslated(e.target.value)}
                              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117] text-slate-900 dark:text-white"
                            />
                          ) : (
                            entry.translatedTerm
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-xs text-slate-500">
                          {isEditing ? (
                            <select
                              value={editCategory}
                              onChange={(e) => setEditCategory(e.target.value as GlossaryCategory)}
                              className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                            >
                              {GLOSSARY_CATEGORIES.map((cat) => (
                                <option key={cat} value={cat}>
                                  {t.glossary.categories[cat]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            t.glossary.categories[entry.category] || entry.category
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-xs text-slate-500">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className="w-full px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#0D1117]"
                            />
                          ) : (
                            entry.notes || '—'
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-end whitespace-nowrap">
                          {isEditing ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={t.glossary.saveEdit}
                                onClick={() => void saveEdit()}
                                className="p-1.5 text-emerald-600 hover:text-emerald-700 cursor-pointer"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                aria-label={t.glossary.cancelEdit}
                                onClick={() => setEditingId(null)}
                                className="p-1.5 text-slate-500 hover:text-slate-700 cursor-pointer"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={`${t.glossary.editTerm} ${entry.originalTerm}`}
                                onClick={() => startEdit(entry)}
                                className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete ${entry.originalTerm}`}
                                onClick={() => void handleDeleteTerm(entry.id)}
                                className="p-1.5 text-rose-500 hover:text-rose-700 cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Character Speech Memory Section */}
      <section className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">
          {t.glossary.charactersMemory}
        </h2>
        <form
          onSubmit={handleAddCharacter}
          className="grid grid-cols-1 md:grid-cols-5 gap-3 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22]"
        >
          <input
            type="text"
            required
            value={charName}
            onChange={(e) => setCharName(e.target.value)}
            placeholder={t.glossary.charName}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
          />
          <input
            type="text"
            required
            value={charTranslated}
            onChange={(e) => setCharTranslated(e.target.value)}
            placeholder={t.glossary.charTranslated}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
          />
          <input
            type="text"
            value={charStyle}
            onChange={(e) => setCharStyle(e.target.value)}
            placeholder={t.glossary.charStyle}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
          />
          <input
            type="text"
            value={charRelations}
            onChange={(e) => setCharRelations(e.target.value)}
            placeholder={t.glossary.charRelations}
            className="px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0D1117]"
          />
          <button
            type="submit"
            className="faqqa-btn-black inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-sm font-black cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t.glossary.addCharacter}</span>
          </button>
        </form>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {characters.map((ch) => (
            <div
              key={ch.id}
              className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#161B22] space-y-1"
            >
              <div className="font-bold text-slate-900 dark:text-white">
                {ch.name} → {ch.translatedName}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300">{ch.speechStyle}</div>
              {ch.relations && <div className="text-xs text-slate-400">{ch.relations}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
