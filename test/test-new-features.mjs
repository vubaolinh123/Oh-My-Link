/**
 * Tests for new features:
 *   1. run.cjs semver sorting
 *   2. run.cjs setup.json fallback
 *   3. resolvePluginRoot() from state.ts
 *   4. Per-project config merge from config.ts
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, "..");
const runCjs = join(pluginRoot, "scripts", "run.cjs");
const require = createRequire(import.meta.url);
const DIST = resolve(__dirname, "..", "dist");

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    if (e.message === "__SKIP__") {
      skipped++;
      console.log(`  - ${name} (skipped)`);
    } else {
      failed++;
      console.log(`  \u2717 ${name}`);
      console.log(`    ${e.message}`);
    }
  }
}

function skip(reason) {
  const e = new Error("__SKIP__");
  e.reason = reason;
  throw e;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

console.log("\n=== New Feature Tests ===\n");

// ============================================================
// Section 1: run.cjs semver sort
// ============================================================

console.log("--- run.cjs semver sort ---");

test("semver sort prefers 2.0.0 over 1.9.0", () => {
  const cacheDir = join(pluginRoot, "_test_semver_cache");
  const staleRoot = join(cacheDir, "v0.0.1");
  const v190 = join(cacheDir, "v1.9.0");
  const v200 = join(cacheDir, "v2.0.0");

  mkdirSync(join(v190, "dist", "hooks"), { recursive: true });
  mkdirSync(join(v200, "dist", "hooks"), { recursive: true });
  mkdirSync(staleRoot, { recursive: true });

  writeFileSync(join(v190, "dist", "hooks", "test-hook.js"), 'process.stdout.write("from-v1");');
  writeFileSync(join(v200, "dist", "hooks", "test-hook.js"), 'process.stdout.write("from-v2");');

  try {
    // Target points into the stale v0.0.1 dir (which has no hook)
    const target = join(staleRoot, "dist", "hooks", "test-hook.js");
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: staleRoot };

    const out = execFileSync(process.execPath, [runCjs, target], {
      stdio: "pipe",
      timeout: 5000,
      env,
    });
    assert(out.toString().includes("from-v2"), `expected "from-v2", got "${out}"`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("semver sort handles non-semver dirs gracefully", () => {
  const cacheDir = join(pluginRoot, "_test_semver_nonsemver");
  const staleRoot = join(cacheDir, "v0.0.1");

  mkdirSync(join(cacheDir, "foo"), { recursive: true });
  mkdirSync(join(cacheDir, "v1.0.0", "dist", "hooks"), { recursive: true });
  mkdirSync(join(cacheDir, "bar"), { recursive: true });
  mkdirSync(join(cacheDir, "v2.0.0", "dist", "hooks"), { recursive: true });
  mkdirSync(staleRoot, { recursive: true });

  // Only v2.0.0 has the hook
  writeFileSync(
    join(cacheDir, "v2.0.0", "dist", "hooks", "ns-hook.js"),
    'process.stdout.write("from-v2-nonsemver");'
  );

  try {
    const target = join(staleRoot, "dist", "hooks", "ns-hook.js");
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: staleRoot };

    const out = execFileSync(process.execPath, [runCjs, target], {
      stdio: "pipe",
      timeout: 5000,
      env,
    });
    assert(out.toString().includes("from-v2-nonsemver"), `expected "from-v2-nonsemver", got "${out}"`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("semver sort handles single-digit versions", () => {
  const cacheDir = join(pluginRoot, "_test_semver_single");
  const staleRoot = join(cacheDir, "0");

  mkdirSync(join(cacheDir, "3", "dist", "hooks"), { recursive: true });
  mkdirSync(join(cacheDir, "10", "dist", "hooks"), { recursive: true });
  mkdirSync(join(cacheDir, "2", "dist", "hooks"), { recursive: true });
  mkdirSync(staleRoot, { recursive: true });

  // Only "10" has the hook
  writeFileSync(
    join(cacheDir, "10", "dist", "hooks", "sd-hook.js"),
    'process.stdout.write("from-10");'
  );

  try {
    const target = join(staleRoot, "dist", "hooks", "sd-hook.js");
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: staleRoot };

    const out = execFileSync(process.execPath, [runCjs, target], {
      stdio: "pipe",
      timeout: 5000,
      env,
    });
    assert(out.toString().includes("from-10"), `expected "from-10", got "${out}"`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ============================================================
// Section 2: run.cjs setup.json fallback
// ============================================================

console.log("\n--- run.cjs setup.json fallback ---");

test("resolves via setup.json fallback when CLAUDE_PLUGIN_ROOT is unset", () => {
  // Simulate a versioned cache layout where setup.json points to a stale version.
  // setup.json → pluginRoot = cacheDir/v1.0.0 (stale, no hook)
  // Hook exists at cacheDir/v2.0.0/dist/hooks/setup-test.js
  // Target references the stale path → setup.json resolves it via sibling scan.
  const cacheDir = join(pluginRoot, "_test_setup_cache");
  const staleRoot = join(cacheDir, "v1.0.0");
  const newRoot = join(cacheDir, "v2.0.0");

  mkdirSync(staleRoot, { recursive: true });
  mkdirSync(join(newRoot, "dist", "hooks"), { recursive: true });
  writeFileSync(
    join(newRoot, "dist", "hooks", "setup-test.js"),
    'process.stdout.write("from-setup-json");'
  );

  // Write/backup setup.json
  const setupDir = join(os.homedir(), ".oh-my-link");
  const setupFile = join(setupDir, "setup.json");
  let backup = null;
  if (existsSync(setupFile)) {
    backup = readFileSync(setupFile, "utf-8");
  }
  mkdirSync(setupDir, { recursive: true });
  writeFileSync(setupFile, JSON.stringify({ pluginRoot: staleRoot }));

  try {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    // Target points into the stale v1.0.0 dir (which has no hook)
    const target = join(staleRoot, "dist", "hooks", "setup-test.js");

    const out = execFileSync(process.execPath, [runCjs, target], {
      stdio: "pipe",
      timeout: 5000,
      env,
    });
    assert(out.toString().includes("from-setup-json"), "expected setup.json fallback to resolve");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    if (backup !== null) {
      writeFileSync(setupFile, backup);
    } else {
      rmSync(setupFile, { force: true });
    }
  }
});

test("setup.json fallback ignores invalid pluginRoot gracefully", () => {
  // Write/backup setup.json
  const setupDir = join(os.homedir(), ".oh-my-link");
  const setupFile = join(setupDir, "setup.json");
  let backup = null;
  if (existsSync(setupFile)) {
    backup = readFileSync(setupFile, "utf-8");
  }
  mkdirSync(setupDir, { recursive: true });
  writeFileSync(setupFile, JSON.stringify({ pluginRoot: "/totally/nonexistent/path" }));

  try {
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    const bogusTarget = "/nonexistent/target/dist/hooks/no-such-hook.js";

    // Should not crash — it may error with MODULE_NOT_FOUND but should
    // not throw an unhandled exception inside run.cjs resolution logic.
    // We expect a non-zero exit (since the script truly doesn't exist)
    // but NOT a crash in the resolver itself.
    try {
      execFileSync(process.execPath, [runCjs, bogusTarget], {
        stdio: "pipe",
        timeout: 5000,
        env,
      });
      // If it somehow succeeds (unlikely), that's fine too
    } catch (e) {
      // We expect MODULE_NOT_FOUND or similar — just verify it didn't
      // crash with a TypeError or other resolver bug
      const stderr = e.stderr ? e.stderr.toString() : "";
      assert(
        !stderr.includes("TypeError") && !stderr.includes("Cannot read properties"),
        `resolver crashed: ${stderr.slice(0, 200)}`
      );
    }
  } finally {
    if (backup !== null) {
      writeFileSync(setupFile, backup);
    } else {
      rmSync(setupFile, { force: true });
    }
  }
});

// ============================================================
// Section 3: resolvePluginRoot (from dist/state.js)
// ============================================================

console.log("\n--- resolvePluginRoot ---");

const stateModule = existsSync(join(DIST, "state.js")) ? require(join(DIST, "state.js")) : null;

if (!stateModule) {
  test("resolvePluginRoot tests require dist/ build", () => skip("dist/state.js not found"));
  test("resolvePluginRoot __dirname fallback", () => skip("dist/state.js not found"));
  test("resolvePluginRoot null for invalid state", () => skip("dist/state.js not found"));
} else {
  test("resolvePluginRoot returns path when CLAUDE_PLUGIN_ROOT is set", () => {
    const origEnv = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
      const result = stateModule.resolvePluginRoot();
      assert(result !== null, "expected non-null result");
      // Normalize both to forward slashes for comparison
      const normalResult = result.replace(/\\/g, "/");
      const normalExpected = pluginRoot.replace(/\\/g, "/");
      assert(
        normalResult === normalExpected,
        `expected "${normalExpected}", got "${normalResult}"`
      );
    } finally {
      if (origEnv !== undefined) {
        process.env.CLAUDE_PLUGIN_ROOT = origEnv;
      } else {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      }
    }
  });

  test("resolvePluginRoot falls back to __dirname inference", () => {
    const origEnv = process.env.CLAUDE_PLUGIN_ROOT;
    const setupDir = join(os.homedir(), ".oh-my-link");
    const setupFile = join(setupDir, "setup.json");
    let setupBackup = null;
    if (existsSync(setupFile)) {
      setupBackup = readFileSync(setupFile, "utf-8");
    }

    try {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      // Temporarily remove setup.json so it falls through to __dirname
      if (existsSync(setupFile)) {
        rmSync(setupFile, { force: true });
      }

      const result = stateModule.resolvePluginRoot();
      // __dirname for dist/state.js is dist/, so walking up should find package.json
      assert(result !== null, "expected non-null result from __dirname fallback");
    } finally {
      if (origEnv !== undefined) {
        process.env.CLAUDE_PLUGIN_ROOT = origEnv;
      } else {
        delete process.env.CLAUDE_PLUGIN_ROOT;
      }
      if (setupBackup !== null) {
        writeFileSync(setupFile, setupBackup);
      }
    }
  });

  test("resolvePluginRoot returns null for fully invalid state", () => {
    // This is difficult to test without mocking __dirname and fs.existsSync.
    // Marking as skipped with a note.
    skip("requires mocking __dirname and fs — not feasible in subprocess test");
  });
}

// ============================================================
// Section 4: Per-project config merge (from dist/config.js)
// ============================================================

console.log("\n--- Per-project config ---");

const configModule = existsSync(join(DIST, "config.js")) ? require(join(DIST, "config.js")) : null;

if (!configModule) {
  test("loadConfig defaults", () => skip("dist/config.js not found"));
  test("loadProjectConfig null for missing", () => skip("dist/config.js not found"));
  test("loadConfig merges project over global", () => skip("dist/config.js not found"));
} else {
  test("loadConfig returns defaults when no config files exist", () => {
    const origOmlHome = process.env.OML_HOME;
    const tempHome = join(pluginRoot, "_test_cfg_defaults");
    mkdirSync(tempHome, { recursive: true });

    // Use a temp project dir with no .oh-my-link/config.json
    const tempProject = join(pluginRoot, "_test_cfg_proj_empty");
    mkdirSync(tempProject, { recursive: true });

    try {
      process.env.OML_HOME = tempHome;
      const config = configModule.loadConfig(tempProject);
      assert(
        typeof config.models === "object",
        `expected models to be an object, got ${typeof config.models}`
      );
      assert(
        Object.keys(config.models).length === 0,
        `expected empty models, got ${JSON.stringify(config.models)}`
      );
      assert(config.quiet_level === 0, `expected quiet_level 0, got ${config.quiet_level}`);
    } finally {
      if (origOmlHome !== undefined) {
        process.env.OML_HOME = origOmlHome;
      } else {
        delete process.env.OML_HOME;
      }
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test("loadProjectConfig returns null for missing project config", () => {
    const tempProject = join(pluginRoot, "_test_cfg_proj_missing");
    mkdirSync(tempProject, { recursive: true });

    try {
      const result = configModule.loadProjectConfig(tempProject);
      assert(result === null, `expected null, got ${JSON.stringify(result)}`);
    } finally {
      rmSync(tempProject, { recursive: true, force: true });
    }
  });

  test("loadConfig merges project config over global config", () => {
    const origOmlHome = process.env.OML_HOME;
    const tempHome = join(pluginRoot, "_test_cfg_merge_home");
    const tempProject = join(pluginRoot, "_test_cfg_merge_proj");

    // Create global config at {OML_HOME}/config.json
    mkdirSync(tempHome, { recursive: true });
    writeFileSync(
      join(tempHome, "config.json"),
      JSON.stringify({ models: { worker: "global-model" }, quiet_level: 1 })
    );

    // Create project config at {cwd}/.oh-my-link/config.json
    const projCfgDir = join(tempProject, ".oh-my-link");
    mkdirSync(projCfgDir, { recursive: true });
    writeFileSync(
      join(projCfgDir, "config.json"),
      JSON.stringify({ models: { worker: "project-model" } })
    );

    try {
      process.env.OML_HOME = tempHome;
      const config = configModule.loadConfig(tempProject);

      assert(
        config.models.worker === "project-model",
        `expected models.worker "project-model", got "${config.models.worker}"`
      );
      assert(
        config.quiet_level === 1,
        `expected quiet_level 1 (from global), got ${config.quiet_level}`
      );
    } finally {
      if (origOmlHome !== undefined) {
        process.env.OML_HOME = origOmlHome;
      } else {
        delete process.env.OML_HOME;
      }
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(tempProject, { recursive: true, force: true });
    }
  });
}

// ============================================================
// Results
// ============================================================

console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
