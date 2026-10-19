---
name: Install OpenCode in Chrome
description: Install, pair, diagnose, or repair the opencode-in-chrome MCP browser extension for an OpenCode project. Use when a user wants automatic session-owned Chrome tabs or sees chrome Connection closed.
license: MIT
---

# Install OpenCode in Chrome

## Outcome

Register `chrome` MCP in the user's chosen project, help the user complete Chrome pairing locally, and verify both MCP and browser readiness. Keep the conversation in OpenCode. The extension has no session picker or manual tab adoption.

## Workflow

1. Determine whether the user wants **project-local** or **global shared** access, and choose a permanent **extension checkout directory**. Global mode serves every OpenCode project with one daemon. Inspect existing `chrome` registration first; its `command` may identify an installed checkout. Preserve unrelated configuration and user files.
2. Check `node --version` (24+) and `opencode --version` (V2). If missing, guide installation from `https://nodejs.org/` and `https://opencode.ai/v2/docs/`. Do not guess V1 configuration shapes.
3. If no checkout exists, clone `https://github.com/asaf-labs/opencode-in-chrome.git` into the chosen permanent directory. Read its README and SECURITY.md. If it already exists, inspect local changes before updating it.
4. From that checkout, run:

   ```sh
    npm run install:opencode -- --project "/absolute/path/to/target-project"
   ```

   For all projects, use `npm run install:opencode -- --global` instead. Do not combine `--global` and `--project`. On Windows, use `npm.cmd` if PowerShell blocks `npm`. The installer installs missing dependencies, generates/preserves private pairing settings, and registers MCP through OpenCode's CLI. Project-local mode copies this skill into the target project. Its output does **not** include the token or silently add approval rules.

5. If another bridge occupies the port, identify the owner and ask before disconnecting it. One extension connects to one bridge. Global mode uses `bridge/shared-main.js`; registering standalone `bridge/main.js` globally does not make it shared. Project-local entries override global configuration: ask before removing an obsolete local entry. Use `--port 8791` only when appropriate and update the popup URL. Stopping a shared daemon affects all its projects; never do so without authorization.
6. Run `npm run pair` from the checkout. This opens a **local, private pairing page**. Do not read its HTML, `.local/config.json`, or the clipboard into agent context. Do not screenshot that page. The user copies the token directly into the extension popup.
7. Guide the user through the Chrome-only steps: dedicated profile → `chrome://extensions` → Developer mode → Load unpacked → checkout's `extension/` → popup → URL/token → Save & enable browser → website permission. Do not claim these steps completed without confirmation.
8. Run `opencode mcp list` from the target project and `npm run doctor` from the checkout. Doctor prints only safe summaries. `--json` provides a machine-readable report; exit 0 means fully ready, exit 1 means attention needed. MCP connected is not proof Chrome is paired/enabled.
9. Offer to merge `examples/permissions.jsonc` into existing project permissions for supervised actions. Preserve rule order and explain later-rule/saved-approval effects. Never replace the entire config with the example.
10. Once ready, perform an authorized public-page smoke action: create a tab, read it, and report the observed result. Use actual MCP tools with OpenCode-supplied session metadata; never fabricate IDs or element refs.

## Multiple profiles

Chrome requires the extension to be installed/loaded separately in each participating regular profile. Use the same bridge URL and private pairing token, set a profile name in each popup, and choose Save & enable browser. New/unpaired profiles are not discoverable. Names and IDs are routing metadata, not proof of account identity.

Use `list_profiles` before account-sensitive browser work. When multiple profiles are registered, ask the user which to use and call `select_profile` with its returned ID. Do not choose another account because the intended profile is disconnected or disabled. Choices survive daemon restarts. Include `profileID` alongside explicit numeric `tabID` when multiple profiles exist, and pass the complete profile-scoped refs from snapshots unchanged. Disabling one profile does not affect the others.

After upgrading, restart the updated daemon, reload/name/enable each extension instance, and reconnect MCP adapters for the new tools. A legacy connection cannot distinguish multiple old profile copies; upgrade each copy. Never clone profile-local extension storage or clear saved routing history as a routine repair.

## Tab cleanup

After extension changes, have the user reload the correct unpacked extension in each opted-in profile. No new permissions or pairing-token changes are required for tab cleanup. Inactive groups collapse after 15 minutes; manual collapse survives indicator refreshes. This uses browser activity, not OpenCode session-status polling or conversation-archive events.

Automatic closing is off by default. Do not enable it on the user's behalf during installation. If requested, explain that the popup's Archive after (hours) setting accepts 1–168 whole hours, defaults to 3, and saves automatically per profile. Already-enabled legacy profiles retain 24 hours until changed. Shortening the delay can close already-idle eligible tabs on the next check. Archiving saves URLs locally before closing eligible owned tabs, not unsaved forms or page state. Active, pinned, audible, loading, and Keep tabs are skipped; disconnected/disabled profiles never initiate cleanup. The popup offers Keep, Restore, and Delete saved URL. Restoration stays in the same connected/enabled profile. Do not inspect or export private archive URLs as installation diagnostics. See the checkout's README and SECURITY.md for limits and race caveats.

## Repairs

- **Chrome debugging banner flickers between clicks:** current code reuses the attachment and debounces idle detach for 30 seconds after successful ordinary clicks. Reload the updated extension worker to activate this; no new permissions or MCP catalog changes are required. Chrome's native banner cannot be hidden while attached. Cancel ends that attachment, while Disable this profile stops access; future explicit clicks can attach again after Cancel.

- **Missing recording/inspection tools after upgrade:** the current catalog has 27 tools. Reload the extension in each opted-in profile and approve the added offscreen permission if prompted. A shared daemon must be restarted to load the new catalog; coordinate and obtain authorization before stopping it because every project/profile using it is interrupted. Reconnect MCP adapters afterward. Capture remains explicit; do not enable network bodies or start recording as an installation diagnostic on a private page. See docs/inspection.md and docs/recordings.md for profile-aware workflows, privacy limits, and the separate manual extension smoke test.

- **Page activity indicator is distracting:** click the orange dot, then Hide for this tab. To restore it, use Show page activity dot under that owned tab in the extension popup. This hides only the dot/status panel, not automation or its cursor; use Disable this profile to stop browser access. Chrome tab groups and the AI badge remain visible. There is no permanent page banner in the current extension; reload the correct unpacked extension if an old banner persists.

- **Missing script: setup:** commands ran in the target application. Run installation/setup from the extension checkout; MCP registration belongs in the target project.
- **Connection closed:** inspect `npm run doctor`, Node/bridge paths, dependencies, and port ownership. An older project's bridge may still run inside the OpenCode service after its terminal closes.
- **MCP connected but Chrome disconnected:** user checks profile, unpacked extension path, URL/token locally, and permission prompt; reconnect/reload as appropriate.
- **Timeout after an interaction:** inspect current page state before retrying; cancellation cannot undo a completed action.

Read the checkout's README for exact tools and recovery commands. No build step is required. Never commit `.local/`, pairing files, private browser data, or machine-specific credentials.
