# Activate local updates on next use

Global/shared installations automatically activate **already-installed local code** on the next tool call or tool-list request. They do not fetch Git commits, install npm dependencies, change configuration, accept new Chrome permissions, or update another installation.

## One-time setup

This mechanism must itself be loaded once: update the checkout and dependencies, coordinate a shared-daemon restart, reload the unpacked extension in every participating profile, and reconnect `chrome` in OpenCode's `/mcps`. Older running code cannot safely upgrade itself retroactively. A profile without the update handshake needs that manual reload; the bridge will not force it.

After this setup, complete future checkout/package updates before using the tools. Local runtime-file fingerprints detect changes even when the package version is unchanged. README/docs-only changes do not restart browser access. Pairing tokens and private local state are not fingerprinted.

## What happens

1. A stable stdio supervisor checks runtime bytes on tool use and loads the latest adapter in a fresh subprocess when none of that adapter's requests are in flight. It sends MCP `tools/list_changed` after replacing the catalog. Clients must honor that notification; clients that cache catalogs indefinitely still need a manual MCP reconnect to discover newly named tools.
2. The adapter checks the authenticated shared daemon's installation identity and revision. It never shuts down a different checkout or an older daemon that cannot perform the safe-update handshake.
3. The daemon closes admission before checking every connected profile. In-flight requests, browser commands, tab cleanup, declared/retained recordings and inspection sessions defer activation. Finish/export/cancel retained captures or stop inspection normally; they are never discarded to make an update proceed. Ordinary existing actions remain available while an update is deferred.
4. All profiles must acknowledge readiness and save ownership before any reload is requested. The daemon then releases idle debugger attachments, requests extension reload only where extension bytes changed, and restarts. It waits for the participating profiles to reconnect with the expected extension revision before dispatching the waiting action. Disconnected profiles are checked when they next reconnect and tools are used.
5. After reconnection, ownership and explicit conversation/profile choices remain intact. Old document refs/focus tokens expire; take a fresh `read_page`. No browser action is automatically replayed after an uncertain response or interrupted dispatch.

New calls racing activation can receive an explicit “no action was dispatched” error. If a profile cannot reload/reconnect, inspect its popup and permissions; the waiting action is not sent. Source/storage/checkpoint failures defer or fail closed, rather than forcing an update. Code updates briefly interrupt all connected profiles in this shared installation, not just the conversation triggering activation.

## Tab ownership through an extension reload

Chrome may clear `chrome.storage.session` during extension reload. Immediately before a requested reload, the extension stores a **60-second, single-use** ownership checkpoint in trusted-context-only `chrome.storage.local`. It contains existing binding/tab metadata, Keep/indicator preferences and Chrome debugger target IDs for owned tabs only. It contains no page contents, cookies or pairing token. URLs/titles may be sensitive; never publish extension storage.

The expiry limits eligibility for restoration, not physical retention: if reload fails, the expired record is deleted on the next worker startup rather than necessarily at the 60-second mark.

On startup the checkpoint is consumed, and only tabs whose numeric tab ID **and native Chrome target ID** still match can be restored. A browser restart, recycled numeric ID, expired checkpoint, closed tab or identity mismatch cannot adopt an unrelated tab. Existing session ownership takes precedence over a checkpoint on an ordinary worker restart. The checkpoint is recovery state, not permanent tab archiving; archives and pairing/profile settings are unchanged.

Page helpers are reinjected by extension revision, not just the manually maintained content version. Same-version local code changes therefore replace stale helpers and invalidate their refs/tokens without navigating the website or losing unsaved page data.

## Limits and recovery

- This applies to global/shared mode, not legacy project-local bridge processes.
- Complete dependency installation first. A failed new adapter leaves the old adapter available, but does not run the attempted action or repeatedly replay it.
- An incompatible new manifest or permission prompt can still require user action. Automatic activation never enables a disabled profile, changes the selected account, or approves permissions.
- Manual fallback remains `npm run stop:shared`, extension reload, and MCP reconnect, coordinated with everyone using the shared daemon. Configuration/port/token changes still require that explicit workflow.
- Automated tests exercise the barrier, isolated daemon restarts, adapter/catalog replacement, cancellation and native-identity checkpoint recovery. Real signed-in profile reload and Chrome permission prompts require a disposable-profile manual smoke test; do not use production edits as upgrade diagnostics.
