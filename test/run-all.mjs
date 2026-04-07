/**
 * Oh-My-Link — Run ALL Test Files
 * Spawns every test/*.mjs file as a child process, streams output,
 * parses per-file results, and prints an aggregate summary.
 *
 * Run:  node test/run-all.mjs
 *       npm run test:all
 */

import { execFile } from 'child_process';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Discover all test files (exclude this runner itself)
const SELF = 'run-all.mjs';
const testFiles = readdirSync(__dirname)
  .filter(f => f.endsWith('.mjs') && f !== SELF)
  .sort();

// Parse "Results: X passed, Y failed" (and optional ", Z skipped") from output
const RESULTS_RE = /Results:\s*(\d+)\s*passed,\s*(\d+)\s*failed(?:,\s*(\d+)\s*skipped)?/;

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const fileResults = [];

function runFile(file) {
  const filePath = join(__dirname, file);
  return new Promise((resolve) => {
    const start = Date.now();
    execFile('node', [filePath], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const output = stdout + stderr;

      // Parse results line
      const match = output.match(RESULTS_RE);
      let passed = 0, failed = 0, skipped = 0;
      if (match) {
        passed = parseInt(match[1], 10);
        failed = parseInt(match[2], 10);
        skipped = parseInt(match[3] || '0', 10);
      }

      // If process crashed without printing results, count as 1 failure
      const crashed = error && !match;
      if (crashed) {
        failed = 1;
      }

      totalPassed += passed;
      totalFailed += failed;
      totalSkipped += skipped;

      const status = failed > 0 || crashed ? 'FAIL' : 'PASS';
      fileResults.push({ file, passed, failed, skipped, elapsed, status, crashed });

      // Stream the output with file header
      console.log(`\n${'='.repeat(60)}`);
      console.log(`  ${status}  ${file}  (${passed}p/${failed}f/${skipped}s) ${elapsed}s`);
      console.log('='.repeat(60));
      // Print test output (individual PASS/FAIL lines)
      const lines = output.split('\n');
      for (const line of lines) {
        // Print suite headers and test results, skip the per-file summary
        if (line.match(/^\s*(PASS|FAIL|SKIP|---)/)) {
          console.log(line);
        }
      }
      if (crashed) {
        console.log(`  CRASH: ${error.message}`);
      }

      resolve();
    });
  });
}

// Run all files sequentially (they may share env/temp resources)
console.log(`Oh-My-Link Test Runner — ${testFiles.length} test files\n`);

for (const file of testFiles) {
  await runFile(file);
}

// Aggregate summary
console.log(`\n${'#'.repeat(60)}`);
console.log(`  AGGREGATE RESULTS`);
console.log('#'.repeat(60));
console.log();

const maxName = Math.max(...fileResults.map(r => r.file.length));
for (const r of fileResults) {
  const icon = r.status === 'PASS' ? 'OK' : 'XX';
  const name = r.file.padEnd(maxName);
  console.log(`  [${icon}] ${name}  ${String(r.passed).padStart(3)}p ${String(r.failed).padStart(2)}f ${String(r.skipped).padStart(2)}s  ${r.elapsed}s`);
}

console.log();
console.log(`  Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
console.log(`  Files: ${fileResults.filter(r => r.status === 'PASS').length}/${testFiles.length} passed`);
console.log('#'.repeat(60));

process.exit(totalFailed > 0 ? 1 : 0);
