/**
 * Tests for scripts/run.cjs — hook runner wrapper.
 *
 * Validates:
 *  - Runs an existing target script correctly
 *  - Exits 0 when called with no arguments
 *  - Propagates target script exit code
 *  - Falls back to local dev root when CLAUDE_PLUGIN_ROOT is unset
 *  - Handles stale CLAUDE_PLUGIN_ROOT by scanning version dirs
 */

import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, "..");
const runCjs = join(pluginRoot, "scripts", "run.cjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

console.log("\n=== run.cjs tests ===\n");

// --- Test 1: exits 0 with no args ---
test("exits 0 when called with no arguments", () => {
  // Should not throw
  execFileSync(process.execPath, [runCjs], { stdio: "pipe", timeout: 5000 });
});

// --- Test 2: runs an existing script and gets output ---
test("runs an existing target script", () => {
  const tmpScript = join(pluginRoot, "scripts", "_test-target.js");
  writeFileSync(tmpScript, 'process.stdout.write("hello-from-target");');
  try {
    const out = execFileSync(process.execPath, [runCjs, tmpScript], {
      stdio: "pipe",
      timeout: 5000,
    });
    assert(out.toString().includes("hello-from-target"), "expected output from target");
  } finally {
    rmSync(tmpScript, { force: true });
  }
});

// --- Test 3: propagates non-zero exit code ---
test("propagates target exit code", () => {
  const tmpScript = join(pluginRoot, "scripts", "_test-exit.js");
  writeFileSync(tmpScript, "process.exit(42);");
  try {
    execFileSync(process.execPath, [runCjs, tmpScript], {
      stdio: "pipe",
      timeout: 5000,
    });
    assert(false, "should have thrown");
  } catch (e) {
    assert(e.status === 42, `expected exit code 42, got ${e.status}`);
  } finally {
    rmSync(tmpScript, { force: true });
  }
});

// --- Test 4: local dev fallback (no CLAUDE_PLUGIN_ROOT) resolves dist/hooks/* ---
test("resolves dist/hooks/* path via local dev fallback when CLAUDE_PLUGIN_ROOT unset", () => {
  // Create a dummy target in dist/hooks
  const hooksDir = join(pluginRoot, "dist", "hooks");
  const dummyHook = join(hooksDir, "_test-dummy-hook.js");
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  writeFileSync(dummyHook, 'process.stdout.write("hook-resolved");');

  try {
    // Provide a target path that contains dist/hooks/ but with a bogus prefix
    const bogusTarget = "/nonexistent/plugin/dist/hooks/_test-dummy-hook.js";
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;

    const out = execFileSync(process.execPath, [runCjs, bogusTarget], {
      stdio: "pipe",
      timeout: 5000,
      env,
    });
    assert(out.toString().includes("hook-resolved"), "expected fallback resolution");
  } finally {
    rmSync(dummyHook, { force: true });
  }
});

// --- Test 5: stale CLAUDE_PLUGIN_ROOT scans version dirs ---
test("scans version directories when CLAUDE_PLUGIN_ROOT is stale", () => {
  // Setup: create a temp cache structure
  //   _test_cache/v1.0.0/  (stale — set as CLAUDE_PLUGIN_ROOT)
  //   _test_cache/v2.0.0/dist/hooks/my-hook.js  (the actual script)
  const cacheDir = join(pluginRoot, "_test_cache");
  const staleRoot = join(cacheDir, "v1.0.0");
  const newRoot = join(cacheDir, "v2.0.0");
  const hookDir = join(newRoot, "dist", "hooks");

  mkdirSync(hookDir, { recursive: true });
  mkdirSync(staleRoot, { recursive: true });
  writeFileSync(join(hookDir, "my-hook.js"), 'process.stdout.write("version-resolved");');

  try {
    const target = join(staleRoot, "dist", "hooks", "my-hook.js");
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: staleRoot };

    const out = execFileSync(process.execPath, [runCjs, target], {
      stdio: "pipe",
      timeout: 5000,
      env,
    });
    assert(out.toString().includes("version-resolved"), "expected version-scanned resolution");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// --- Test 6: passes extra arguments to target script ---
test("passes extra arguments to target script", () => {
  const tmpScript = join(pluginRoot, "scripts", "_test-args.js");
  writeFileSync(tmpScript, 'process.stdout.write(process.argv.slice(2).join(","));');
  try {
    const out = execFileSync(process.execPath, [runCjs, tmpScript, "start", "--verbose"], {
      stdio: "pipe",
      timeout: 5000,
    });
    assert(out.toString() === "start,--verbose", `expected "start,--verbose", got "${out}"`);
  } finally {
    rmSync(tmpScript, { force: true });
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
