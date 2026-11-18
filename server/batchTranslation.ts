import type { Page, StoryMemory, TranslationDecisionMemory } from '../src/types/domain.ts';

export interface StoryMemoryDeltaInput {
  characters?: Array<{
    name: string;
    translatedName: string;
    speechStyle?: string;
    relations?: string;
  }>;
  locations?: string[];
  loreTerms?: string[];
  relationships?: string[];
  keyFacts?: string[];
  translationDecisions?: TranslationDecisionMemory[];
  summaryAddition?: string;
}

/**
 * Splits a flat ordered array of page IDs into sequential batches of size `batchSize` (default 2).
 * Example: [p1, p2, p3, p4, p5] => [[p1, p2], [p3, p4], [p5]]
 */
export function partitionPagesIntoBatches<T>(items: T[], batchSize = 2): T[][] {
  const safeSize = Math.max(1, Math.floor(batchSize) || 2);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    batches.push(items.slice(i, i + safeSize));
  }
  return batches;
}

/**
 * Determines if a page is already completely translated so resume jobs can skip it unless forced.
 */
export function isPageCompletedTranslation(page: Page): boolean {
  return (
    page.status === 'completed' &&
    page.regions.length > 0 &&
    page.regions.every((r) => Boolean(r.translatedText && r.translatedText.trim()))
  );
}

/**
 * Computes per-page initial states ('queued' | 'skipped') for a new batch translation job.
 * Supports:
 * - Resuming partial chapters without duplicating completed pages (unless forceRetranslate is true)
 * - Retrying only failed pages (retryOnlyFailed)
 * - Selecting an explicit subset of pages / 2-page batch (selectedPageIds)
 */
export function selectBatchJobPageStates(
  pages: Page[],
  options?: {
    retryOnlyFailed?: boolean;
    selectedPageIds?: string[];
    forceRetranslate?: boolean;
  }
): {
  pageStates: Record<string, 'queued' | 'skipped'>;
  queuedPageIds: string[];
} {
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const selectedSet =
    options?.selectedPageIds && options.selectedPageIds.length > 0
      ? new Set(options.selectedPageIds)
      : null;

  const pageStates: Record<string, 'queued' | 'skipped'> = {};
  const queuedPageIds: string[] = [];

  for (const page of sorted) {
    if (selectedSet && !selectedSet.has(page.id)) {
      pageStates[page.id] = 'skipped';
      continue;
    }

    if (options?.retryOnlyFailed) {
      if (page.status === 'error') {
        pageStates[page.id] = 'queued';
        queuedPageIds.push(page.id);
      } else {
        pageStates[page.id] = 'skipped';
      }
      continue;
    }

    if (!options?.forceRetranslate && isPageCompletedTranslation(page)) {
      pageStates[page.id] = 'skipped';
    } else {
      pageStates[page.id] = 'queued';
      queuedPageIds.push(page.id);
    }
  }

  return { pageStates, queuedPageIds };
}

/**
 * Ensures all StoryMemory structured arrays exist safely even on older saved projects.
 */
export function normalizeStoryMemory(memory?: Partial<StoryMemory>): StoryMemory {
  return {
    characters: Array.isArray(memory?.characters) ? [...memory.characters] : [],
    locations: Array.isArray(memory?.locations) ? [...memory.locations] : [],
    loreTerms: Array.isArray(memory?.loreTerms) ? [...memory.loreTerms] : [],
    relationships: Array.isArray(memory?.relationships) ? [...memory.relationships] : [],
    keyFacts: Array.isArray(memory?.keyFacts) ? [...memory.keyFacts] : [],
    translationDecisions: Array.isArray(memory?.translationDecisions)
      ? [...memory.translationDecisions]
      : [],
    recurringNotes: typeof memory?.recurringNotes === 'string' ? memory.recurringNotes : '',
    chapterSummaries: Array.isArray(memory?.chapterSummaries) ? [...memory.chapterSummaries] : [],
  };
}

function mergeUniqueStrings(existing: string[], incoming: string[] | undefined, maxCount = 60): string[] {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out = [...existing];
  for (const raw of incoming || []) {
    const clean = (raw || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.length > maxCount ? out.slice(out.length - maxCount) : out;
}

/**
 * Persistently updates Story Memory after each 2-page batch completes.
 * Deduplicates characters, locations, lore terms, relationships, key facts, and translation decisions
 * so long graphic novels stay consistent without unbounded prompt bloat.
 */
export function mergeStoryMemoryUpdate(
  existingMemory: Partial<StoryMemory> | undefined,
  delta: StoryMemoryDeltaInput | undefined,
  batchSummaries: string[] = []
): StoryMemory {
  const next = normalizeStoryMemory(existingMemory);

  if (delta?.characters?.length) {
    for (const ch of delta.characters) {
      const cleanName = (ch.name || '').trim();
      const cleanTranslated = (ch.translatedName || '').trim();
      if (!cleanName) continue;
      const existingChar = next.characters.find(
        (c) => c.name.trim().toLowerCase() === cleanName.toLowerCase()
      );
      if (existingChar) {
        if (cleanTranslated && !existingChar.translatedName) {
          existingChar.translatedName = cleanTranslated;
        }
        if (ch.speechStyle?.trim() && !existingChar.speechStyle.includes(ch.speechStyle.trim())) {
          existingChar.speechStyle = existingChar.speechStyle
            ? `${existingChar.speechStyle}; ${ch.speechStyle.trim()}`
            : ch.speechStyle.trim();
        }
        if (ch.relations?.trim() && !existingChar.relations.includes(ch.relations.trim())) {
          existingChar.relations = existingChar.relations
            ? `${existingChar.relations}; ${ch.relations.trim()}`
            : ch.relations.trim();
        }
      } else {
        next.characters.push({
          id: `char-mem-${next.characters.length + 1}`,
          name: cleanName,
          translatedName: cleanTranslated || cleanName,
          speechStyle: ch.speechStyle?.trim() || '',
          relations: ch.relations?.trim() || '',
        });
      }
    }
  }

  next.locations = mergeUniqueStrings(next.locations, delta?.locations, 50);
  next.loreTerms = mergeUniqueStrings(next.loreTerms || [], delta?.loreTerms, 80);
  next.relationships = mergeUniqueStrings(next.relationships || [], delta?.relationships, 50);
  next.keyFacts = mergeUniqueStrings(next.keyFacts || [], delta?.keyFacts, 60);

  if (delta?.translationDecisions?.length) {
    const decisions = [...(next.translationDecisions || [])];
    const indexByOriginal = new Map(
      decisions.map((d, idx) => [d.original.trim().toLowerCase(), idx])
    );
    for (const dec of delta.translationDecisions) {
      const orig = (dec.original || '').trim();
      const tr = (dec.translated || '').trim();
      if (!orig || !tr) continue;
      const key = orig.toLowerCase();
      const existingIdx = indexByOriginal.get(key);
      if (existingIdx !== undefined) {
        decisions[existingIdx] = {
          original: orig,
          translated: tr,
          context: dec.context?.trim() || decisions[existingIdx].context,
        };
      } else {
        indexByOriginal.set(key, decisions.length);
        decisions.push({
          original: orig,
          translated: tr,
          context: dec.context?.trim(),
        });
      }
    }
    next.translationDecisions = decisions.slice(-80);
  }

  const summaryCandidates = [
    ...(delta?.summaryAddition ? [delta.summaryAddition] : []),
    ...batchSummaries,
  ];
  next.chapterSummaries = mergeUniqueStrings(next.chapterSummaries, summaryCandidates, 30);

  return next;
}

/**
 * Formats Story Memory cleanly into a concise text block suitable for AI system prompts
 * without passing past page images.
 */
export function formatConciseStoryMemoryForPrompt(memory: Partial<StoryMemory> | undefined): string {
  const m = normalizeStoryMemory(memory);
  const lines: string[] = [];
  if (m.characters.length) {
    lines.push(
      `Characters: ${m.characters
        .slice(0, 25)
        .map((c) => `${c.name}=>${c.translatedName}${c.speechStyle ? ` (${c.speechStyle})` : ''}`)
        .join('; ')}`
    );
  }
  if (m.locations.length) lines.push(`Locations: ${m.locations.slice(-20).join(', ')}`);
  if (m.loreTerms?.length) lines.push(`Lore Terms: ${m.loreTerms.slice(-25).join(', ')}`);
  if (m.relationships?.length) lines.push(`Relationships: ${m.relationships.slice(-15).join(' | ')}`);
  if (m.keyFacts?.length) lines.push(`Key Facts: ${m.keyFacts.slice(-12).join(' | ')}`);
  if (m.translationDecisions?.length) {
    lines.push(
      `Decisions: ${m.translationDecisions
        .slice(-20)
        .map((d) => `"${d.original}"=>"${d.translated}"`)
        .join(', ')}`
    );
  }
  if (m.chapterSummaries.length) {
    lines.push(`Recent Story Summary: ${m.chapterSummaries.slice(-5).join(' | ')}`);
  }
  return lines.join('\n') || 'No established story memory yet.';
}
