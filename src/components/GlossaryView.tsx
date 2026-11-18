import React, { useEffect, useRef, useState } from 'react';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import type {
  CharacterMemory,
  GlossaryCategory,
  GlossaryEntry,
  LanguageCode,
  ProjectWithDetails,
} from '../types/domain';
import { tFor } from '../i18n/translations';
import { api } from '../utils/api';
import { exportGlossaryCsv, normalizeGlossaryCategory, parseGlossaryCsv } from '../utils/bubbleLayout';

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
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [characters, setCharacters] = useState<CharacterMemory[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<'all' | GlossaryCategory>('all');

  const [originalTerm, setOriginalTerm] = useState('');
  const [translatedTerm, setTranslatedTerm] = useState('');
  const [category, setCategory] = useState<GlossaryCategory>('character');
  const [notes, setNotes] = useState('');

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
    if (!pid) return;
    const [gRes, pRes] = await Promise.all([api.getGlossary(pid), api.getProject(pid)]);
    setEntries(gRes.entries);
    setCharacters(pRes.project.storyMemory.characters || []);
  };

  useEffect(() => {
    void loadData(selectedProjectId);
  }, [selectedProjectId]);

  const handleAddTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId || !originalTerm.trim() || !translatedTerm.trim()) return;
    const res = await api.addGlossaryTerm({
      projectId: selectedProjectId,
      originalTerm: originalTerm.trim(),
      translatedTerm: translatedTerm.trim(),
      category,
      notes: notes.trim(),
    });
    setEntries((prev) => [res.entry, ...prev]);
    setOriginalTerm('');
    setTranslatedTerm('');
    setNotes('');
  };

  const handleDeleteTerm = async (id: string) => {
    await api.deleteGlossaryTerm(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
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
    if (!file || !selectedProjectId) return;
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
      await api.importGlossaryTerms(selectedProjectId, parsed);
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

  return (
    <div className="max-w-6xl w-full mx-auto px-4 lg:px-8 py-6 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t.glossary.title}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t.glossary.subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            aria-label={t.glossary.selectProject}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-sm"
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
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs font-medium cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t.glossary.importCsv}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(exportGlossaryCsv(entries), 'glossary.csv', 'text/csv;charset=utf-8')
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs font-medium cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t.glossary.exportCsv}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              downloadText(
                JSON.stringify(entries, null, 2),
                'glossary.json',
                'application/json'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#161B22] text-xs font-medium cursor-pointer"
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

      {/* Specialized Comics Category Filter Bar */}
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

      {/* Glossary Table */}
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
              {entries
                .filter((e) => categoryFilter === 'all' || e.category === categoryFilter)
                .map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                    <td className="py-2.5 px-4 font-bold">{entry.originalTerm}</td>
                    <td className="py-2.5 px-4 font-extrabold text-[#EA3829] dark:text-[#FFE01B]">
                      {entry.translatedTerm}
                    </td>
                    <td className="py-2.5 px-4 text-xs text-slate-500">
                      {t.glossary.categories[entry.category] || entry.category}
                    </td>
                    <td className="py-2.5 px-4 text-xs text-slate-500">{entry.notes || '—'}</td>
                    <td className="py-2.5 px-4 text-end">
                      <button
                        type="button"
                        aria-label={`Delete ${entry.originalTerm}`}
                        onClick={() => void handleDeleteTerm(entry.id)}
                        className="p-1.5 text-rose-500 hover:text-rose-700 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

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
