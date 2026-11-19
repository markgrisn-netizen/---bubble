import type { GlossaryCategory, GlossaryEntry, GlossarySuggestion } from '../types/domain';

export const GLOBAL_GLOSSARY_PROJECT_ID = '__global__';

export function normalizeGlossaryTermKey(term: string): string {
  return (term || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isGlobalGlossaryEntry(entry: Pick<GlossaryEntry, 'scope' | 'projectId'>): boolean {
  return entry.scope === 'global' || entry.projectId === GLOBAL_GLOSSARY_PROJECT_ID;
}

export interface ResolvedGlossarySet {
  effective: GlossaryEntry[];
  globalEntries: GlossaryEntry[];
  projectEntries: GlossaryEntry[];
  overriddenGlobalIds: string[];
  overridingProjectIds: string[];
}

/**
 * Resolves the effective glossary for a given project:
 * - Includes all Global glossary entries (`scope === 'global' || projectId === '__global__'`).
 * - Includes all Project-specific entries (`projectId === projectId`).
 * - On normalized term conflict, Project entries ALWAYS override Global entries.
 */
export function resolveEffectiveGlossary(
  allEntries: GlossaryEntry[],
  projectId?: string
): ResolvedGlossarySet {
  const globalEntries = allEntries.filter((e) => isGlobalGlossaryEntry(e));
  const projectEntries = projectId
    ? allEntries.filter((e) => !isGlobalGlossaryEntry(e) && e.projectId === projectId)
    : [];

  const mergedByKey = new Map<string, GlossaryEntry>();
  const globalByKey = new Map<string, GlossaryEntry>();

  for (const entry of globalEntries) {
    const key = normalizeGlossaryTermKey(entry.originalTerm);
    if (!key) continue;
    const normalized: GlossaryEntry = { ...entry, scope: 'global' };
    mergedByKey.set(key, normalized);
    globalByKey.set(key, normalized);
  }

  const overriddenGlobalIds: string[] = [];
  const overridingProjectIds: string[] = [];

  for (const entry of projectEntries) {
    const key = normalizeGlossaryTermKey(entry.originalTerm);
    if (!key) continue;
    const existingGlobal = globalByKey.get(key);
    if (existingGlobal) {
      overriddenGlobalIds.push(existingGlobal.id);
      overridingProjectIds.push(entry.id);
    }
    mergedByKey.set(key, { ...entry, scope: 'project' });
  }

  return {
    effective: Array.from(mergedByKey.values()),
    globalEntries: globalEntries.map((e) => ({ ...e, scope: 'global' as const })),
    projectEntries: projectEntries.map((e) => ({ ...e, scope: 'project' as const })),
    overriddenGlobalIds,
    overridingProjectIds,
  };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * Unicode token-boundary-safe glossary matcher:
 * - Prevents partial substring bugs ("car" will NEVER match "cartoon" or "scar").
 * - Handles multi-word phrases with flexible internal whitespace ("Gotham   City").
 * - Handles punctuation/possessives ("Batman's", "(Batman)", "Batman!").
 * - Prioritizes longer terms first so multi-word names rank ahead of short fragments.
 */
export function findMatchingGlossaryTerms(
  text: string,
  glossary: GlossaryEntry[]
): GlossaryEntry[] {
  if (!text || !glossary.length) return [];
  const normalizedText = text.normalize('NFKC').replace(/\s+/g, ' ');
  const matches: GlossaryEntry[] = [];

  const sorted = [...glossary].sort(
    (a, b) => (b.originalTerm || '').trim().length - (a.originalTerm || '').trim().length
  );

  for (const entry of sorted) {
    const rawTerm = (entry.originalTerm || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!rawTerm) continue;

    const firstChar = rawTerm[0];
    const lastChar = rawTerm[rawTerm.length - 1];
    const escaped = escapeRegExp(rawTerm).replace(/\s+/g, '\\s+');
    const prefix = WORD_CHAR_RE.test(firstChar) ? '(?<![\\p{L}\\p{N}_])' : '';
    const suffix = WORD_CHAR_RE.test(lastChar) ? '(?![\\p{L}\\p{N}_])' : '';

    try {
      const re = new RegExp(`${prefix}${escaped}${suffix}`, 'iu');
      if (re.test(normalizedText)) {
        matches.push(entry);
      }
    } catch {
      // Safe fallback should a regex edge case ever occur
      if (normalizedText.toLowerCase().includes(rawTerm.toLowerCase())) {
        matches.push(entry);
      }
    }
  }

  return matches;
}

export interface MemorySuggestionInput {
  translationDecisions?: Array<{ original: string; translated: string; context?: string }>;
  characters?: Array<{ name: string; translatedName: string; speechStyle?: string }>;
}

/**
 * Collects recurring AI-discovered terms into `glossarySuggestions` (`pending`)
 * WITHOUT mutating the user's approved glossary (`db.glossary`) or altering completed pages.
 */
export function collectPendingGlossarySuggestions(params: {
  projectId: string;
  existingGlossary: GlossaryEntry[];
  existingSuggestions: GlossarySuggestion[];
  memoryDelta: MemorySuggestionInput;
  nowIso?: string;
}): GlossarySuggestion[] {
  const { projectId, existingGlossary, existingSuggestions, memoryDelta } = params;
  const now = params.nowIso || new Date().toISOString();
  const nextSuggestions = existingSuggestions.map((s) => ({ ...s }));

  const resolved = resolveEffectiveGlossary(existingGlossary, projectId);
  const approvedKeys = new Set(resolved.effective.map((e) => normalizeGlossaryTermKey(e.originalTerm)));

  const candidatePairs: Array<{
    originalTerm: string;
    suggestedTranslation: string;
    category: GlossaryCategory;
    notes: string;
  }> = [];

  for (const ch of memoryDelta.characters || []) {
    if (ch.name?.trim() && ch.translatedName?.trim()) {
      candidatePairs.push({
        originalTerm: ch.name.trim(),
        suggestedTranslation: ch.translatedName.trim(),
        category: 'character',
        notes: ch.speechStyle?.trim() || '',
      });
    }
  }

  for (const dec of memoryDelta.translationDecisions || []) {
    if (dec.original?.trim() && dec.translated?.trim()) {
      candidatePairs.push({
        originalTerm: dec.original.trim(),
        suggestedTranslation: dec.translated.trim(),
        category: 'term',
        notes: dec.context?.trim() || '',
      });
    }
  }

  for (const cand of candidatePairs) {
    const key = normalizeGlossaryTermKey(cand.originalTerm);
    if (!key || key.length < 2 || approvedKeys.has(key)) continue;

    const existingIdx = nextSuggestions.findIndex(
      (s) => s.projectId === projectId && normalizeGlossaryTermKey(s.originalTerm) === key
    );

    if (existingIdx >= 0) {
      const existing = nextSuggestions[existingIdx];
      if (existing.status === 'dismissed') continue;
      nextSuggestions[existingIdx] = {
        ...existing,
        occurrences: existing.occurrences + 1,
        suggestedTranslation: cand.suggestedTranslation || existing.suggestedTranslation,
        notes: cand.notes || existing.notes,
        updatedAt: now,
      };
    } else {
      nextSuggestions.push({
        id: `gs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        projectId,
        originalTerm: cand.originalTerm,
        suggestedTranslation: cand.suggestedTranslation,
        category: cand.category,
        notes: cand.notes,
        occurrences: 1,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return nextSuggestions;
}
