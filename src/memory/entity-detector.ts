/**
 * Entity Detector -- Auto-detect people and projects from text content.
 *
 * Port of mempalace/entity_detector.py for Oh-My-Link Phase 2.
 *
 * Two-pass approach:
 *   Pass 1: scan texts, extract entity candidates with signal counts
 *   Pass 2: score and classify each candidate as person, project, or uncertain
 *
 * No external dependencies — pure TypeScript regex patterns.
 */

import { EntityScores, DetectedEntity, DetectionResult } from '../types';

// ==================== SIGNAL PATTERNS ====================

// Person signals — things people do (20 patterns)
export const PERSON_VERB_PATTERNS: string[] = [
  '\\b{name}\\s+said\\b',
  '\\b{name}\\s+asked\\b',
  '\\b{name}\\s+told\\b',
  '\\b{name}\\s+replied\\b',
  '\\b{name}\\s+laughed\\b',
  '\\b{name}\\s+smiled\\b',
  '\\b{name}\\s+cried\\b',
  '\\b{name}\\s+felt\\b',
  '\\b{name}\\s+thinks?\\b',
  '\\b{name}\\s+wants?\\b',
  '\\b{name}\\s+loves?\\b',
  '\\b{name}\\s+hates?\\b',
  '\\b{name}\\s+knows?\\b',
  '\\b{name}\\s+decided\\b',
  '\\b{name}\\s+pushed\\b',
  '\\b{name}\\s+wrote\\b',
  '\\bhey\\s+{name}\\b',
  '\\bthanks?\\s+{name}\\b',
  '\\bhi\\s+{name}\\b',
  '\\bdear\\s+{name}\\b',
];

// Person signals — pronouns resolving nearby (9 patterns)
export const PRONOUN_PATTERNS: string[] = [
  '\\bshe\\b', '\\bher\\b', '\\bhers\\b',
  '\\bhe\\b', '\\bhim\\b', '\\bhis\\b',
  '\\bthey\\b', '\\bthem\\b', '\\btheir\\b',
];

// Person signals — dialogue markers (4 patterns)
export const DIALOGUE_PATTERNS: string[] = [
  '^>\\s*{name}[:\\s]',
  '^{name}:\\s',
  '^\\[{name}\\]',
  '"{name}\\s+said',
];

// Project signals — things projects have/do (15 patterns)
export const PROJECT_VERB_PATTERNS: string[] = [
  '\\bbuilding\\s+{name}\\b',
  '\\bbuilt\\s+{name}\\b',
  '\\bship(?:ping|ped)?\\s+{name}\\b',
  '\\blaunch(?:ing|ed)?\\s+{name}\\b',
  '\\bdeploy(?:ing|ed)?\\s+{name}\\b',
  '\\binstall(?:ing|ed)?\\s+{name}\\b',
  '\\bthe\\s+{name}\\s+architecture\\b',
  '\\bthe\\s+{name}\\s+pipeline\\b',
  '\\bthe\\s+{name}\\s+system\\b',
  '\\bthe\\s+{name}\\s+repo\\b',
  '\\b{name}\\s+v\\d+\\b',
  '\\b{name}\\.py\\b',
  '\\b{name}-core\\b',
  '\\b{name}-local\\b',
  '\\bimport\\s+{name}\\b',
];

// Words that are almost certainly NOT entities (~200 words)
// Port from entity_detector.py lines 92-396
export const ENTITY_STOPWORDS: Set<string> = new Set([
  // Core English stopwords
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
  // Demonstratives & pronouns
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'our', 'you', 'your', 'i', 'my', 'me', 'he', 'she', 'his', 'her',
  // Question words
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  // Conjunctions & adverbs
  'if', 'then', 'so', 'not', 'no', 'yes', 'ok', 'okay', 'just', 'very',
  'really', 'also', 'already', 'still', 'even', 'only', 'here', 'there',
  'now', 'too', 'up', 'out', 'about', 'like',
  // Common verbs
  'use', 'get', 'got', 'make', 'made', 'take', 'put', 'come', 'go', 'see',
  'know', 'think',
  // Boolean/null literals
  'true', 'false', 'none', 'null',
  // Adjectives & quantifiers
  'new', 'old', 'all', 'any', 'some',
  // Programming keywords
  'return', 'print', 'def', 'class', 'import', 'from',
  // Common capitalized words in prose that aren't entities
  'step', 'usage', 'run', 'check', 'find', 'add', 'set', 'list',
  'args', 'dict', 'str', 'int', 'bool', 'path', 'file', 'type', 'name',
  'note', 'example', 'option', 'result', 'error', 'warning', 'info',
  'every', 'each', 'more', 'less', 'next', 'last', 'first', 'second',
  'stack', 'layer', 'mode', 'test', 'stop', 'start', 'copy', 'move',
  'source', 'target', 'output', 'input', 'data', 'item', 'key', 'value',
  'returns', 'raises', 'yields', 'self', 'cls', 'kwargs',
  // Common sentence-starting / abstract words that aren't entities
  'world', 'well', 'want', 'topic', 'choose', 'social', 'cars', 'phones',
  'healthcare', 'ex', 'machina', 'deus', 'human', 'humans', 'people',
  'things', 'something', 'nothing', 'everything', 'anything', 'someone',
  'everyone', 'anyone', 'way', 'time', 'day', 'life', 'place', 'thing',
  'part', 'kind', 'sort', 'case', 'point', 'idea', 'fact', 'sense',
  'question', 'answer', 'reason', 'number', 'version', 'system',
  // Greetings and filler words at sentence starts
  'hey', 'hi', 'hello', 'thanks', 'thank', 'right', 'let', 'ok',
  // UI/action words that appear in how-to content
  'click', 'hit', 'press', 'tap', 'drag', 'drop', 'open', 'close', 'save',
  'load', 'launch', 'install', 'download', 'upload', 'scroll', 'select',
  'enter', 'submit', 'cancel', 'confirm', 'delete', 'paste', 'type',
  'write', 'read', 'search', 'show', 'hide',
  // Common filesystem/technical capitalized words
  'desktop', 'documents', 'downloads', 'users', 'home', 'library',
  'applications', 'preferences', 'settings', 'terminal',
  // Abstract/topic words
  'actor', 'vector', 'remote', 'control', 'duration', 'fetch',
  // Abstract concepts that appear as subjects but aren't entities
  'agents', 'tools', 'others', 'guards', 'ethics', 'regulation',
  'learning', 'thinking', 'memory', 'language', 'intelligence',
  'technology', 'society', 'culture', 'future', 'history', 'science',
  'model', 'models', 'network', 'networks', 'training', 'inference',
]);

// ==================== CANDIDATE EXTRACTION ====================

/**
 * Extract all capitalized proper noun candidates from text.
 * Returns {name: frequency} for names appearing 3+ times.
 *
 * Algorithm:
 * 1. Find all /\b([A-Z][a-z]{1,19})\b/g matches
 * 2. Filter out ENTITY_STOPWORDS, keep length > 1
 * 3. Count frequencies
 * 4. Also find multi-word proper nouns: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g
 * 5. Filter: must appear >= 3 times
 */
export function extractCandidates(text: string): Record<string, number> {
  const counts: Record<string, number> = {};

  // Find all capitalized words
  const singleRx = /\b([A-Z][a-z]{1,19})\b/g;
  let match: RegExpExecArray | null;
  while ((match = singleRx.exec(text)) !== null) {
    const word = match[1];
    if (word.length > 1 && !ENTITY_STOPWORDS.has(word.toLowerCase())) {
      counts[word] = (counts[word] || 0) + 1;
    }
  }

  // Also find multi-word proper nouns (e.g. "Memory Palace", "Claude Code")
  const multiRx = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  while ((match = multiRx.exec(text)) !== null) {
    const phrase = match[1];
    const words = phrase.split(/\s+/);
    if (!words.some(w => ENTITY_STOPWORDS.has(w.toLowerCase()))) {
      counts[phrase] = (counts[phrase] || 0) + 1;
    }
  }

  // Filter: must appear at least 3 times to be a candidate
  const result: Record<string, number> = {};
  for (const [name, count] of Object.entries(counts)) {
    if (count >= 3) {
      result[name] = count;
    }
  }
  return result;
}

// ==================== SIGNAL SCORING ====================

/** Escape special regex characters in a string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledPatterns {
  dialogue: RegExp[];
  person_verbs: RegExp[];
  project_verbs: RegExp[];
  direct: RegExp;
  versioned: RegExp;
  code_ref: RegExp;
}

/** Pre-compile all regex patterns for a single entity name. */
function buildPatterns(name: string): CompiledPatterns {
  const n = escapeRegex(name);
  return {
    dialogue: DIALOGUE_PATTERNS.map(p =>
      new RegExp(p.replace(/\{name\}/g, n), 'mi')
    ),
    person_verbs: PERSON_VERB_PATTERNS.map(p =>
      new RegExp(p.replace(/\{name\}/g, n), 'gi')
    ),
    project_verbs: PROJECT_VERB_PATTERNS.map(p =>
      new RegExp(p.replace(/\{name\}/g, n), 'gi')
    ),
    direct: new RegExp(`\\bhey\\s+${n}\\b|\\bthanks?\\s+${n}\\b|\\bhi\\s+${n}\\b`, 'gi'),
    versioned: new RegExp(`\\b${n}[-v]\\w+`, 'gi'),
    code_ref: new RegExp(`\\b${n}\\.(py|js|ts|yaml|yml|json|sh)\\b`, 'gi'),
  };
}

/**
 * Score a candidate entity as person vs project.
 * Returns scores and the signals that fired.
 *
 * Person scoring:
 *   - Dialogue markers: matches * 3 points each
 *   - Person verbs: matches * 2 points each
 *   - Pronoun proximity: for each line containing name, check 5-line window
 *     (2 before, 2 after) for pronoun patterns. Hits * 2 points.
 *   - Direct address (hey/thanks/hi {name}): matches * 4 points
 * Project scoring:
 *   - Project verbs: matches * 2 points
 *   - Versioned/hyphenated ({name}-v*, {name}-core): matches * 3 points
 *   - Code file reference ({name}.py, .js, .ts): matches * 3 points
 * Returns top 3 signals per category.
 */
export function scoreEntity(name: string, text: string, lines: string[]): EntityScores {
  const patterns = buildPatterns(name);
  let person_score = 0;
  let project_score = 0;
  const person_signals: string[] = [];
  const project_signals: string[] = [];

  // --- Person signals ---

  // Dialogue markers (strong signal)
  for (const rx of patterns.dialogue) {
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      person_score += matches * 3;
      person_signals.push(`dialogue marker (${matches}x)`);
    }
  }

  // Person verbs
  for (const rx of patterns.person_verbs) {
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      person_score += matches * 2;
      person_signals.push(`'${name} ...' action (${matches}x)`);
    }
  }

  // Pronoun proximity — pronouns within 3 lines of the name
  const nameLower = name.toLowerCase();
  const nameLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(nameLower)) {
      nameLineIndices.push(i);
    }
  }
  let pronounHits = 0;
  for (const idx of nameLineIndices) {
    const windowStart = Math.max(0, idx - 2);
    const windowEnd = Math.min(lines.length, idx + 3);
    const windowText = lines.slice(windowStart, windowEnd).join(' ').toLowerCase();
    for (const pronounPattern of PRONOUN_PATTERNS) {
      if (new RegExp(pronounPattern, 'i').test(windowText)) {
        pronounHits += 1;
        break;
      }
    }
  }
  if (pronounHits > 0) {
    person_score += pronounHits * 2;
    person_signals.push(`pronoun nearby (${pronounHits}x)`);
  }

  // Direct address
  const directMatches = (text.match(patterns.direct) || []).length;
  if (directMatches > 0) {
    person_score += directMatches * 4;
    person_signals.push(`addressed directly (${directMatches}x)`);
  }

  // --- Project signals ---

  for (const rx of patterns.project_verbs) {
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      project_score += matches * 2;
      project_signals.push(`project verb (${matches}x)`);
    }
  }

  const versionedMatches = (text.match(patterns.versioned) || []).length;
  if (versionedMatches > 0) {
    project_score += versionedMatches * 3;
    project_signals.push(`versioned/hyphenated (${versionedMatches}x)`);
  }

  const codeRefMatches = (text.match(patterns.code_ref) || []).length;
  if (codeRefMatches > 0) {
    project_score += codeRefMatches * 3;
    project_signals.push(`code file reference (${codeRefMatches}x)`);
  }

  return {
    person_score,
    project_score,
    person_signals: person_signals.slice(0, 3),
    project_signals: project_signals.slice(0, 3),
  };
}

// ==================== CLASSIFY ====================

/**
 * Given scores, classify as person / project / uncertain.
 *
 * Algorithm:
 * 1. If total score == 0: type='uncertain', confidence = min(0.4, frequency/50)
 * 2. Compute person_ratio = person_score / total
 * 3. Count signal categories from person_signals:
 *    - 'dialogue' if any signal contains 'dialogue'
 *    - 'action' if any signal contains 'action'
 *    - 'pronoun' if any signal contains 'pronoun'
 *    - 'addressed' if any signal contains 'addressed'
 * 4. has_two_signal_types = categories.size >= 2
 * 5. Classification rules (see entity_detector.py lines 562-626)
 */
export function classifyEntity(
  name: string,
  frequency: number,
  scores: EntityScores
): DetectedEntity {
  const ps = scores.person_score;
  const prs = scores.project_score;
  const total = ps + prs;

  if (total === 0) {
    // No strong signals — frequency-only candidate, uncertain
    const confidence = Math.min(0.4, frequency / 50);
    return {
      name,
      type: 'uncertain',
      confidence: Math.round(confidence * 100) / 100,
      frequency,
      signals: [`appears ${frequency}x, no strong type signals`],
    };
  }

  const personRatio = total > 0 ? ps / total : 0;

  // Require TWO different signal categories to confidently classify as a person.
  const signalCategories = new Set<string>();
  for (const s of scores.person_signals) {
    if (s.includes('dialogue')) signalCategories.add('dialogue');
    else if (s.includes('action')) signalCategories.add('action');
    else if (s.includes('pronoun')) signalCategories.add('pronoun');
    else if (s.includes('addressed')) signalCategories.add('addressed');
  }

  const hasTwoSignalTypes = signalCategories.size >= 2;

  let entityType: 'person' | 'project' | 'uncertain';
  let confidence: number;
  let signals: string[];

  if (personRatio >= 0.7 && hasTwoSignalTypes && ps >= 5) {
    entityType = 'person';
    confidence = Math.min(0.99, 0.5 + personRatio * 0.5);
    signals = scores.person_signals.length > 0 ? scores.person_signals : [`appears ${frequency}x`];
  } else if (personRatio >= 0.7 && (!hasTwoSignalTypes || ps < 5)) {
    // Pronoun-only match — downgrade to uncertain
    entityType = 'uncertain';
    confidence = 0.4;
    signals = [...scores.person_signals, `appears ${frequency}x — pronoun-only match`];
  } else if (personRatio <= 0.3) {
    entityType = 'project';
    confidence = Math.min(0.99, 0.5 + (1 - personRatio) * 0.5);
    signals = scores.project_signals.length > 0 ? scores.project_signals : [`appears ${frequency}x`];
  } else {
    entityType = 'uncertain';
    confidence = 0.5;
    signals = [...scores.person_signals, ...scores.project_signals].slice(0, 3);
    signals.push('mixed signals — needs review');
  }

  return {
    name,
    type: entityType,
    confidence: Math.round(confidence * 100) / 100,
    frequency,
    signals,
  };
}

// ==================== MAIN DETECT ====================

/**
 * Scan text content and detect entity candidates.
 *
 * @param texts - Array of text content strings to scan
 * @param maxTexts - Max texts to process (default 10, for speed)
 * @returns {people, projects, uncertain} sorted by confidence desc
 *
 * Algorithm:
 * 1. Concatenate all texts (cap each at 5000 chars)
 * 2. Split into lines for pronoun proximity scoring
 * 3. extractCandidates(combinedText)
 * 4. For each candidate: scoreEntity() -> classifyEntity()
 * 5. Sort each category by confidence desc
 * 6. Cap: people[:15], projects[:10], uncertain[:8]
 */
export function detectEntities(texts: string[], maxTexts: number = 10): DetectionResult {
  const MAX_CHARS_PER_TEXT = 5000;

  // Collect text
  const allTexts: string[] = [];
  const allLines: string[] = [];
  let textsRead = 0;

  for (const text of texts) {
    if (textsRead >= maxTexts) break;
    const content = text.slice(0, MAX_CHARS_PER_TEXT);
    allTexts.push(content);
    allLines.push(...content.split('\n'));
    textsRead++;
  }

  const combinedText = allTexts.join('\n');

  // Extract candidates
  const candidates = extractCandidates(combinedText);

  if (Object.keys(candidates).length === 0) {
    return { people: [], projects: [], uncertain: [] };
  }

  // Score and classify each candidate
  const people: DetectedEntity[] = [];
  const projects: DetectedEntity[] = [];
  const uncertain: DetectedEntity[] = [];

  // Sort by frequency descending
  const sorted = Object.entries(candidates).sort((a, b) => b[1] - a[1]);

  for (const [name, frequency] of sorted) {
    const scores = scoreEntity(name, combinedText, allLines);
    const entity = classifyEntity(name, frequency, scores);

    if (entity.type === 'person') {
      people.push(entity);
    } else if (entity.type === 'project') {
      projects.push(entity);
    } else {
      uncertain.push(entity);
    }
  }

  // Sort by confidence descending
  people.sort((a, b) => b.confidence - a.confidence);
  projects.sort((a, b) => b.confidence - a.confidence);
  uncertain.sort((a, b) => b.frequency - a.frequency);

  // Cap results to most relevant
  return {
    people: people.slice(0, 15),
    projects: projects.slice(0, 10),
    uncertain: uncertain.slice(0, 8),
  };
}
