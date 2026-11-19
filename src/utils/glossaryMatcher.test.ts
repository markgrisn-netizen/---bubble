import test from 'node:test';
import assert from 'node:assert/strict';
import type { GlossaryEntry, GlossarySuggestion } from '../types/domain';
import {
  collectPendingGlossarySuggestions,
  findMatchingGlossaryTerms,
  GLOBAL_GLOSSARY_PROJECT_ID,
  resolveEffectiveGlossary,
} from './glossaryMatcher';

test('findMatchingGlossaryTerms enforces word boundaries and avoids substring bugs', () => {
  const entries: GlossaryEntry[] = [
    {
      id: 'g1',
      projectId: 'p1',
      scope: 'project',
      originalTerm: 'car',
      translatedTerm: 'سيارة',
      category: 'term',
      notes: '',
    },
    {
      id: 'g2',
      projectId: 'p1',
      scope: 'project',
      originalTerm: 'Gotham City',
      translatedTerm: 'مدينة غوثام',
      category: 'place',
      notes: '',
    },
    {
      id: 'g3',
      projectId: 'p1',
      scope: 'project',
      originalTerm: 'Dark Knight',
      translatedTerm: 'فارس الظلام',
      category: 'title',
      notes: '',
    },
  ];

  // "cartoon" and "scar" MUST NOT match "car"
  const falseTextMatches = findMatchingGlossaryTerms('Watch this cartoon about a scar!', entries);
  assert.equal(falseTextMatches.length, 0);

  // Whitespace-normalized + possessive/punctuation match
  const matched = findMatchingGlossaryTerms(
    "The Dark   Knight's patrol in Gotham City! Take the car.",
    entries
  );
  assert.equal(matched.length, 3);
  // Longer multi-word terms rank ahead of shorter term
  assert.equal(matched[0].id, 'g2');
  assert.equal(matched[1].id, 'g3');
  assert.equal(matched[2].id, 'g1');
});

test('resolveEffectiveGlossary merges Global terms and lets Project terms override on conflict', () => {
  const all: GlossaryEntry[] = [
    {
      id: 'glob-1',
      projectId: GLOBAL_GLOSSARY_PROJECT_ID,
      scope: 'global',
      originalTerm: 'Sensei',
      translatedTerm: 'المعلم',
      category: 'title',
      notes: '',
    },
    {
      id: 'glob-2',
      projectId: GLOBAL_GLOSSARY_PROJECT_ID,
      scope: 'global',
      originalTerm: 'Guild',
      translatedTerm: 'النقابة',
      category: 'team',
      notes: '',
    },
    {
      id: 'proj-1',
      projectId: 'proj-alpha',
      scope: 'project',
      originalTerm: '  sensei  ',
      translatedTerm: 'الأستاذ الأكبر',
      category: 'title',
      notes: 'Override for proj-alpha',
    },
    {
      id: 'other-1',
      projectId: 'proj-beta',
      scope: 'project',
      originalTerm: 'Guild',
      translatedTerm: 'العصبة',
      category: 'team',
      notes: '',
    },
  ];

  const alpha = resolveEffectiveGlossary(all, 'proj-alpha');
  assert.equal(alpha.effective.length, 2);
  const sensei = alpha.effective.find((e) => e.originalTerm.trim().toLowerCase() === 'sensei');
  const guild = alpha.effective.find((e) => e.originalTerm.trim().toLowerCase() === 'guild');
  assert.equal(sensei?.translatedTerm, 'الأستاذ الأكبر');
  assert.equal(guild?.translatedTerm, 'النقابة');
  assert.deepEqual(alpha.overriddenGlobalIds, ['glob-1']);
  assert.deepEqual(alpha.overridingProjectIds, ['proj-1']);
});

test('collectPendingGlossarySuggestions creates pending suggestions without duplicating approved or dismissed terms', () => {
  const existingGlossary: GlossaryEntry[] = [
    {
      id: 'g1',
      projectId: 'p1',
      scope: 'project',
      originalTerm: 'Bruce Wayne',
      translatedTerm: 'بروس واين',
      category: 'character',
      notes: '',
    },
  ];

  const existingSuggestions: GlossarySuggestion[] = [
    {
      id: 's-old',
      projectId: 'p1',
      originalTerm: 'Batcave',
      suggestedTranslation: 'كهف الوطواط',
      category: 'place',
      notes: '',
      occurrences: 1,
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];

  const updated = collectPendingGlossarySuggestions({
    projectId: 'p1',
    existingGlossary,
    existingSuggestions,
    memoryDelta: {
      characters: [
        { name: 'Bruce Wayne', translatedName: 'بروس واين' }, // already approved -> ignored
        { name: 'Alfred Pennyworth', translatedName: 'ألفريد بينيوورث', speechStyle: 'رسمي' },
      ],
      translationDecisions: [
        { original: 'Batcave', translated: 'كهف الخفاش' }, // increments occurrences
      ],
    },
  });

  assert.equal(updated.length, 2);
  assert.equal(updated[0].occurrences, 2);
  assert.equal(updated[0].status, 'pending');
  assert.equal(updated[1].originalTerm, 'Alfred Pennyworth');
  assert.equal(updated[1].status, 'pending');
});
