/**
 * AAAK Dialect -- Compressed Symbolic Memory Language (TypeScript port)
 *
 * A structured symbolic format that ANY LLM reads natively at ~30x compression.
 * Ported from mempalace/dialect.py for Oh-My-Link Phase 1.
 *
 * FORMAT:
 *   Header:  wing|room|date|source_stem
 *   Content: 0:ENTITIES|topics|"key_quote"|EMOTIONS|FLAGS
 */

import * as path from 'path';
import { CompressedMemory } from '../types';

// === EMOTION CODES (universal) ===

export const EMOTION_CODES: Record<string, string> = {
  'vulnerability': 'vul',
  'vulnerable': 'vul',
  'joy': 'joy',
  'joyful': 'joy',
  'fear': 'fear',
  'mild_fear': 'fear',
  'trust': 'trust',
  'trust_building': 'trust',
  'grief': 'grief',
  'raw_grief': 'grief',
  'wonder': 'wonder',
  'philosophical_wonder': 'wonder',
  'rage': 'rage',
  'anger': 'rage',
  'love': 'love',
  'devotion': 'love',
  'hope': 'hope',
  'despair': 'despair',
  'hopelessness': 'despair',
  'peace': 'peace',
  'relief': 'relief',
  'humor': 'humor',
  'dark_humor': 'humor',
  'tenderness': 'tender',
  'raw_honesty': 'raw',
  'brutal_honesty': 'raw',
  'self_doubt': 'doubt',
  'anxiety': 'anx',
  'exhaustion': 'exhaust',
  'conviction': 'convict',
  'quiet_passion': 'passion',
  'warmth': 'warmth',
  'curiosity': 'curious',
  'gratitude': 'grat',
  'frustration': 'frust',
  'confusion': 'confuse',
  'satisfaction': 'satis',
  'excitement': 'excite',
  'determination': 'determ',
  'surprise': 'surprise',
};

// Keywords that signal emotions in plain text
const EMOTION_SIGNALS: Record<string, string> = {
  'decided': 'determ',
  'prefer': 'convict',
  'worried': 'anx',
  'excited': 'excite',
  'frustrated': 'frust',
  'confused': 'confuse',
  'love': 'love',
  'hate': 'rage',
  'hope': 'hope',
  'fear': 'fear',
  'trust': 'trust',
  'happy': 'joy',
  'sad': 'grief',
  'surprised': 'surprise',
  'grateful': 'grat',
  'curious': 'curious',
  'wonder': 'wonder',
  'anxious': 'anx',
  'relieved': 'relief',
  'satisf': 'satis',
  'disappoint': 'grief',
  'concern': 'anx',
};

// Keywords that signal flags
const FLAG_SIGNALS: Record<string, string> = {
  'decided': 'DECISION',
  'chose': 'DECISION',
  'switched': 'DECISION',
  'migrated': 'DECISION',
  'replaced': 'DECISION',
  'instead of': 'DECISION',
  'because': 'DECISION',
  'founded': 'ORIGIN',
  'created': 'ORIGIN',
  'started': 'ORIGIN',
  'born': 'ORIGIN',
  'launched': 'ORIGIN',
  'first time': 'ORIGIN',
  'core': 'CORE',
  'fundamental': 'CORE',
  'essential': 'CORE',
  'principle': 'CORE',
  'belief': 'CORE',
  'always': 'CORE',
  'never forget': 'CORE',
  'turning point': 'PIVOT',
  'changed everything': 'PIVOT',
  'realized': 'PIVOT',
  'breakthrough': 'PIVOT',
  'epiphany': 'PIVOT',
  'api': 'TECHNICAL',
  'database': 'TECHNICAL',
  'architecture': 'TECHNICAL',
  'deploy': 'TECHNICAL',
  'infrastructure': 'TECHNICAL',
  'algorithm': 'TECHNICAL',
  'framework': 'TECHNICAL',
  'server': 'TECHNICAL',
  'config': 'TECHNICAL',
};

// Common filler/stop words to strip from topic extraction
// Ported verbatim from dialect.py lines 155-289 (~90 words)
export const STOP_WORDS: Set<string> = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had',
  'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'about', 'between', 'through', 'during', 'before', 'after',
  'above', 'below',
  'up', 'down', 'out', 'off', 'over', 'under',
  'again', 'further', 'then', 'once',
  'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'don', 'now',
  'and', 'but', 'or', 'if', 'while',
  'that', 'this', 'these', 'those',
  'it', 'its',
  'i', 'we', 'you', 'he', 'she', 'they',
  'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their',
  'what', 'which', 'who', 'whom',
  'also', 'much', 'many', 'like',
  'because', 'since',
  'get', 'got',
  'use', 'used', 'using',
  'make', 'made',
  'thing', 'things',
  'way', 'well', 'really',
  'want', 'need',
]);

/**
 * AAAK Dialect encoder -- works on plain text.
 *
 * Usage:
 *   const dialect = new Dialect();
 *   const compressed = dialect.compress("We decided to use GraphQL instead of REST...");
 *
 *   // With entity mappings
 *   const dialect = new Dialect({ Alice: 'ALC', Bob: 'BOB' });
 */
export class Dialect {
  entityCodes: Record<string, string>;
  skipNames: string[];

  constructor(entities?: Record<string, string>, skipNames?: string[]) {
    this.entityCodes = {};
    if (entities) {
      for (const [name, code] of Object.entries(entities)) {
        this.entityCodes[name] = code;
        this.entityCodes[name.toLowerCase()] = code;
      }
    }
    this.skipNames = (skipNames || []).map(n => n.toLowerCase());
  }

  /**
   * Detect emotions from plain text using keyword signals.
   * Returns up to 3 emotion codes.
   */
  detectEmotions(text: string): string[] {
    const textLower = text.toLowerCase();
    const detected: string[] = [];
    const seen = new Set<string>();
    for (const [keyword, code] of Object.entries(EMOTION_SIGNALS)) {
      if (textLower.includes(keyword) && !seen.has(code)) {
        detected.push(code);
        seen.add(code);
      }
    }
    return detected.slice(0, 3);
  }

  /**
   * Detect importance flags from plain text using keyword signals.
   * Returns up to 3 flags.
   */
  detectFlags(text: string): string[] {
    const textLower = text.toLowerCase();
    const detected: string[] = [];
    const seen = new Set<string>();
    for (const [keyword, flag] of Object.entries(FLAG_SIGNALS)) {
      if (textLower.includes(keyword) && !seen.has(flag)) {
        detected.push(flag);
        seen.add(flag);
      }
    }
    return detected.slice(0, 3);
  }

  /**
   * Extract key topic words from plain text.
   * Boosts CamelCase, underscored, and capitalized words.
   */
  extractTopics(text: string, maxTopics: number = 3): string[] {
    // Tokenize: alphanumeric words with min 3 chars
    const words = text.match(/[a-zA-Z][a-zA-Z_-]{2,}/g) || [];

    // Count frequency, skip stop words
    const freq: Record<string, number> = {};
    for (const w of words) {
      const wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower) || wLower.length < 3) {
        continue;
      }
      freq[wLower] = (freq[wLower] || 0) + 1;
    }

    // Boost words that look like proper nouns or technical terms
    for (const w of words) {
      const wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower)) {
        continue;
      }
      // Boost capitalized words (proper nouns)
      if (w[0] >= 'A' && w[0] <= 'Z' && wLower in freq) {
        freq[wLower] += 2;
      }
      // Boost CamelCase or words with underscore/hyphen
      if (w.includes('_') || w.includes('-') || /[A-Z]/.test(w.slice(1))) {
        if (wLower in freq) {
          freq[wLower] += 2;
        }
      }
    }

    // Sort by frequency descending
    const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, maxTopics).map(([w]) => w);
  }

  /**
   * Extract the most important sentence fragment from text.
   * Truncates to 55 chars (52 + '...') if too long.
   */
  extractKeySentence(text: string): string {
    // Split into sentences
    const sentences = text.split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);

    if (sentences.length === 0) {
      return '';
    }

    // Score each sentence
    const decisionWords = new Set([
      'decided', 'because', 'instead', 'prefer', 'switched',
      'chose', 'realized', 'important', 'key', 'critical',
      'discovered', 'learned', 'conclusion', 'solution',
      'reason', 'why', 'breakthrough', 'insight',
    ]);

    const scored: Array<[number, string]> = [];
    for (const s of sentences) {
      let score = 0;
      const sLower = s.toLowerCase();
      for (const w of decisionWords) {
        if (sLower.includes(w)) {
          score += 2;
        }
      }
      // Prefer shorter, punchier sentences
      if (s.length < 80) score += 1;
      if (s.length < 40) score += 1;
      // Penalize very long sentences
      if (s.length > 150) score -= 2;
      scored.push([score, s]);
    }

    scored.sort((a, b) => b[0] - a[0]);
    let best = scored[0][1];

    // Truncate if too long
    if (best.length > 55) {
      best = best.slice(0, 52) + '...';
    }
    return best;
  }

  /**
   * Find known entities in text, or detect capitalized names as fallback.
   * Returns up to 3 entity codes.
   */
  detectEntitiesInText(text: string): string[] {
    const found: string[] = [];

    // Check known entities first
    for (const [name, code] of Object.entries(this.entityCodes)) {
      if (name !== name.toLowerCase() && text.toLowerCase().includes(name.toLowerCase())) {
        if (!found.includes(code)) {
          found.push(code);
        }
      }
    }
    if (found.length > 0) {
      return found;
    }

    // Fallback: find mid-sentence capitalized words that look like names
    const words = text.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const clean = words[i].replace(/[^a-zA-Z]/g, '');
      if (
        clean.length >= 2 &&
        clean[0] >= 'A' && clean[0] <= 'Z' &&
        clean.slice(1) === clean.slice(1).toLowerCase() &&
        !STOP_WORDS.has(clean.toLowerCase())
      ) {
        const code = clean.slice(0, 3).toUpperCase();
        if (!found.includes(code)) {
          found.push(code);
        }
        if (found.length >= 3) {
          break;
        }
      }
    }
    return found;
  }

  /**
   * Compress plain text into AAAK Dialect format.
   *
   * This is the primary method: takes any text content and returns
   * a compressed symbolic representation (~30x smaller than input).
   */
  compress(text: string, metadata?: Record<string, string>): string {
    const meta = metadata || {};

    // Detect components
    const entities = this.detectEntitiesInText(text);
    const entityStr = entities.slice(0, 3).join('+') || '???';

    const topics = this.extractTopics(text);
    const topicStr = topics.slice(0, 3).join('_') || 'misc';

    const quote = this.extractKeySentence(text);
    const quotePart = quote ? `"${quote}"` : '';

    const emotions = this.detectEmotions(text);
    const emotionStr = emotions.join('+');

    const flags = this.detectFlags(text);
    const flagStr = flags.join('+');

    // Build source header if metadata available
    const source = meta.source_file || '';
    const wing = meta.wing || '';
    const room = meta.room || '';
    const date = meta.date || '';

    const lines: string[] = [];

    // Header line (if we have metadata)
    if (source || wing) {
      const headerParts = [
        wing || '?',
        room || '?',
        date || '?',
        source ? path.basename(source, path.extname(source)) : '?',
      ];
      lines.push(headerParts.join('|'));
    }

    // Content line
    const parts = [`0:${entityStr}`, topicStr];
    if (quotePart) parts.push(quotePart);
    if (emotionStr) parts.push(emotionStr);
    if (flagStr) parts.push(flagStr);

    lines.push(parts.join('|'));

    return lines.join('\n');
  }

  /**
   * Parse an AAAK Dialect string back into a readable summary.
   */
  decode(dialectText: string): {
    header: Record<string, string>;
    arc: string;
    zettels: string[];
    tunnels: string[];
  } {
    const lines = dialectText.trim().split('\n');
    const result: {
      header: Record<string, string>;
      arc: string;
      zettels: string[];
      tunnels: string[];
    } = { header: {}, arc: '', zettels: [], tunnels: [] };

    for (const line of lines) {
      if (line.startsWith('ARC:')) {
        result.arc = line.slice(4);
      } else if (line.startsWith('T:')) {
        result.tunnels.push(line);
      } else if (line.includes('|') && line.split('|')[0].includes(':')) {
        result.zettels.push(line);
      } else if (line.includes('|')) {
        const parts = line.split('|');
        result.header = {
          file: parts[0] || '',
          entities: parts[1] || '',
          date: parts[2] || '',
          title: parts[3] || '',
        };
      }
    }

    return result;
  }

  /**
   * Rough token count (1 token ~ 3 chars for structured text).
   */
  static countTokens(text: string): number {
    return Math.floor(text.length / 3);
  }

  /**
   * Get compression statistics for a text -> AAAK conversion.
   */
  compressionStats(originalText: string, compressed: string): CompressedMemory {
    const origTokens = Dialect.countTokens(originalText);
    const compTokens = Dialect.countTokens(compressed);
    return {
      aaak: compressed,
      originalChars: originalText.length,
      compressedChars: compressed.length,
      ratio: origTokens / Math.max(compTokens, 1),
    };
  }
}
