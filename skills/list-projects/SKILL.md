---
name: list-projects
description: List all workspaces registered with Oh-My-Link, showing project name, path, last used, and active session status
level: 1
model: claude-sonnet-4-6
trigger: "oml list|list oml|oml projects"
---

<Purpose>
Display all workspaces that Oh-My-Link has been used in. Reads the global project registry
at `~/.oh-my-link/projects/registry.json` and presents a formatted table with status info.
</Purpose>

<Use_When>
- User says "oml list", "list oml", or "oml projects"
- User wants to see which workspaces are managed by OML
- User wants to check active sessions across workspaces
</Use_When>

<Steps>

## 1. Read Registry

Read `~/.oh-my-link/projects/registry.json`.

**If file does not exist or is empty:**
> "No workspaces registered yet. Open Claude Code in any project and OML will auto-register it."

## 2. Refresh Session Status

For each project entry, check `~/.oh-my-link/projects/{hash}/session.json`:
- If `active === true` → mark as active, show mode and phase
- Otherwise → mark as inactive

## 3. Display Table

Output a formatted table:

```
OML Registered Workspaces
========================

| # | Project      | Path                    | Last Used   | Status          |
|---|--------------|-------------------------|-------------|-----------------|
| 1 | my-app       | D:/Projects/my-app      | 2h ago      | Active (Link/P3)|
| 2 | oh-my-link   | D:/Oh-My-Link           | 1d ago      | Idle            |
| 3 | website      | D:/Projects/website     | 3d ago      | Idle            |

Total: 3 workspaces | 1 active session
```

**Time formatting:**
- < 1 hour: "{minutes}m ago"
- < 24 hours: "{hours}h ago"  
- < 7 days: "{days}d ago"
- Otherwise: date string (e.g., "Mar 28")

**Status formatting:**
- Active session: "Active ({mode}/{phase})" where mode is Link or Fast
- No active session: "Idle"

</Steps>
