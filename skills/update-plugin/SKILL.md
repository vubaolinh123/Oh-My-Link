---
name: update-plugin
description: Check for and apply Oh-My-Link plugin updates — compares installed version, shows changelog, re-runs setup after update
---

<Purpose>
Detect whether a newer version of Oh-My-Link is available and apply it if the
user confirms. After update, re-runs the setup wizard to ensure hooks and configs
are in sync with the new version.
</Purpose>

<Use_When>
- User says `update oml` or `update oh-my-link`
- After receiving a notification that a new version is available
- Periodic maintenance to keep the plugin current
</Use_When>

<Steps>

## Step 1 — Read current version

Read `.claude-plugin/plugin.json` from the plugin root (the directory containing
this skills/ folder).

Extract `version` field. Example: `"0.1.0"`.

If file missing: FAIL with "Cannot find plugin.json. Is Oh-My-Link installed?"

## Step 2 — Locate update source

Check `.claude-plugin/marketplace.json` for `update_url` or `repository` field.
This determines where to fetch the remote version from.

If `update_url` is a git remote: use `git ls-remote` to check the latest tag.
If `update_url` is an HTTP endpoint: use `curl -s <url>` to fetch version JSON.
If neither is available: WARN "No update source configured. Cannot check for updates."

## Step 3 — Compare versions

Parse both local version and remote version as semver (major.minor.patch).
If remote > local: update available. Show:
  "Update available: v{local} → v{remote}"

If remote == local: "Already on latest version ({local}). No update needed." Exit.
If remote < local: "Local version ({local}) is ahead of remote ({remote}). No action taken." Exit.

## Step 4 — Show changelog

If update available, attempt to fetch `CHANGELOG.md` or release notes from the
remote source. Display the changes between current and target version.

If changelog unavailable: "Changelog not available for this update source."

## Step 5 — Confirm with user

Present: "Apply update to v{remote}? This will overwrite plugin files. [y/N]"

Do NOT proceed without explicit confirmation.

## Step 6 — Apply update

Depending on update source:
- Git remote: `git pull` or `git fetch && git checkout <tag>` in plugin root
- HTTP download: download archive, extract to plugin root, preserve user config files

After applying files: run `npm install && npm run build` to rebuild TypeScript.

## Step 7 — Re-run setup wizard

Load and invoke the `setup` skill to validate hooks and configs are aligned with
the new version. This ensures any new hook events or config fields are applied.

## Step 8 — Confirm completion

Report:
"Oh-My-Link updated to v{remote}.
  Build: success
  Setup: re-validated
  Restart your Claude Code session to activate the new hooks."

</Steps>

<Tool_Usage>
- Read: .claude-plugin/plugin.json, .claude-plugin/marketplace.json
- Bash: git ls-remote, curl, npm install, npm run build
- Skill: invoke setup after update completes
- No external coordination service required
</Tool_Usage>
