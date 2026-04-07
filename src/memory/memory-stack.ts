/**
 * memory-stack.ts — Layered Memory Stack (L0 + L1)
 *
 * Port of MemPalace layers.py (L0 + L1 only for Phase 1).
 *
 * L0: Identity       — Always loaded. Reads from .oh-my-link/identity.md
 * L1: Essential Story — Always loaded. Top drawers from the vector index.
 *
 * Exports:
 *   DEFAULT_MEMORY_CONFIG — configuration constants
 *   wakeUp(cwd, taskHint?) — produce L0 + L1 context for session start
 *   consolidateSession(cwd) — consolidate working-memory into vector index
 */

import * as fs from 'fs';
import { MemoryConfig } from '../types';
import {
  getIdentityPath,
  getWorkingMemoryPath,
} from '../state';
import { getAllDocuments, searchDocuments } from './vector-store';

// ── Constants (from config.py and layers.py) ─────────────────────────

/** Default memory configuration — maps to MemPalace config.py defaults */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxL1Drawers: 15,     // layers.py line 83: MAX_DRAWERS = 15
  maxL1Chars: 3200,     // layers.py line 84: MAX_CHARS = 3200
  minConfidence: 0.3,   // general_extractor.py line 363
  topicWings: [          // config.py lines 14-22
    'emotions', 'consciousness', 'memory', 'technical',
    'identity', 'family', 'creative',
  ],
  hallKeywords: {        // config.py lines 24-61 (adapted for OML context)
    technical: ['code', 'python', 'typescript', 'script', 'bug', 'error',
                'function', 'api', 'database', 'server', 'hook', 'plugin'],
    decisions: ['decided', 'chose', 'architecture', 'approach', 'instead',
                'because', 'switched', 'migrated', 'framework'],
    problems:  ['bug', 'error', 'crash', 'fail', 'broken', 'issue',
                'problem', 'fix', 'workaround', 'root cause'],
    milestones: ['shipped', 'launched', 'deployed', 'released', 'works',
                 'solved', 'breakthrough', 'finally', 'implemented'],
    preferences: ['prefer', 'always', 'never', 'convention', 'style',
                  'rule', 'hate', 'like'],
  },
};

// ── Exported Functions ───────────────────────────────────────────────

/**
 * Wake-up: produce L0 + L1 context for session start.
 * Returns null if both layers are empty (triggers fallback to legacy injection).
 * Port of MemoryStack.wake_up() from layers.py lines 380-399.
 */
export function wakeUp(cwd: string, taskHint?: string): string | null {
  const parts: string[] = [];
  let hasContent = false;

  // --- L0: Identity ---
  // Port of Layer0.render() from layers.py lines 52-65
  const identityPath = getIdentityPath(cwd);
  let l0Text = '';
  if (fs.existsSync(identityPath)) {
    try {
      l0Text = fs.readFileSync(identityPath, 'utf-8').trim();
    } catch { /* ignore */ }
  }
  if (l0Text) {
    parts.push('## Identity');
    parts.push(l0Text);
    parts.push('');
    hasContent = true;
  }

  // --- L1: Essential Story ---
  // Port of Layer1.generate() from layers.py lines 91-168
  // Instead of ChromaDB, uses vector-store.ts getAllDocuments()
  try {
    const allDocs = getAllDocuments(cwd);
    if (allDocs.length > 0) {
      // Score each: prefer high importance (from metadata), recent entries
      // layers.py lines 117-128: tries importance, emotional_weight, weight keys
      const scored = allDocs.map(doc => ({
        doc,
        importance: doc.metadata.importance ?? 3,
      }));

      // Sort by importance descending (layers.py line 131)
      scored.sort((a, b) => b.importance - a.importance);

      // Task-aware retrieval: merge BM25 results when taskHint is provided
      // This ensures agents working on specific tasks get relevant memories,
      // not just the globally highest-importance ones.
      if (taskHint && taskHint.trim().length > 0) {
        try {
          const bm25Results = searchDocuments(cwd, taskHint, 5);
          const existingIds = new Set(scored.map(s => s.doc.id));
          for (const result of bm25Results) {
            if (!existingIds.has(result.document.id)) {
              // Insert BM25 hits at high priority (importance boosted to ensure inclusion)
              scored.splice(
                Math.min(5, scored.length), // Insert after top-5 importance entries
                0,
                { doc: result.document, importance: result.document.metadata.importance ?? 3 }
              );
              existingIds.add(result.document.id);
            }
          }
        } catch { /* best effort — BM25 search failure should not block wakeUp */ }
      }

      // Take top N (layers.py line 132: MAX_DRAWERS)
      const config = DEFAULT_MEMORY_CONFIG;
      const top = scored.slice(0, config.maxL1Drawers);

      // Group by room for readability (layers.py lines 135-138)
      const byRoom: Record<string, typeof top> = {};
      for (const entry of top) {
        const room = entry.doc.metadata.room || 'general';
        (byRoom[room] ??= []).push(entry);
      }

      // Build compact text (layers.py lines 141-168)
      const l1Lines: string[] = ['## Memories'];
      let totalLen = 0;

      for (const [room, entries] of Object.entries(byRoom).sort()) {
        const roomLine = `\n[${room}]`;
        l1Lines.push(roomLine);
        totalLen += roomLine.length;

        for (const { doc } of entries) {
          // Truncate snippet (layers.py lines 153-155)
          let snippet = doc.text.trim().replace(/\n/g, ' ');
          if (snippet.length > 200) snippet = snippet.slice(0, 197) + '...';
          const entryLine = `  - ${snippet}`;

          // Enforce MAX_CHARS budget (layers.py lines 161-163)
          if (totalLen + entryLine.length > config.maxL1Chars) {
            l1Lines.push('  ... (more available via memory search)');
            break;
          }

          l1Lines.push(entryLine);
          totalLen += entryLine.length;
        }
      }

      parts.push(l1Lines.join('\n'));
      hasContent = true;
    }
  } catch { /* best effort — if vector store fails, skip L1 */ }

  // If both L0 and L1 are empty, return null (triggers fallback)
  // CONTEXT.md Risk 5 mitigation: graceful empty state
  if (!hasContent) return null;

  return parts.join('\n');
}

/**
 * Consolidate working-memory.md into vector index at session end.
 * Reads working-memory.md, extracts memories, AAAK-compresses, stores, then clears the file.
 */
export function consolidateSession(cwd: string): void {
  // Read working-memory.md
  const wmPath = getWorkingMemoryPath(cwd);
  if (!fs.existsSync(wmPath)) return;

  let content: string;
  try {
    content = fs.readFileSync(wmPath, 'utf-8').trim();
  } catch { return; }
  if (!content) return;

  // Extract memories from the accumulated working memory
  // Dynamic import to avoid startup cost (only runs at session end)
  try {
    const { extractMemories } = require('./memory-extractor');
    const { Dialect } = require('./aaak-dialect');
    const { addDocument } = require('./vector-store');

    const memories = extractMemories(content, 0.3);

    // Load entity registry for entity-aware compression (best effort)
    let entityMap: Record<string, string> = {};
    try {
      const { EntityRegistry } = require('./entity-registry');
      const { getEntityRegistryPath } = require('../state');
      const registry = EntityRegistry.load(getEntityRegistryPath(cwd));
      entityMap = registry.toDialectEntities();
    } catch { /* best effort — proceed without entity codes */ }
    const dialect = new Dialect(entityMap);

    for (const mem of memories) {
      const compressed = dialect.compress(mem.content, {
        room: mem.memory_type,
        date: new Date().toISOString().slice(0, 10),
      });
      addDocument(cwd, compressed, {
        raw: mem.content.slice(0, 500),
        room: mem.memory_type,
        source: 'session-consolidation',
        importance: 3,
        timestamp: new Date().toISOString(),
      });
    }

    // Clear working-memory.md (scratchpad fully persisted)
    fs.writeFileSync(wmPath, '', 'utf-8');
  } catch { /* best effort */ }
}
