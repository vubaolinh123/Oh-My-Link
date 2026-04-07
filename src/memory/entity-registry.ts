/**
 * Entity Registry -- Persistent personal entity registry for Oh-My-Link.
 *
 * Port of mempalace/entity_registry.py for Oh-My-Link Phase 2.
 *
 * Knows the difference between Riley (a person) and ever (an adverb).
 * Built from three sources, in priority order:
 *   1. Onboarding — what the user explicitly told us
 *   2. Learned — what we inferred from session history with high confidence
 *   3. Wiki cache — what we looked up via Wikipedia for unknown words
 *
 * Storage: {cwd}/.oh-my-link/entity-registry.json
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  RegisteredPerson,
  EntityRegistryData,
  WikiCacheEntry,
  EntityLookupResult,
  DetectedEntity,
} from '../types';
import { extractCandidates, scoreEntity, classifyEntity } from './entity-detector';

// ─────────────────────────────────────────────────────────────────────────────
// Common English words that could be confused with names
// These get flagged as AMBIGUOUS and require context disambiguation
// Port from entity_registry.py lines 32-89
// ─────────────────────────────────────────────────────────────────────────────

export const AMBIGUOUS_WORDS: Set<string> = new Set([
  // Words that are also common personal names
  'ever', 'grace', 'will', 'bill', 'mark', 'april', 'may', 'june',
  'joy', 'hope', 'faith', 'chance', 'chase', 'hunter', 'dash', 'flash',
  'star', 'sky', 'river', 'brook', 'lane', 'art', 'clay', 'gil', 'nat',
  'max', 'rex', 'ray', 'jay', 'rose', 'violet', 'lily', 'ivy', 'ash',
  'reed', 'sage',
  // Days and months that look like names at sentence start
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

// Context patterns that indicate a word is being used as a PERSON name
// Port from entity_registry.py lines 92-113
export const PERSON_CONTEXT_PATTERNS: string[] = [
  '\\b{name}\\s+said\\b',
  '\\b{name}\\s+told\\b',
  '\\b{name}\\s+asked\\b',
  '\\b{name}\\s+laughed\\b',
  '\\b{name}\\s+smiled\\b',
  '\\b{name}\\s+was\\b',
  '\\b{name}\\s+is\\b',
  '\\b{name}\\s+called\\b',
  '\\b{name}\\s+texted\\b',
  '\\bwith\\s+{name}\\b',
  '\\bsaw\\s+{name}\\b',
  '\\bcalled\\s+{name}\\b',
  '\\btook\\s+{name}\\b',
  '\\bpicked\\s+up\\s+{name}\\b',
  '\\bdrop(?:ped)?\\s+(?:off\\s+)?{name}\\b',
  '\\b{name}(?:\'s|s\')\\b',
  '\\bhey\\s+{name}\\b',
  '\\bthanks?\\s+{name}\\b',
  '^{name}[:\\s]',
  '\\bmy\\s+(?:son|daughter|kid|child|brother|sister|friend|partner|colleague|coworker)\\s+{name}\\b',
];

// Context patterns that indicate a word is NOT being used as a name
// Port from entity_registry.py lines 116-127
export const CONCEPT_CONTEXT_PATTERNS: string[] = [
  '\\bhave\\s+you\\s+{name}\\b',
  '\\bif\\s+you\\s+{name}\\b',
  '\\b{name}\\s+since\\b',
  '\\b{name}\\s+again\\b',
  '\\bnot\\s+{name}\\b',
  '\\b{name}\\s+more\\b',
  '\\bwould\\s+{name}\\b',
  '\\bcould\\s+{name}\\b',
  '\\bwill\\s+{name}\\b',
  '(?:the\\s+)?{name}\\s+(?:of|in|at|for|to)\\b',
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper: escape special regex characters
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity Registry
// ─────────────────────────────────────────────────────────────────────────────

export class EntityRegistry {
  private data: EntityRegistryData;
  private filePath: string;

  constructor(data: EntityRegistryData, filePath: string) {
    this.data = data;
    this.filePath = filePath;
  }

  // ── Load / Save ──────────────────────────────────────────────────────────

  /**
   * Load registry from disk. Returns empty registry if file missing/corrupted.
   * @param registryPath - Full path to entity-registry.json
   */
  static load(registryPath: string): EntityRegistry {
    if (fs.existsSync(registryPath)) {
      try {
        const raw = fs.readFileSync(registryPath, 'utf-8');
        const data = JSON.parse(raw) as EntityRegistryData;
        return new EntityRegistry(data, registryPath);
      } catch {
        // corrupted file — start fresh
      }
    }
    return new EntityRegistry(EntityRegistry.empty(), registryPath);
  }

  /**
   * Create an empty registry data structure.
   */
  static empty(): EntityRegistryData {
    return {
      version: 1,
      mode: 'personal',
      people: {},
      projects: [],
      ambiguous_flags: [],
      wiki_cache: {},
    };
  }

  /**
   * Save current state to disk (atomic write).
   */
  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  // ── Properties ───────────────────────────────────────────────────────────

  get mode(): string {
    return this.data.mode || 'personal';
  }

  get people(): Record<string, RegisteredPerson> {
    return this.data.people || {};
  }

  get projects(): string[] {
    return this.data.projects || [];
  }

  get ambiguousFlags(): string[] {
    return this.data.ambiguous_flags || [];
  }

  // ── Core Methods ─────────────────────────────────────────────────────────

  /**
   * Add a person to the registry.
   * Also auto-flags as ambiguous if name.toLowerCase() is in AMBIGUOUS_WORDS.
   */
  addPerson(name: string, info: Partial<RegisteredPerson>): void {
    this.data.people[name] = {
      source: info.source || 'learned',
      contexts: info.contexts || ['personal'],
      aliases: info.aliases || [],
      relationship: info.relationship || '',
      confidence: info.confidence ?? 1.0,
      ...(info.canonical ? { canonical: info.canonical } : {}),
      ...(info.seen_count !== undefined ? { seen_count: info.seen_count } : {}),
    };

    // Auto-flag as ambiguous if needed
    if (AMBIGUOUS_WORDS.has(name.toLowerCase())) {
      if (!this.data.ambiguous_flags.includes(name.toLowerCase())) {
        this.data.ambiguous_flags.push(name.toLowerCase());
      }
    }
  }

  /**
   * Add a project to the registry.
   * Deduplicates by case-insensitive comparison.
   */
  addProject(name: string): void {
    const exists = this.data.projects.some(
      p => p.toLowerCase() === name.toLowerCase()
    );
    if (!exists) {
      this.data.projects.push(name);
    }
  }

  /**
   * Look up a word in the registry.
   *
   * Priority: 1) exact people match, 2) project match, 3) wiki cache, 4) unknown
   * For ambiguous words, applies disambiguation using context patterns.
   */
  lookup(word: string, context?: string): EntityLookupResult {
    // 1. Exact match in people registry
    for (const [canonical, info] of Object.entries(this.people)) {
      const aliases = info.aliases || [];
      if (
        word.toLowerCase() === canonical.toLowerCase() ||
        aliases.some(a => a.toLowerCase() === word.toLowerCase())
      ) {
        // Check if this is an ambiguous word
        if (this.data.ambiguous_flags.includes(word.toLowerCase()) && context) {
          const resolved = this.disambiguate(word, context, info);
          if (resolved !== null) {
            return resolved;
          }
        }
        return {
          type: 'person',
          confidence: info.confidence,
          source: info.source,
          name: canonical,
          context: info.contexts || ['personal'],
          needs_disambiguation: false,
        };
      }
    }

    // 2. Project match
    for (const proj of this.projects) {
      if (word.toLowerCase() === proj.toLowerCase()) {
        return {
          type: 'project',
          confidence: 1.0,
          source: 'onboarding',
          name: proj,
          needs_disambiguation: false,
        };
      }
    }

    // 3. Wiki cache
    const cache = this.data.wiki_cache || {};
    for (const [cachedWord, cachedResult] of Object.entries(cache)) {
      if (word.toLowerCase() === cachedWord.toLowerCase() && cachedResult.confirmed) {
        return {
          type: cachedResult.inferred_type === 'person' ? 'person' : 'concept',
          confidence: cachedResult.confidence,
          source: 'wiki',
          name: word,
          needs_disambiguation: false,
        };
      }
    }

    // 4. Unknown
    return {
      type: 'unknown',
      confidence: 0.0,
      source: 'none',
      name: word,
      needs_disambiguation: false,
    };
  }

  /**
   * Disambiguate an ambiguous word using context patterns.
   * Returns person result if context suggests a name, concept if not,
   * or null if truly ambiguous (fall through to default person match).
   */
  private disambiguate(
    word: string,
    context: string,
    personInfo: RegisteredPerson
  ): EntityLookupResult | null {
    const nameLower = word.toLowerCase();
    const ctxLower = context.toLowerCase();
    const escaped = escapeRegex(nameLower);

    // Check person context patterns
    let personScore = 0;
    for (const pat of PERSON_CONTEXT_PATTERNS) {
      const rx = new RegExp(pat.replace(/\{name\}/g, escaped), 'i');
      if (rx.test(ctxLower)) {
        personScore += 1;
      }
    }

    // Check concept context patterns
    let conceptScore = 0;
    for (const pat of CONCEPT_CONTEXT_PATTERNS) {
      const rx = new RegExp(pat.replace(/\{name\}/g, escaped), 'i');
      if (rx.test(ctxLower)) {
        conceptScore += 1;
      }
    }

    if (personScore > conceptScore) {
      return {
        type: 'person',
        confidence: Math.min(0.95, 0.7 + personScore * 0.1),
        source: personInfo.source,
        name: word,
        context: personInfo.contexts || ['personal'],
        needs_disambiguation: false,
        disambiguated_by: 'context_patterns',
      };
    } else if (conceptScore > personScore) {
      return {
        type: 'concept',
        confidence: Math.min(0.90, 0.7 + conceptScore * 0.1),
        source: 'context_disambiguated',
        name: word,
        needs_disambiguation: false,
        disambiguated_by: 'context_patterns',
      };
    }

    // Truly ambiguous — return null to fall through to person (registered name)
    return null;
  }

  /**
   * Extract known person names from a query string.
   * Used by vector-store search to boost entity-relevant results.
   */
  extractPeopleFromQuery(query: string): string[] {
    const found: string[] = [];

    for (const [canonical, info] of Object.entries(this.people)) {
      const namesToCheck = [canonical, ...(info.aliases || [])];
      for (const name of namesToCheck) {
        const rx = new RegExp(`\\b${escapeRegex(name)}\\b`, 'i');
        if (rx.test(query)) {
          // For ambiguous words, check context
          if (this.data.ambiguous_flags.includes(name.toLowerCase())) {
            const result = this.disambiguate(name, query, info);
            if (result && result.type === 'person') {
              if (!found.includes(canonical)) {
                found.push(canonical);
              }
            }
          } else {
            if (!found.includes(canonical)) {
              found.push(canonical);
            }
          }
        }
      }
    }
    return found;
  }

  /**
   * Find capitalized words in query that are NOT in registry or common words.
   * These are candidates for learning.
   */
  extractUnknownCandidates(query: string): string[] {
    const candidates = query.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
    const unknown: string[] = [];
    const seen = new Set<string>();

    for (const word of candidates) {
      if (seen.has(word)) continue;
      seen.add(word);

      if (AMBIGUOUS_WORDS.has(word.toLowerCase())) continue;
      const result = this.lookup(word);
      if (result.type === 'unknown') {
        unknown.push(word);
      }
    }
    return unknown;
  }

  /**
   * Scan session text for new entity candidates.
   * Uses entity-detector extractCandidates/scoreEntity/classifyEntity.
   *
   * @returns Array of newly discovered DetectedEntity objects
   */
  learnFromText(text: string, minConfidence: number = 0.75): DetectedEntity[] {
    const lines = text.split('\n');
    const candidates = extractCandidates(text);
    const newCandidates: DetectedEntity[] = [];

    for (const [name, frequency] of Object.entries(candidates)) {
      // Skip if already known
      if (this.people[name] || this.projects.includes(name)) {
        continue;
      }

      const scores = scoreEntity(name, text, lines);
      const entity = classifyEntity(name, frequency, scores);

      if (entity.type === 'person' && entity.confidence >= minConfidence) {
        this.data.people[name] = {
          source: 'learned',
          contexts: [this.mode !== 'combo' ? this.mode : 'personal'],
          aliases: [],
          relationship: '',
          confidence: entity.confidence,
          seen_count: frequency,
        };
        if (AMBIGUOUS_WORDS.has(name.toLowerCase())) {
          if (!this.data.ambiguous_flags.includes(name.toLowerCase())) {
            this.data.ambiguous_flags.push(name.toLowerCase());
          }
        }
        newCandidates.push(entity);
      }
    }

    if (newCandidates.length > 0) {
      this.save();
    }

    return newCandidates;
  }

  /**
   * Generate entity code map for AAAK Dialect constructor.
   * Returns {displayName: 3-char-code} for all known people.
   *
   * Code generation: first 3 chars of name, uppercased.
   * Handles collisions by appending a digit.
   */
  toDialectEntities(): Record<string, string> {
    const result: Record<string, string> = {};
    const usedCodes = new Set<string>();

    for (const name of Object.keys(this.people)) {
      let code = name.slice(0, 3).toUpperCase();

      if (usedCodes.has(code)) {
        // Handle collision by appending a digit
        let i = 1;
        while (usedCodes.has(code + i)) {
          i++;
        }
        code = code.slice(0, 2) + String(i);
      }

      usedCodes.add(code);
      result[name] = code;
    }

    return result;
  }

  /**
   * Human-readable summary of the registry state.
   */
  summary(): string {
    const peopleNames = Object.keys(this.people);
    const lines = [
      `Mode: ${this.mode}`,
      `People: ${peopleNames.length} (${peopleNames.slice(0, 8).join(', ')}${peopleNames.length > 8 ? '...' : ''})`,
      `Projects: ${this.projects.join(', ') || '(none)'}`,
      `Ambiguous flags: ${this.ambiguousFlags.join(', ') || '(none)'}`,
      `Wiki cache: ${Object.keys(this.data.wiki_cache || {}).length} entries`,
    ];
    return lines.join('\n');
  }
}
