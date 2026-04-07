#!/usr/bin/env node
"use strict";

/**
 * Hook runner for oh-my-link plugin.
 * Spawns compiled hook scripts (dist/hooks/*.js) using the current Node binary.
 * Handles stale CLAUDE_PLUGIN_ROOT paths and propagates exit codes.
 *
 * Usage: node run.cjs <path-to-hook-script.js> [args...]
 *
 * Resolution strategy:
 *   1. If target exists on disk → run it directly.
 *   2. If target does NOT exist AND CLAUDE_PLUGIN_ROOT is set:
 *      a. Walk up from CLAUDE_PLUGIN_ROOT to the cache parent directory.
 *      b. Scan sibling version directories (newest first) for the same
 *         relative path inside the plugin.
 *      c. If found → run the first match.
 *   3. If CLAUDE_PLUGIN_ROOT is NOT set (local dev):
 *      a. Resolve plugin root as the directory containing this script's parent
 *         (i.e., __dirname/..).
 *      b. Re-derive target using local plugin root and run if it exists.
 *   4. If nothing resolves → run the original target anyway and let Node
 *      produce the error (never silently swallow).
 */

const { execFileSync } = require("child_process");
const { existsSync, readdirSync } = require("fs");
const { join, dirname, resolve, relative, isAbsolute } = require("path");

/**
 * Attempt to find a working path for the target script.
 */
function resolveTarget(target) {
  // Fast path — target exists as given
  if (existsSync(target)) return target;

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

  // --- Strategy A: CLAUDE_PLUGIN_ROOT is set but stale (version drift) ---
  if (pluginRoot) {
    // Compute the relative portion of the target inside the plugin
    let rel = "";
    const normalTarget = resolve(target);
    const normalRoot = resolve(pluginRoot);

    if (normalTarget.startsWith(normalRoot)) {
      rel = relative(normalRoot, normalTarget);
    } else {
      // Target may already be relative
      rel = target;
    }

    if (rel) {
      // Scan sibling version directories (marketplace cache layout)
      const cacheParent = dirname(normalRoot);
      if (existsSync(cacheParent)) {
        try {
          const versions = readdirSync(cacheParent).sort().reverse();
          for (const ver of versions) {
            const candidate = join(cacheParent, ver, rel);
            if (existsSync(candidate)) return candidate;
          }
        } catch {
          // Fall through
        }
      }

      // Also try directly under the declared root (maybe just not built yet)
      const direct = join(normalRoot, rel);
      if (existsSync(direct)) return direct;
    }
  }

  // --- Strategy B: CLAUDE_PLUGIN_ROOT is NOT set (local dev) ---
  if (!pluginRoot) {
    // Infer plugin root from this script's location: scripts/run.cjs → parent is plugin root
    const localRoot = resolve(__dirname, "..");

    // If the target contains a recognisable plugin-internal path segment,
    // try re-rooting it under localRoot
    const markers = ["dist/hooks/", "dist\\hooks\\"];
    for (const marker of markers) {
      const idx = target.indexOf(marker);
      if (idx !== -1) {
        const rel = target.substring(idx);
        const candidate = join(localRoot, rel);
        if (existsSync(candidate)) return candidate;
      }
    }

    // Fallback: if target is a bare relative path, resolve against localRoot
    if (!isAbsolute(target)) {
      const candidate = join(localRoot, target);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Nothing resolved — return original (Node will error with MODULE_NOT_FOUND)
  return target;
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length === 0) {
  process.exit(0);
}

const target = resolveTarget(args[0]);
const scriptArgs = args.slice(1);

try {
  execFileSync(process.execPath, [target, ...scriptArgs], {
    stdio: "inherit",
    env: process.env,
    timeout: 60_000,
  });
} catch (err) {
  // Propagate exit code but never block Claude Code hooks
  const code = err.status ?? 0;
  process.exit(code);
}
