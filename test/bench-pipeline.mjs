/**
 * Tier 2: Pipeline Integration Benchmarks
 *
 * 2A: Extract-Compress-Store Pipeline
 * 2B: WakeUp Context Quality
 * 2C: Session Consolidation
 *
 * Run: node test/bench-pipeline.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const FIXTURES = path.resolve(__dirname, 'bench-fixtures');
const RESULTS_DIR = path.resolve(__dirname, 'bench-results');

const { extractMemories } = require(path.join(DIST, 'memory', 'memory-extractor.js'));
const { Dialect } = require(path.join(DIST, 'memory', 'aaak-dialect.js'));
const vectorStore = require(path.join(DIST, 'memory', 'vector-store.js'));
const memoryStack = require(path.join(DIST, 'memory', 'memory-stack.js'));
const stateModule = require(path.join(DIST, 'state.js'));

// ── Setup ──────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-bench-pipeline-'));
const omlDir = path.join(tmpDir, '.oh-my-link');
fs.mkdirSync(omlDir, { recursive: true });

// Patch state paths to use temp dir
const origVectorPath = stateModule.getVectorIndexPath;
const origIdentityPath = stateModule.getIdentityPath;
const origWmPath = stateModule.getWorkingMemoryPath;

stateModule.getVectorIndexPath = () => path.join(omlDir, 'vector-index.json');
stateModule.getIdentityPath = () => path.join(omlDir, 'identity.md');
stateModule.getWorkingMemoryPath = () => path.join(omlDir, 'working-memory.md');

const results = { tier: '2', name: 'Pipeline Integration', tests: {} };
let allPassed = true;

// ══════════════════════════════════════════════════════════════
// 2A: Extract-Compress-Store Pipeline
// ══════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log('  Tier 2A: Extract-Compress-Store Pipeline');
console.log('='.repeat(60));

const pipelineInputs = [
  {
    id: 'tool-output-1',
    text: `We decided to use a monorepo structure with turborepo for build orchestration.
The approach is to have shared packages in packages/ and apps in apps/.
Because this gives us code sharing without the complexity of npm publishing.
The infrastructure uses Docker Compose for local development.`,
    expectedTypes: ['decision'],
  },
  {
    id: 'tool-output-2',
    text: `Fixed the critical authentication bug. The issue was that JWT tokens were being
validated against the wrong public key after the key rotation. The root cause was
a race condition in the key cache refresh logic. Patched it by adding a mutex
around the key fetch operation. It works now.`,
    expectedTypes: ['problem', 'milestone'],
  },
  {
    id: 'tool-output-3',
    text: `I prefer to use absolute imports with path aliases configured in tsconfig.json.
Always use @/ prefix for src directory imports. Never use relative imports that
go more than 2 levels up. My rule is to keep import statements sorted: external
libraries first, then internal modules, then relative imports.`,
    expectedTypes: ['preference'],
  },
  {
    id: 'tool-output-4',
    text: `Deployed version 4.2.0 to production. 50% improvement in API response times
after the database query optimization. Built a new caching layer that reduced
database load by 60%. This is the first release with zero-downtime deployment.`,
    expectedTypes: ['milestone'],
  },
  {
    id: 'tool-output-5',
    text: `The WebSocket connection keeps dropping every 30 seconds. The problem is that
the nginx proxy has a default timeout of 60 seconds for WebSocket connections.
The workaround is to send periodic ping frames. Error rate has been above 15%
since the last deploy.`,
    expectedTypes: ['problem'],
  },
];

let pipelineCaptured = 0;
let pipelineTotal = 0;
const dialect = new Dialect();

for (const input of pipelineInputs) {
  const memories = extractMemories(input.text, 0.3);
  pipelineTotal += input.expectedTypes.length;

  for (const mem of memories.slice(0, 3)) {
    const compressed = dialect.compress(mem.content, {
      room: mem.memory_type,
      date: new Date().toISOString().slice(0, 10),
    });

    vectorStore.addDocument(tmpDir, compressed, {
      raw: mem.content.slice(0, 500),
      room: mem.memory_type,
      source: 'pipeline-bench',
      importance: mem.confidence >= 0.7 ? 4 : 3,
      timestamp: new Date().toISOString(),
    });
  }

  // Check coverage: did we capture at least one memory for each expected type?
  for (const expectedType of input.expectedTypes) {
    const matched = memories.some(m => m.memory_type === expectedType);
    if (matched) pipelineCaptured++;
  }
}

const pipelinePct = pipelineTotal > 0 ? (pipelineCaptured / pipelineTotal * 100) : 0;
const pipelinePassed = pipelinePct >= 80;
const docsStored = vectorStore.countDocuments(tmpDir);

results.tests['2A'] = {
  name: 'Extract-Compress-Store Pipeline',
  captured: pipelineCaptured,
  total: pipelineTotal,
  captureRate: pipelinePct.toFixed(1) + '%',
  documentsStored: docsStored,
  passed: pipelinePassed,
};

console.log(`  Captured:     ${pipelineCaptured}/${pipelineTotal} (${pipelinePct.toFixed(1)}%)`);
console.log(`  Docs stored:  ${docsStored}`);
console.log(`  Result: ${pipelinePassed ? 'PASS' : 'FAIL'}`);
if (!pipelinePassed) allPassed = false;

// ══════════════════════════════════════════════════════════════
// 2B: WakeUp Context Quality
// ══════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log('  Tier 2B: WakeUp Context Quality');
console.log('='.repeat(60));

// Create identity file
fs.writeFileSync(stateModule.getIdentityPath(tmpDir),
  '# Project Identity\nName: BenchTest\nStack: Node.js + TypeScript\nRole: Full-stack developer\n',
  'utf-8',
);

// Test wakeUp with no hint
const wakeupNoHint = memoryStack.wakeUp(tmpDir);
const wakeupNoHintLen = wakeupNoHint ? wakeupNoHint.length : 0;
const hasIdentity = wakeupNoHint ? wakeupNoHint.includes('Identity') : false;
const hasMemories = wakeupNoHint ? wakeupNoHint.includes('Memories') : false;

// Test wakeUp with task hint
const wakeupWithHint = memoryStack.wakeUp(tmpDir, 'authentication JWT token');
const wakeupHintLen = wakeupWithHint ? wakeupWithHint.length : 0;

// Check if hint-based retrieval returns relevant content
const hintRelevant = wakeupWithHint ? (
  wakeupWithHint.toLowerCase().includes('auth') ||
  wakeupWithHint.toLowerCase().includes('jwt') ||
  wakeupWithHint.toLowerCase().includes('token')
) : false;

const wakeupPassed = (
  wakeupNoHintLen > 0 &&
  wakeupNoHintLen <= 3200 &&
  hasIdentity &&
  hasMemories
);

results.tests['2B'] = {
  name: 'WakeUp Context Quality',
  noHintLength: wakeupNoHintLen,
  withHintLength: wakeupHintLen,
  hasIdentity,
  hasMemories,
  hintRelevant,
  withinBudget: wakeupNoHintLen <= 3200,
  passed: wakeupPassed,
};

console.log(`  No-hint length:   ${wakeupNoHintLen} chars`);
console.log(`  With-hint length: ${wakeupHintLen} chars`);
console.log(`  Has Identity:     ${hasIdentity}`);
console.log(`  Has Memories:     ${hasMemories}`);
console.log(`  Hint relevant:    ${hintRelevant}`);
console.log(`  Within budget:    ${wakeupNoHintLen <= 3200}`);
console.log(`  Result: ${wakeupPassed ? 'PASS' : 'FAIL'}`);
if (!wakeupPassed) allPassed = false;

// ══════════════════════════════════════════════════════════════
// 2C: Session Consolidation
// ══════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log('  Tier 2C: Session Consolidation');
console.log('='.repeat(60));

// Write working memory content
const workingMemory = `## Working Memory

We decided to use cursor-based pagination for the timeline API because offset-based
pagination was showing duplicate items when the dataset changes between page loads.

The team prefers using React Server Components for data fetching. Always use suspense
boundaries around async components. Never fetch data in useEffect for initial page load.

Fixed the memory leak in the event listener cleanup. The bug was that removeEventListener
was called with a different function reference than addEventListener. Solved by storing
the handler reference in a WeakMap.

Shipped the v3.0 release with the new real-time collaboration feature. First time we
have true concurrent editing working across all browsers.
`;

const wmPath = stateModule.getWorkingMemoryPath(tmpDir);
fs.writeFileSync(wmPath, workingMemory, 'utf-8');

const docsBefore = vectorStore.countDocuments(tmpDir);

// Run consolidation
memoryStack.consolidateSession(tmpDir);

const docsAfter = vectorStore.countDocuments(tmpDir);
const newDocs = docsAfter - docsBefore;

// Check working memory was cleared
let wmContent = '';
try { wmContent = fs.readFileSync(wmPath, 'utf-8').trim(); } catch {}
const wmCleared = wmContent.length === 0;

const consolidatePassed = newDocs > 0 && wmCleared;

results.tests['2C'] = {
  name: 'Session Consolidation',
  docsBefore,
  docsAfter,
  newDocuments: newDocs,
  workingMemoryCleared: wmCleared,
  passed: consolidatePassed,
};

console.log(`  Docs before:         ${docsBefore}`);
console.log(`  Docs after:          ${docsAfter}`);
console.log(`  New documents:       ${newDocs}`);
console.log(`  WM cleared:          ${wmCleared}`);
console.log(`  Result: ${consolidatePassed ? 'PASS' : 'FAIL'}`);
if (!consolidatePassed) allPassed = false;

// ── Final Summary ──────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('  Tier 2 Summary');
console.log('='.repeat(60));
for (const [key, test] of Object.entries(results.tests)) {
  console.log(`  ${key} ${test.name.padEnd(35)} ${test.passed ? 'PASS' : 'FAIL'}`);
}
console.log('-'.repeat(60));
console.log(`  Overall: ${allPassed ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(60) + '\n');

// Cleanup
stateModule.getVectorIndexPath = origVectorPath;
stateModule.getIdentityPath = origIdentityPath;
stateModule.getWorkingMemoryPath = origWmPath;
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

// Save results
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, 'bench-2-pipeline.json'),
  JSON.stringify(results, null, 2),
);
console.log(`  Results saved to: test/bench-results/bench-2-pipeline.json`);

process.exit(allPassed ? 0 : 1);
