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

// ── Start Link HITL Gate transitions on SubagentStop ─
console.log("\n--- HITL gates — SubagentStop transitions ---");

test("scout stop in phase_1_scout (no CONTEXT.md) → gate_1_pending + awaiting", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_1_scout",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "scout-1", role: "scout", started_at: new Date().toISOString(),
    status: "running",
  }]);

  runSubagentLifecycle("stop", {
    cwd, agent_id: "scout-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "gate_1_pending",
    `expected gate_1_pending, got ${session.current_phase}`);
  assert(session.awaiting_confirmation === true,
    "expected awaiting_confirmation=true");
});

test("scout stop in gate_1_pending (CONTEXT.md exists) → phase_2_planning", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeFileSync(join(cwd, ".oh-my-link", "plans", "CONTEXT.md"), "# locked decisions\n");
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "gate_1_pending",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "scout-2", role: "scout", started_at: new Date().toISOString(),
    status: "running",
  }]);

  runSubagentLifecycle("stop", {
    cwd, agent_id: "scout-2", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_2_planning",
    `expected phase_2_planning, got ${session.current_phase}`);
  assert(session.awaiting_confirmation === false,
    "expected awaiting_confirmation=false after synthesis");
});

test("architect stop in phase_2_planning (plan.md exists) → gate_2_pending + awaiting", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeFileSync(join(cwd, ".oh-my-link", "plans", "plan.md"), "# implementation plan\n");
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_2_planning",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "arch-1", role: "architect", started_at: new Date().toISOString(),
    status: "running",
  }]);

  runSubagentLifecycle("stop", {
    cwd, agent_id: "arch-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "gate_2_pending",
    `expected gate_2_pending, got ${session.current_phase}`);
  assert(session.awaiting_confirmation === true,
    "expected awaiting_confirmation=true");
});

test("verifier stop in phase_4_validation → gate_3_pending + awaiting", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_4_validation",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "ver-1", role: "verifier", started_at: new Date().toISOString(),
    status: "running",
  }]);

  runSubagentLifecycle("stop", {
    cwd, agent_id: "ver-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "gate_3_pending",
    `expected gate_3_pending, got ${session.current_phase}`);
  assert(session.awaiting_confirmation === true,
    "expected awaiting_confirmation=true");
});

test("regression: stop-handler ALLOWS stop at gate_1_pending after scout stop (no spin loop)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_1_scout",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "scout-x", role: "scout", started_at: new Date().toISOString(),
    status: "running",
  }]);

  // 1. Scout finishes Exploration mode → SubagentStop should set Gate 1 awaiting
  runSubagentLifecycle("stop", {
    cwd, agent_id: "scout-x", exit_code: 0,
  }, { OML_HOME: omlHome });

  // 2. Master tries to stop → stop-handler should ALLOW (not block with reinforcement)
  const result = runHook("stop-handler.js", { cwd }, { OML_HOME: omlHome });
  assert(!result.decision || result.decision !== "block",
    `expected allow at gate_1, got decision=${result.decision} reason="${result.reason || ''}"`);
  assert((result.reason || "").toLowerCase().includes("waiting for"),
    `expected gate-waiting message, got "${result.reason || ''}"`);
});

// ── Review→Fix loop ──────────────────────────────────
console.log("\n--- review→fix loop — SubagentStop ---");

function writeReview(cwd, fileName, verdict) {
  const reviewsDir = join(cwd, ".oh-my-link", "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(join(reviewsDir, fileName),
    `# Review for ${fileName}\n\nVERDICT: ${verdict}\n\nDetails here.\n`);
}

test("reviewer FAIL at phase_6_review → regress to phase_5 + revision_count++", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_6_review",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "rev-fail-1", role: "reviewer", started_at: new Date().toISOString(),
    status: "running",
  }]);
  writeReview(cwd, "link-1.review.md", "FAIL");

  runSubagentLifecycle("stop", {
    cwd, agent_id: "rev-fail-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_5_execution",
    `expected phase_5_execution after FAIL, got ${session.current_phase}`);
  assert(session.revision_count === 1,
    `expected revision_count=1, got ${session.revision_count}`);
  assert(session.awaiting_confirmation !== true,
    "should NOT be awaiting on first FAIL");
});

test("reviewer FAIL on 3rd revision → circuit-break with awaiting_confirmation", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_6_review",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 2, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "rev-fail-3", role: "reviewer", started_at: new Date().toISOString(),
    status: "running",
  }]);
  writeReview(cwd, "link-2.review.md", "FAIL");

  runSubagentLifecycle("stop", {
    cwd, agent_id: "rev-fail-3", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.revision_count === 3, `expected revision_count=3, got ${session.revision_count}`);
  assert(session.awaiting_confirmation === true, "expected circuit-break to set awaiting=true");
  assert(session.current_phase === "phase_6_review",
    `expected phase to stay at phase_6_review on circuit-break, got ${session.current_phase}`);
});

test("reviewer PASS at phase_6_review → advance to phase_6_5 (existing behavior preserved)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_6_review",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "rev-pass-1", role: "reviewer", started_at: new Date().toISOString(),
    status: "running",
  }]);
  writeReview(cwd, "link-3.review.md", "PASS");

  runSubagentLifecycle("stop", {
    cwd, agent_id: "rev-pass-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_6_5_full_review",
    `expected phase_6_5_full_review on PASS, got ${session.current_phase}`);
  assert(session.revision_count === 0, "PASS should not bump revision_count");
});

test("reviewer MINOR at phase_6_review → advance (treated as PASS for loop logic)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_6_review",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, awaiting_confirmation: false,
  });
  writeTracking(stateRoot, [{
    agent_id: "rev-minor-1", role: "reviewer", started_at: new Date().toISOString(),
    status: "running",
  }]);
  writeReview(cwd, "link-4.review.md", "MINOR");

  runSubagentLifecycle("stop", {
    cwd, agent_id: "rev-minor-1", exit_code: 0,
  }, { OML_HOME: omlHome });

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_6_5_full_review",
    `expected phase_6_5_full_review on MINOR, got ${session.current_phase}`);
  assert(session.revision_count === 0, "MINOR should not bump revision_count");
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

// ── Implicit HITL gate detection (transcript-based) ──
console.log("\n--- stop-handler — implicit HITL detection ---");

function writeTranscript(cwd, lastAssistantText) {
  const transcriptPath = join(cwd, "transcript.jsonl");
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: "do something" } }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: lastAssistantText }],
      },
    }),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n");
  return transcriptPath;
}

test("light_execution + orchestrator asks Sequential/Parallel + no running agent → ALLOW", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_execution",
    started_at: new Date().toISOString(), reinforcement_count: 1,
    failure_count: 0, revision_count: 0, intent: "standard",
  });
  writeTracking(stateRoot, []);
  // Pending task exists (Master prepared workers, then paused for HITL choice).
  // Without it, orphan auto-complete fires before HITL detection.
  const tasksDir = join(cwd, ".oh-my-link", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "phase-1.json"), JSON.stringify({
    link_id: "phase-1", title: "PWA-1", status: "pending",
    acceptance_criteria: [], file_scope: [], depends_on: [],
  }));
  const transcriptPath = writeTranscript(cwd,
    "Vui lòng trả lời: Sequential hay Parallel? Choose execution mode: Sequential or Parallel?");

  const result = runHook("stop-handler.js",
    { cwd, transcript_path: transcriptPath },
    { OML_HOME: omlHome });

  assert(!result.decision || result.decision !== "block",
    `expected ALLOW for HITL question, got decision=${result.decision} reason="${result.reason || ''}"`);
  assert((result.reason || "").toLowerCase().includes("waiting"),
    `expected waiting message, got "${result.reason || ''}"`);
});

test("light_execution + plain narration (no question) + running agent → still BLOCKS", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_execution",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0, intent: "standard",
  });
  // Pretend an executor is still running so orphan path doesn't fire.
  writeTracking(stateRoot, [{
    agent_id: "exec-running",
    role: "executor",
    started_at: new Date().toISOString(),
    status: "running",
  }]);
  const transcriptPath = writeTranscript(cwd,
    "Implementing the change. Edited foo.ts and bar.ts. No errors.");

  const result = runHook("stop-handler.js",
    { cwd, transcript_path: transcriptPath },
    { OML_HOME: omlHome });

  assert(result.decision === "block",
    `expected BLOCK without question pattern, got decision=${result.decision}`);
});

test("phase_5_execution Start Link + question + no running agent → ALLOW (works for mylink too)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "phase_5_execution",
    started_at: new Date().toISOString(), reinforcement_count: 2,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);
  // Need at least one pending task so orphan auto-complete doesn't fire first.
  const tasksDir = join(cwd, ".oh-my-link", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "link-1.json"), JSON.stringify({
    link_id: "link-1", title: "x", status: "pending",
    acceptance_criteria: [], file_scope: [], depends_on: [],
  }));
  const transcriptPath = writeTranscript(cwd,
    "⏳ Đang ở Gate 3 (HITL hard-gate). Vui lòng trả lời: Sequential hay Parallel?");

  const result = runHook("stop-handler.js",
    { cwd, transcript_path: transcriptPath },
    { OML_HOME: omlHome });

  assert(!result.decision || result.decision !== "block",
    `expected ALLOW for HITL question, got decision=${result.decision} reason="${result.reason || ''}"`);
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

// ── Session-Aware Role Inference ─────────────────────
// When Claude Code sends agent_type="general-purpose" with no description/prompt,
// OML should infer the correct role from session phase + mode.
console.log("\n--- session-aware role inference — empty description ---");

test("general-purpose in light_scout inferred as fast-scout (standard intent)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_scout",
    intent: "standard",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  // Simulate what Claude Code actually sends: general-purpose, no description, no prompt
  runSubagentLifecycle("start", {
    cwd, agent_id: "infer-1", agent_type: "general-purpose",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "infer-1");
  assert(record, "expected tracking record");
  assert(record.role === "fast-scout", `expected role 'fast-scout', got '${record.role}'`);

  // Phase should NOT advance past light_scout (fast-scout stays there)
  const session = readSession(stateRoot);
  assert(session.current_phase === "light_scout",
    `expected light_scout, got ${session.current_phase}`);
});

test("general-purpose in light_scout inferred as executor (turbo intent)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_scout",
    intent: "turbo",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "infer-2", agent_type: "general-purpose",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "infer-2");
  assert(record, "expected tracking record");
  assert(record.role === "executor", `expected role 'executor', got '${record.role}'`);

  // Phase should advance to light_turbo for turbo intent
  const session = readSession(stateRoot);
  assert(session.current_phase === "light_turbo",
    `expected light_turbo, got ${session.current_phase}`);
});

test("general-purpose in bootstrap inferred as scout (Start Link)", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylink", current_phase: "bootstrap",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  runSubagentLifecycle("start", {
    cwd, agent_id: "infer-3", agent_type: "general-purpose",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "infer-3");
  assert(record, "expected tracking record");
  assert(record.role === "scout", `expected role 'scout', got '${record.role}'`);

  const session = readSession(stateRoot);
  assert(session.current_phase === "phase_1_scout",
    `expected phase_1_scout, got ${session.current_phase}`);
});

test("general-purpose with explicit description still uses description detection", () => {
  const { omlHome, cwd, stateRoot } = setupTempEnv();
  writeSession(stateRoot, {
    active: true, mode: "mylight", current_phase: "light_scout",
    intent: "standard",
    started_at: new Date().toISOString(), reinforcement_count: 0,
    failure_count: 0, revision_count: 0,
  });
  writeTracking(stateRoot, []);

  // When description is present, normal detection should work (not session inference)
  runSubagentLifecycle("start", {
    cwd, agent_id: "infer-4", agent_type: "general-purpose",
    description: "[OML:executor] Implement fix from BRIEF.md",
  }, { OML_HOME: omlHome });

  const tracking = readTracking(stateRoot);
  const record = tracking.find(a => a.agent_id === "infer-4");
  assert(record, "expected tracking record");
  assert(record.role === "executor", `expected role 'executor' from OML tag, got '${record.role}'`);
});

// ═══════════════════════════════════════════════════════
console.log(`\n========================================`);
console.log(`  Results: ${passed} passed, ${failed} failed, 0 skipped`);
console.log(`========================================`);

// Cleanup
try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
