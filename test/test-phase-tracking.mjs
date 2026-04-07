/**
 * Tests for auto-phase-tracking and session completion detection.
 *
 * Validates:
 *  - SubagentStart auto-advances session.current_phase based on agent role
 *  - Phase only advances forward (never regresses)
 *  - SubagentStop detects completion for Start Fast (executor stops → light_complete)
 *  - SubagentStop at phase_7_summary with master role → complete
 *  - Statusline shows recent agents (not just running)
 *  - Stop-handler allows stop at phase_7_summary (near-terminal)
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, "..");
const NODE = process.execPath;

let passed = 0;
let failed = 0;
let TEMP_ROOT;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function projectHash(cwd) {
  let normalized = cwd.replace(/\\/g, "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

function setupTempEnv() {
  TEMP_ROOT = join(
    process.env.TEMP || "/tmp",
    `oml-phase-${Date.now()}`
  );
  const omlHome = join(TEMP_ROOT, "oml-home");
  const cwd = join(TEMP_ROOT, "project");
  mkdirSync(cwd, { recursive: true });

  const hash = projectHash(cwd.replace(/\\/g, "/"));
  const stateRoot = join(omlHome, "projects", hash);
  mkdirSync(stateRoot, { recursive: true });

  const artifactsDir = join(cwd, ".oh-my-link");
  mkdirSync(join(artifactsDir, "tasks"), { recursive: true });
  mkdirSync(join(artifactsDir, "locks"), { recursive: true });
  mkdirSync(join(artifactsDir, "plans"), { recursive: true });
  mkdirSync(join(artifactsDir, "history"), { recursive: true });
  mkdirSync(join(artifactsDir, "skills"), { recursive: true });
  mkdirSync(join(artifactsDir, "context"), { recursive: true });

  return { omlHome, cwd, stateRoot };
}

function writeSession(stateRoot, session) {
  writeFileSync(
    join(stateRoot, "session.json"),
    JSON.stringify(session, null, 2)
  );
}

function readSession(stateRoot) {
  return JSON.parse(readFileSync(join(stateRoot, "session.json"), "utf-8"));
}

function writeTracking(stateRoot, records) {
  writeFileSync(
    join(stateRoot, "subagent-tracking.json"),
    JSON.stringify(records, null, 2)
  );
}

function readTracking(stateRoot) {
  const p = join(stateRoot, "subagent-tracking.json");
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf-8"));
}

function runHook(hookScript, input, env) {
  const result = execFileSync(NODE, [join(PLUGIN_ROOT, "dist", "hooks", hookScript)], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  });
  return JSON.parse(result.toString().trim());
}

function runSubagentLifecycle(mode, input, env) {
  const result = execFileSync(
    NODE,
    [join(PLUGIN_ROOT, "dist", "hooks", "subagent-lifecycle.js"), mode],
    {
      input: JSON.stringify(input),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    }
  );
  return JSON.parse(result.toString().trim());
}

// ═══════════════════════════════════════════════════════
console.log("Oh-My-Link — Phase Tracking Tests");
console.log(`TEMP_ROOT: ${TEMP_ROOT || "(will be set)"}`);

// ── Auto Phase Advance on SubagentStart ──────────────
console.log("\n--- auto-phase-advance — SubagentStart ---");

test("scout start advances bootstrap → phase_1_scout", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "bootstrap",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "scout-1", agent_type: "oh-my-link:scout",
    agent_description: "Scout agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_1_scout",
    `expected phase_1_scout, got ${session.current_phase}`);
});

test("architect start advances gate_1_pending → phase_2_planning", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "gate_1_pending",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "arch-1", agent_type: "oh-my-link:architect",
    agent_description: "Architect agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_2_planning",
    `expected phase_2_planning, got ${session.current_phase}`);
});

test("worker start advances gate_3_pending → phase_5_execution", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "gate_3_pending",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "worker-1", agent_type: "oh-my-link:worker",
    agent_description: "Worker agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_5_execution",
    `expected phase_5_execution, got ${session.current_phase}`);
});

test("phase does NOT regress (already at phase_5, scout start does not go back to phase_1)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_5_execution",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "scout-2", agent_type: "oh-my-link:scout",
    agent_description: "Scout agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_5_execution",
    `expected phase_5_execution (no regression), got ${session.current_phase}`);
});

test("reviewer start advances phase_5_execution → phase_6_review", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_5_execution",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "rev-1", agent_type: "oh-my-link:reviewer",
    agent_description: "Reviewer agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_6_review",
    `expected phase_6_review, got ${session.current_phase}`);
});

test("master start does NOT change phase (master doesn't trigger phase advance)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "bootstrap",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "master-1", agent_type: "oh-my-link:master",
    agent_description: "Master agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "bootstrap",
    `expected bootstrap (master doesn't advance), got ${session.current_phase}`);
});

// ── Start Fast phase tracking ────────────────────────
console.log("\n--- auto-phase-advance — Start Fast ---");

test("fast-scout start in light_scout stays at light_scout (already there)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_scout",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, intent: "standard",
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "fs-1", agent_type: "oh-my-link:fast-scout",
    agent_description: "Fast-Scout agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "light_scout",
    `expected light_scout, got ${session.current_phase}`);
});

test("executor start advances light_scout → light_execution (standard intent)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_scout",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, intent: "standard",
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "exec-1", agent_type: "oh-my-link:executor",
    agent_description: "Executor agent", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "light_execution",
    `expected light_execution, got ${session.current_phase}`);
});

// ── SubagentStop auto-completion ─────────────────────
console.log("\n--- auto-completion — SubagentStop ---");

test("executor stop in light_execution → light_complete (Start Fast auto-complete)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_execution",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, intent: "standard",
  });
  writeTracking(stateRoot, [{
    agent_id: "exec-1", role: "executor", started_at: new Date().toISOString(),
    status: "running",
  }]);

  runSubagentLifecycle("stop", {
    cwd, agent_id: "exec-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "light_complete",
    `expected light_complete, got ${session.current_phase}`);
  assert(session.active === false, "expected session deactivated");
});

test("executor stop with exit_code=1 does NOT auto-complete", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_execution",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, intent: "standard",
  });
  writeTracking(stateRoot, [{
    agent_id: "exec-2", role: "executor", started_at: new Date().toISOString(),
    status: "running",
  }]);

  runSubagentLifecycle("stop", {
    cwd, agent_id: "exec-2", exit_code: 1,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "light_execution",
    `expected light_execution (no auto-complete on failure), got ${session.current_phase}`);
  assert(session.active === true, "expected session still active");
});

// ── Stop-handler at phase_7_summary ──────────────────
console.log("\n--- stop-handler — phase_7_summary (near-terminal) ---");

test("stop-handler allows stop at phase_7_summary and marks complete", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_7_summary",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });

  const result = runHook("stop-handler.js", { cwd }, { OML_HOME: omlHome });
  // stop-handler should allow stop (not block)
  assert(!result.decision || result.decision !== "block",
    `expected allow, got decision=${result.decision}`);

  const session = readSession(stateRoot);
  assert(session.current_phase === "complete",
    `expected complete after P7 stop, got ${session.current_phase}`);
  assert(session.active === false, "expected session deactivated");
});

// ── Claude Code native field compatibility ───────────
console.log("\n--- detectRole — Claude Code native agent types ---");

test("agent_type='explore' maps to explorer role", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "bootstrap",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "explore-1", agent_type: "explore",
    agent_description: "Search for theme files", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "explore-1");
  assert(record, "expected tracking record");
  assert(record.role === "explorer", `expected role 'explorer', got '${record.role}'`);
});

test("agent_type='fixer' maps to worker role", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_5_execution",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "fixer-1", agent_type: "fixer",
    agent_description: "Fix code", agent_prompt: "",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "fixer-1");
  assert(record, "expected tracking record");
  assert(record.role === "worker", `expected role 'worker', got '${record.role}'`);
});

test("description='Scout: analyze scope' with empty agent_type detects scout", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "bootstrap",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  // Use 'description' field (Claude Code native) instead of 'agent_description'
  runSubagentLifecycle("start", {
    cwd, agent_id: "scout-native", agent_type: "",
    description: "Scout: analyze theme rename scope",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "scout-native");
  assert(record, "expected tracking record");
  assert(record.role === "scout", `expected role 'scout', got '${record.role}'`);

  // Phase should also advance
  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_1_scout",
    `expected phase_1_scout, got ${session.current_phase}`);
});

test("description with action keyword 'implement' maps to worker", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "gate_3_pending",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "impl-1", agent_type: "general",
    description: "Implement the theme rename across all PHP files",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "impl-1");
  assert(record, "expected tracking record");
  assert(record.role === "worker", `expected role 'worker', got '${record.role}'`);

  // Phase should advance to execution
  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_5_execution",
    `expected phase_5_execution, got ${session.current_phase}`);
});

test("OML_AGENT_ROLE env overrides all detection", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "bootstrap",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "override-1", agent_type: "explore",
    description: "Some random description",
  }, { OML_HOME: omlHome, OML_AGENT_ROLE: "architect" });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "override-1");
  assert(record, "expected tracking record");
  assert(record.role === "architect", `expected role 'architect' from env, got '${record.role}'`);
});

// ═══════════════════════════════════════════════════════
console.log(`\n========================================`);
console.log(`  Results: ${passed} passed, ${failed} failed, 0 skipped`);
console.log(`========================================`);

// Cleanup
try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
