## Summary
Three releases rolled into one (v0.9.3 - v0.9.5), fixing the core issues preventing OML from working reliably in production.

## v0.9.3 - Plain Stdout Injection
- keyword-detector now uses promptContextOutput() (plain text stdout) instead of hookOutput() (JSON additionalContext) for imperative prompts
- Per Claude Code docs, plain text stdout is the strongest injection mechanism - Claude actually follows the orchestration instructions
- All 3 prompt builders now include explicit "HOW TO SPAWN AN AGENT" section with Task tool parameters

## v0.9.4 - Session-Aware Role Inference
- Fixes critical phase skip bug: Claude Code's SubagentStart only sends 6 fields - description and prompt are empty
- detectRole() was mapping general-purpose to worker, causing phase to skip light_scout to light_execution
- Fix: New inferRoleFromSession() uses session phase + mode to infer the correct role when description is empty
- Performance confirmed: OML hooks take less than 100ms each; 14-minute sessions are 100% API latency

## v0.9.5 - HITL Gate UX
- Fixes gate freeze: Claude would cogitate 4+ minutes after presenting gate questions
- Gate prompts now say END YOUR RESPONSE IMMEDIATELY with waiting prompt
- Gate continuation: When user types answers, keyword-detector detects gate phase, injects rich continuation context with locked decisions + next steps
- Stop handler shows descriptive messages at gates (Waiting for your answers...)

## Test Results
- 394 tests passing across 20 test files (19/20 green, 1 pre-existing statusline timeout)

## Changed Files
- src/hooks/keyword-detector.ts - plain stdout, gate instructions, gate continuation logic
- src/hooks/subagent-lifecycle.ts - session-aware role inference
- src/hooks/stop-handler.ts - gate waiting messages
- src/helpers.ts - promptContextOutput() helper
- Tests updated across 4 files, 4 new tests added
