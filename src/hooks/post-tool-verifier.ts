import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, getCwd, getQuietLevel, readJson, writeJsonAtomic, debugLog, normalizeToolOutput, logMemoryUsage } from '../helpers';
import { loadMemory, saveMemory, recordHotPath } from '../project-memory';
import { getSessionPath, getProjectStateRoot, getWorkingMemoryPath,
         getPriorityContextPath, ensureDir, normalizePath } from '../state';
import { SessionState, HookInput } from '../types';
import { detectMcpTool } from '../mcp-config';
import { releaseLock } from '../task-engine';

const FAILURE_PATTERNS = [
  /\berror TS\d+\b/i,           // TypeScript errors
  /\bSyntaxError\b/,            // JS/TS syntax errors
  /\bFAIL\b/,                   // Test failures (jest, etc.)
  /\bnpm ERR!/,                 // npm errors
  /\bBuild failed\b/i,          // Build failures
  /\bCannot find module\b/i,    // Module resolution errors
  /\bENOENT\b/,                 // File not found (system)
  /\bSegmentation fault\b/i,    // Crash
  /\bexit code [1-9]\b/i,       // Non-zero exit codes
  /\bcommand failed\b/i,        // Command failures
  /\bpermission denied\b/i,     // Permission errors
  /\bEACCES\b/,                 // Access errors
];

const OUTPUT_CLIP_LIMIT = 12000;

/**
 * Sanitize template expressions ({{ ... }}) from text to prevent Claude Code's
 * internal expression evaluator from accidentally evaluating them.
 * This protects against crashes when n8n workflow files or similar template-heavy
 * content flows through Claude Code's pipeline (e.g. `={{ $.speed }}`).
 */
const TEMPLATE_EXPRESSION_RE = /\{\{[\s\S]*?\}\}/g;
function sanitizeExpressions(text: string): string {
  return text.replace(TEMPLATE_EXPRESSION_RE, '{{/* expr */}}');
}

const HOT_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'Bash']);

function extractFilePath(toolInput: Record<string, unknown>): string | null {
  return (toolInput.file_path as string)
    ?? (toolInput.filePath as string)
    ?? null;
}

function extractFilePaths(toolName: string, toolInput: Record<string, unknown>): string[] {
  if (['Edit', 'Write'].includes(toolName)) {
    const fp = extractFilePath(toolInput);
    return fp ? [fp] : [];
  }
  if (toolName === 'MultiEdit') {
    const edits = toolInput.edits as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(edits)) {
      return edits.map(e => (e.file_path as string) ?? (e.filePath as string)).filter(Boolean) as string[];
    }
  }
  return [];
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);
  logMemoryUsage(cwd, 'post-tool-verifier:start');
  const session = readJson<SessionState>(getSessionPath(cwd));

  if (!session?.active) { hookOutput('PostToolUse'); return; }

  const toolName = input.tool_name || '';
  const toolOutput = normalizeToolOutput(input as Record<string, unknown>);
  const toolInput = (input.tool_input || {}) as Record<string, unknown>;

  // Raw key diagnostic — log ALL keys Claude Code sends so we know the actual schema
  const rawKeys = Object.keys(input).sort().join(',');
  debugLog(cwd, 'post-tool-raw', `keys=[${rawKeys}] tool=${toolName} output_len=${toolOutput.length} has_tool_response=${'tool_response' in input} has_tool_output=${'tool_output' in input}`);

  debugLog(cwd, 'post-tool', `tool=${toolName} output_len=${toolOutput.length}`);

  // MCP detection with result status + tracking counters
  const mcpInfo = detectMcpTool(toolName, cwd);
  if (mcpInfo) {
    const clippedForMcp = toolOutput && toolOutput.length > OUTPUT_CLIP_LIMIT
      ? toolOutput.slice(0, OUTPUT_CLIP_LIMIT)
      : toolOutput;
    const success = !FAILURE_PATTERNS.some(p => p.test(clippedForMcp || ''));
    debugLog(cwd, 'mcp-result', `provider=${mcpInfo.providerId} method=${mcpInfo.method} tool=${toolName} success=${success} output_len=${toolOutput.length}`);

    // Persist MCP call counters to tool-tracking.json for observability
    try {
      const trackPath = normalizePath(path.join(getProjectStateRoot(cwd), 'tool-tracking.json'));
      const tracking = readJson<Record<string, unknown>>(trackPath) || {};
      const mcpStats = (tracking.mcp_stats as Record<string, { attempted: number; succeeded: number; failed: number }>) || {};
      if (!mcpStats[mcpInfo.providerId]) {
        mcpStats[mcpInfo.providerId] = { attempted: 0, succeeded: 0, failed: 0 };
      }
      mcpStats[mcpInfo.providerId].attempted++;
      if (success) {
        mcpStats[mcpInfo.providerId].succeeded++;
      } else {
        mcpStats[mcpInfo.providerId].failed++;
      }
      tracking.mcp_stats = mcpStats;
      // Also track aggregate
      tracking.mcp_total_attempted = ((tracking.mcp_total_attempted as number) || 0) + 1;
      tracking.mcp_total_succeeded = ((tracking.mcp_total_succeeded as number) || 0) + (success ? 1 : 0);
      tracking.mcp_total_failed = ((tracking.mcp_total_failed as number) || 0) + (success ? 0 : 1);
      writeJsonAtomic(trackPath, tracking);
    } catch { /* best effort — never block tool flow */ }
  }

  // Clip overly long outputs to prevent oversized analysis
  const clippedOutput = toolOutput && toolOutput.length > OUTPUT_CLIP_LIMIT
    ? toolOutput.slice(0, OUTPUT_CLIP_LIMIT) + `\n\n[... clipped ${toolOutput.length - OUTPUT_CLIP_LIMIT} chars]`
    : toolOutput;
  const quiet = getQuietLevel();
  const parts: string[] = [];

  // Failure detection — only for Bash output (reading files with error strings is not a failure)
  if (toolName === 'Bash' && clippedOutput && FAILURE_PATTERNS.some(p => p.test(clippedOutput))) {
    const matchedPattern = FAILURE_PATTERNS.find(p => p.test(clippedOutput));
    const matchedError = matchedPattern ? (clippedOutput.match(matchedPattern)?.[0] || 'unknown') : 'unknown';
    debugLog(cwd, 'post-tool', `FAILURE in ${toolName}: ${matchedError}`);

    if (quiet < 2) {
      parts.push(`[oh-my-link] Possible failure detected in ${toolName} output.`);
    }

    // Update session failure counter
    try {
      if (session) {
        // Capture which pattern matched for the error field
        const matchedPattern = FAILURE_PATTERNS.find(p => p.test(clippedOutput));
        const matchedError = matchedPattern ? (clippedOutput.match(matchedPattern)?.[0] || 'unknown') : 'unknown';

        session.failure_count = (session.failure_count || 0) + 1;
        session.last_failure = {
          tool: toolName,
          error: matchedError,
          timestamp: new Date().toISOString(),
          snippet: clippedOutput.slice(0, 500),
        };
        session.last_checked_at = new Date().toISOString();
        writeJsonAtomic(getSessionPath(cwd), session);
      }
    } catch { /* best effort */ }

    // Also add to tracking.failures for checkpoint use (pre-compact reads this)
    try {
      const trackPath = normalizePath(path.join(getProjectStateRoot(cwd), 'tool-tracking.json'));
      const tracking = readJson<Record<string, unknown>>(trackPath) || {};
      const failures = (tracking.failures as Array<Record<string, string>>) || [];
      // Capture which pattern matched for the error field (short keyword)
      const trackMatchedPattern = FAILURE_PATTERNS.find(p => p.test(clippedOutput));
      const trackMatchedError = trackMatchedPattern ? (clippedOutput.match(trackMatchedPattern)?.[0] || 'unknown') : 'unknown';

      failures.push({
        tool: toolName,
        error: trackMatchedError,
        timestamp: new Date().toISOString(),
        snippet: clippedOutput.slice(0, 500),
      });
      tracking.failures = failures;
      writeJsonAtomic(trackPath, tracking);
    } catch { /* best effort */ }
  }

  // Output clipping warning
  if (toolOutput && toolOutput.length > OUTPUT_CLIP_LIMIT) {
    debugLog(cwd, 'post-tool', `output clipped: ${toolOutput.length} chars`);
    if (quiet < 1) {
      parts.push(`[oh-my-link] Output clipped (${toolOutput.length} chars > ${OUTPUT_CLIP_LIMIT}).`);
    }
  }

  // File tracking for Edit/Write/MultiEdit
  if (['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
    if (['Edit', 'Write'].includes(toolName)) {
      const filePath = extractFilePath(toolInput);
      if (filePath) trackFile(filePath, cwd);
    } else if (toolName === 'MultiEdit') {
      const edits = toolInput.edits as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(edits)) {
        for (const edit of edits) {
          const fp = (edit.file_path as string) ?? (edit.filePath as string);
          if (fp) trackFile(fp, cwd);
        }
      }
    }
  }

  // AUTO RELEASE LOCKS after Edit/Write/MultiEdit completes
  // Locks are acquired in pre-tool-enforcer; they MUST be released here or they
  // block subsequent edits to the same file (each hook invocation is a different PID).
  // Use the same holder identity logic as pre-tool-enforcer.
  if (['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
    const holderId = (input as any).agent_id || (input as any).agentId
      || (input as any).session_id || (input as any).sessionId
      || `hook-${process.pid}`;
    const filePaths = extractFilePaths(toolName, toolInput);
    for (const fp of filePaths) {
      try {
        releaseLock(cwd, fp, holderId);
        debugLog(cwd, 'post-tool', `lock-released: ${fp} by ${holderId}`);
      } catch { /* best effort — never block tool completion */ }
    }
  }

  // Tool tracking metadata (tool count, last tool)
  try {
    const trackPath = normalizePath(path.join(getProjectStateRoot(cwd), 'tool-tracking.json'));
    const tracking = readJson<Record<string, unknown>>(trackPath) || {};
    tracking.tool_count = ((tracking.tool_count as number) || 0) + 1;
    tracking.last_tool = toolName;
    tracking.last_tool_at = new Date().toISOString();
    if (['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
      const files = tracking.files_modified as string[] || [];
      const targetPaths = extractFilePaths(toolName, toolInput);
      for (const fp of targetPaths) {
        if (!files.includes(fp)) files.push(fp);
      }
      tracking.files_modified = files;
    }
    writeJsonAtomic(trackPath, tracking);
  } catch { /* best effort */ }

  // Hot path tracking for project memory
  try {
    if (HOT_PATH_TOOLS.has(toolName)) {
      let filePath: string | null = null;

      if (['Read', 'Edit', 'Write'].includes(toolName)) {
        filePath = extractFilePath(toolInput);
      } else if (toolName === 'MultiEdit') {
        // Track each file in MultiEdit
        const edits = toolInput.edits as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(edits)) {
          const memory = loadMemory(cwd);
          let dirty = false;
          for (const edit of edits) {
            const fp = (edit.file_path as string) ?? (edit.filePath as string);
            if (fp) {
              recordHotPath(memory, fp);
              dirty = true;
            }
          }
          if (dirty) saveMemory(cwd, memory);
        }
      } else if (toolName === 'Bash') {
        // Extract file paths from Bash commands
        const command = (toolInput.command as string) || '';
        const filePathPattern = /(?:^|\s)((?:\.\/|\.\.\/|\/)?(?:[\w./-]+\/)*[\w.-]+\.(?:ts|js|mjs|cjs|py|go|rs|md|json|yaml|yml|tsx|jsx|css|scss|html|vue|svelte|rb|java|kt|swift|c|cpp|h|hpp))\b/g;
        let fpMatch: RegExpExecArray | null = filePathPattern.exec(command);
        const memory = loadMemory(cwd);
        let dirty = false;
        while (fpMatch !== null) {
          const fp = fpMatch[1];
          if (!fp.includes('node_modules') && !fp.startsWith('/tmp') && !fp.startsWith('/dev/') && !fp.startsWith('/proc/') && !fp.startsWith('/sys/')) {
            recordHotPath(memory, fp);
            dirty = true;
          }
          fpMatch = filePathPattern.exec(command);
        }
        if (dirty) saveMemory(cwd, memory);
      }

      // Single-file tools (Read, Edit, Write)
      if (filePath && toolName !== 'MultiEdit' && toolName !== 'Bash') {
        const memory = loadMemory(cwd);
        recordHotPath(memory, filePath);
        saveMemory(cwd, memory);
      }
    }
  } catch { /* best effort — don't block tool use */ }

  // Auto-extract memories from tool output (best effort, never injects context)
  if (toolOutput && toolOutput.length >= 200
      && ['Bash', 'Edit', 'Write', 'MultiEdit'].includes(toolName)) {
    try {
      const { extractMemories } = require('../memory/memory-extractor') as { extractMemories: (text: string, minConfidence?: number) => Array<{ content: string; memory_type: string; chunk_index: number; confidence: number }> };
      const { Dialect } = require('../memory/aaak-dialect') as { Dialect: new () => { compress: (text: string, metadata?: Record<string, string>) => string; extractTopics: (text: string, maxTopics?: number) => string[]; extractKeySentence: (text: string) => string } };
      const { addDocument } = require('../memory/vector-store') as { addDocument: (cwd: string, text: string, metadata: Record<string, unknown>) => string };

      const sanitized = sanitizeExpressions(toolOutput);
      const memories = extractMemories(sanitized, 0.4);  // slightly higher threshold for auto-extraction

      debugLog(cwd, 'mem:extract', `tool=${toolName} input_len=${sanitized.length} candidates=${memories.length} threshold=0.4`);

      if (memories.length > 0) {
        const dialect = new Dialect();
        // Limit extractions per tool call to cap file I/O
        // Allow more extractions (5) for large outputs that likely contain more valuable info
        const extractionCap = toolOutput.length > 2000 ? 5 : 3;
        for (const mem of memories.slice(0, extractionCap)) {
          const compressed = dialect.compress(mem.content, {
            room: mem.memory_type,
            date: new Date().toISOString().slice(0, 10),
          });
          const docId = addDocument(cwd, compressed, {
            raw: mem.content.slice(0, 500),
            room: mem.memory_type,
            source: toolName,
            importance: mem.confidence >= 0.7 ? 4 : 3,
            timestamp: new Date().toISOString(),
          });
          debugLog(cwd, 'mem:store', `id=${docId} room=${mem.memory_type} conf=${mem.confidence.toFixed(2)} importance=${mem.confidence >= 0.7 ? 4 : 3} aaak_len=${compressed.length} raw="${mem.content.slice(0, 60).replace(/\n/g, ' ')}"`);
        }
        debugLog(cwd, 'mem:extract', `stored=${Math.min(memories.length, extractionCap)}/${memories.length} cap=${extractionCap}`);

        // Entity learning from extracted memories (best effort)
        try {
          const { EntityRegistry: ER } = require('../memory/entity-registry') as {
            EntityRegistry: {
              load: (path: string) => {
                learnFromText: (text: string, minConf?: number) => Array<{ name: string; type: string }>;
                save: () => void;
              }
            }
          };
          const { getEntityRegistryPath: getERPath } = require('../state') as {
            getEntityRegistryPath: (cwd: string) => string;
          };
          const registry = ER.load(getERPath(cwd));
          const combinedText = memories.map(m => m.content).join('\n');
          const newEntities = registry.learnFromText(combinedText, 0.75);
          if (newEntities.length > 0) {
            debugLog(cwd, 'mem:entity-learn', `discovered ${newEntities.length} new entities: ${newEntities.map(e => `${e.name}(${e.type})`).join(', ')}`);
          }
        } catch (entityErr) {
          debugLog(cwd, 'mem:entity-learn', `FAILED: ${(entityErr as Error)?.message || entityErr}`);
        }

        // KG triple creation for decision memories (best effort)
        try {
          const decisionMemories = memories.filter(m => m.memory_type === 'decision' && m.confidence >= 0.5);
          if (decisionMemories.length > 0) {
            const { KnowledgeGraph: KG } = require('../memory/knowledge-graph') as {
              KnowledgeGraph: new (dbPath: string) => {
                addTriple: (s: string, p: string, o: string, opts?: Record<string, unknown>) => string;
                close: () => void;
              }
            };
            const { getKnowledgeGraphPath: getKGPath } = require('../state') as {
              getKnowledgeGraphPath: (cwd: string) => string;
            };
            const kg = new KG(getKGPath(cwd));
            for (const mem of decisionMemories.slice(0, 3)) {
              const topics = dialect.extractTopics(mem.content);
              const keySentence = dialect.extractKeySentence(mem.content);
              if (topics.length > 0 && keySentence) {
                const tripleId = kg.addTriple(
                  topics[0],
                  'decided_on',
                  keySentence.slice(0, 100),
                  {
                    valid_from: new Date().toISOString().slice(0, 10),
                    confidence: mem.confidence,
                    source_closet: toolName,
                  }
                );
                debugLog(cwd, 'mem:kg-triple', `id=${tripleId} ${topics[0]} -> decided_on -> ${keySentence.slice(0, 40)}`);
              }
            }
            kg.close();
          }
        } catch (kgErr) {
          debugLog(cwd, 'mem:kg-triple', `FAILED: ${(kgErr as Error)?.message || kgErr}`);
        }
      }
    } catch (err) { debugLog(cwd, 'mem:extract', `FAILED: ${(err as Error)?.message || err}`); }
  }

  // Process <remember> tags — only for tools that produce AGENT output.
  // Read/Glob/Grep return raw file/search content that may contain example <remember>
  // tags from documentation or skill files → causes false-positive memory bloat.
  const REMEMBER_ALLOWED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task']);
  if (toolOutput && REMEMBER_ALLOWED_TOOLS.has(toolName)) {
    const rememberResult = processRememberTags(sanitizeExpressions(toolOutput), cwd, toolName);
    if (rememberResult) {
      debugLog(cwd, 'post-tool', `remember-tag processed: ${rememberResult.slice(0, 80)}`);
    }
  } else if (toolOutput && !REMEMBER_ALLOWED_TOOLS.has(toolName)) {
    // Check if there ARE remember tags to help debug — log but don't process
    const hasRememberTags = /<remember/.test(toolOutput);
    if (hasRememberTags) {
      debugLog(cwd, 'post-tool', `remember-tags SKIPPED for tool=${toolName} (read-only tool, likely file content)`);
    }
  }

  // Process <skill-feedback> tags — same gating: only agent output tools
  if (toolOutput && REMEMBER_ALLOWED_TOOLS.has(toolName)) {
    processSkillFeedback(sanitizeExpressions(toolOutput), cwd);
  }

  hookOutput('PostToolUse', parts.length > 0 ? sanitizeExpressions(parts.join('\n')) : undefined);
}

function trackFile(filePath: string, cwd: string): void {
  const trackPath = normalizePath(path.join(getProjectStateRoot(cwd), 'file-tracking.json'));
  const tracked = readJson<string[]>(trackPath) || [];
  if (!tracked.includes(filePath)) {
    tracked.push(filePath);
    debugLog(cwd, 'post-tool', `file-tracked: ${filePath}`);
    try { writeJsonAtomic(trackPath, tracked); } catch { /* ignore */ }
  }
}

function processRememberTags(output: string, cwd: string, toolName?: string): string | null {
  let firstContent: string | null = null;
  // <remember>content</remember> → append to working-memory.md with timestamp and --- separator
  const rememberMatches = output.match(/<remember>(?![\s]*priority)([\s\S]*?)<\/remember>/g);
  if (rememberMatches) {
    debugLog(cwd, 'mem:remember', `found ${rememberMatches.length} <remember> tag(s) from tool=${toolName || 'unknown'}`);
    const memPath = getWorkingMemoryPath(cwd);
    ensureDir(path.dirname(memPath));
    for (const match of rememberMatches) {
      const content = match.replace(/<\/?remember>/g, '').trim();
      if (content) {
        if (!firstContent) firstContent = content;
        const timestamp = new Date().toISOString();
        const entry = `\n---\n**${timestamp}**\n${content}\n`;
        try {
          const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : '';
          const combined = existing + entry;
          fs.writeFileSync(memPath, combined, 'utf-8');
          debugLog(cwd, 'mem:remember', `written to working-memory.md (${combined.length} bytes) content="${content.slice(0, 80).replace(/\n/g, ' ')}"`);
        } catch { /* ignore */ }
        // Memory system: AAAK compress + vector store write (best effort)
        try {
          const { Dialect } = require('../memory/aaak-dialect') as { Dialect: new () => { compress: (text: string, metadata?: Record<string, string>) => string } };
          const { addDocument } = require('../memory/vector-store') as { addDocument: (cwd: string, text: string, metadata: Record<string, unknown>) => string };
          const dialect = new Dialect();
          const compressed = dialect.compress(content, {
            room: 'remember',
            date: new Date().toISOString().slice(0, 10),
          });
          const docId = addDocument(cwd, compressed, {
            raw: content.slice(0, 500),
            room: 'remember',
            source: toolName || 'unknown',
            importance: 3,
            timestamp,
          });
          debugLog(cwd, 'mem:store', `id=${docId} room=remember importance=3 aaak_len=${compressed.length} source=${toolName || 'unknown'}`);
        } catch (err) { debugLog(cwd, 'mem:remember', `vector-store FAILED: ${(err as Error)?.message || err}`); }
      }
    }
  }

  // <remember priority>content</remember> → write to priority-context.md with dedup
  const priorityMatches = output.match(/<remember\s+priority>([\s\S]*?)<\/remember>/g);
  if (priorityMatches) {
    debugLog(cwd, 'mem:priority', `found ${priorityMatches.length} <remember priority> tag(s) from tool=${toolName || 'unknown'}`);
    const priPath = getPriorityContextPath(cwd);
    ensureDir(path.dirname(priPath));
    for (const match of priorityMatches) {
      const newContent = match.replace(/<\/?remember(?: priority)?>/g, '').trim();
      if (newContent.length > 0) {
        if (!firstContent) firstContent = newContent;
        try {
          const existing = fs.existsSync(priPath) ? fs.readFileSync(priPath, 'utf-8').trim() : '';
          const existingEntries = existing ? existing.split('\n').filter((l: string) => l.trim()) : [];
          // Deduplicate: check if newContent already exists
          const isDuplicate = existingEntries.some((entry: string) => {
            const contentPart = entry.replace(/^\[[^\]]*\]\s*/, '');
            return contentPart === newContent;
          });
          if (isDuplicate) {
            debugLog(cwd, 'mem:priority', `DEDUP skipped: "${newContent.slice(0, 60).replace(/\n/g, ' ')}"`);
          } else {
            const ts = new Date().toISOString().substring(0, 16);
            const newEntry = `[${ts}] ${newContent}`;
            const entries = [...existingEntries, newEntry];
            const final = entries.join('\n');
            fs.writeFileSync(priPath, final, 'utf-8');
            debugLog(cwd, 'mem:priority', `written to priority-context.md (${final.length} chars) entries=${entries.length} content="${newContent.slice(0, 60).replace(/\n/g, ' ')}"`);
            // Memory system: AAAK compress + vector store write (best effort)
            try {
              const { Dialect } = require('../memory/aaak-dialect') as { Dialect: new () => { compress: (text: string, metadata?: Record<string, string>) => string } };
              const { addDocument } = require('../memory/vector-store') as { addDocument: (cwd: string, text: string, metadata: Record<string, unknown>) => string };
              const dialect = new Dialect();
              const compressed = dialect.compress(newContent, {
                room: 'priority',
                date: new Date().toISOString().slice(0, 10),
              });
              const docId = addDocument(cwd, compressed, {
                raw: newContent.slice(0, 500),
                room: 'priority',
                source: toolName || 'unknown',
                importance: 5,
                timestamp: new Date().toISOString(),
              });
              debugLog(cwd, 'mem:store', `id=${docId} room=priority importance=5 aaak_len=${compressed.length} source=${toolName || 'unknown'}`);
            } catch (err) { debugLog(cwd, 'mem:priority', `vector-store FAILED: ${(err as Error)?.message || err}`); }
          }
        } catch { /* ignore */ }
      }
    }
  }
  return firstContent;
}

function processSkillFeedback(output: string, cwd: string): void {
  try {
    const feedbackRegex = /<skill-feedback\s+name="([^"]+)"\s+useful="false">([\s\S]*?)<\/skill-feedback>/g;
    let match: RegExpExecArray | null = feedbackRegex.exec(output);
    while (match !== null) {
      const slug = match[1].trim();
      const reason = match[2].trim();
      if (slug.length > 0) {
        const feedbackPath = normalizePath(path.join(getProjectStateRoot(cwd), 'skill-feedback.json'));
        const feedback = readJson<Record<string, { negativeCount: number; lastNegative: string | null; reason: string }>>(feedbackPath) || {};
        if (!feedback[slug]) {
          feedback[slug] = { negativeCount: 0, lastNegative: null, reason: '' };
        }
        feedback[slug].negativeCount = (feedback[slug].negativeCount || 0) + 1;
        feedback[slug].lastNegative = new Date().toISOString();
        feedback[slug].reason = reason || feedback[slug].reason;
        try { writeJsonAtomic(feedbackPath, feedback); } catch { /* ignore */ }
      }
      match = feedbackRegex.exec(output);
    }
  } catch { /* best effort */ }
}

main().catch(() => hookOutput('PostToolUse'));
