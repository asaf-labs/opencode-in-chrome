# Architecture

```text
OpenCode conversation
  └─ MCP stdio (session ID in ai.opencode/sessionID metadata)
      └─ stdio adapter → shared Node daemon, bound to 127.0.0.1
          └─ authenticated WebSocket /browser, protocol version 3 per opted-in profile
              └─ Chrome service worker
                  └─ session-owned tabs + isolated-world content scripts
```

## Modules

| Path                            | Responsibility                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `bridge/config.js`              | Validate/read/write local credentials; validate setup options                          |
| `bridge/setup.js`               | Generate credentials and print project-local MCP registration                          |
| `bridge/main.js`                | Start HTTP and stdio MCP transports; manage process shutdown                           |
| `bridge/shared-main.js`         | Start/reuse the daemon and expose stdio MCP for each project                           |
| `bridge/shared-process.js`      | Authenticated daemon discovery, race-safe startup, and port-conflict refusal           |
| `bridge/shared-client.js`       | Forward validated tool calls and cancellation to the shared daemon                     |
| `bridge/shared-server.js`       | Authenticated shared tool endpoint, fixed schemas, profile-aware routing, and shutdown |
| `bridge/http.js`                | Enforce loopback host/origin/token boundaries and validate handshakes                  |
| `bridge/hub.js`                 | Route sessions, track generations and pending calls, forward cancellation              |
| `bridge/tools.js`               | Fixed MCP schemas, descriptions, and result conversion                                 |
| `extension/background.js`       | Pairing/settings, authentication lifecycle, per-session command queues, Chrome events  |
| `extension/session-browser.js`  | Owned-tab lifecycle, persistence, generation checks, script execution, visual marking  |
| `extension/lifecycle.js`        | Idle-group collapse, opt-in URL archives, Keep, restore/delete, cleanup eligibility    |
| `extension/cleanup-settings.js` | Archive-delay validation, new defaults, and legacy opt-in migration                    |
| `extension/content.js`          | Page snapshots, scoped element refs, fixed DOM actions, orange overlay/cursor          |
| `extension/popup.*`             | Profile pairing/enable controls, cleanup opt-in, Keep, archive restore/delete          |

There is no build step, arbitrary page-evaluation tool, or conversation UI in the extension.

## Installation and release tools

`scripts/install.js` uses `installation.js` to validate an explicit target directory, bootstrap missing dependencies through npm, preserve local pairing settings, check conflicting listeners, and call OpenCode's registration CLI without rewriting project configuration. It copies the reusable installation skill into the target project's `.opencode/skills/` directory and refuses to overwrite a differing skill.

With `--global`, it registers `bridge/shared-main.js` globally and does not write a project-local skill. Package-runner installations use one user-wide permanent directory in global mode and per-project directories otherwise. The installed daemon path is always permanent, never the package-runner cache.

`scripts/pair.js` creates a private local pairing page from validated configuration. It opens through the operating system's default browser launcher with no shell interpolation. The user transfers the token into Chrome directly. `scripts/doctor.js` uses `diagnostics.js` for safe human/JSON reports; it does not log response bodies, account URLs, or tokens. `bridge/listen.js` supplies actionable startup errors for occupied ports and denied listeners.

`scripts/package.js` uses `archives.js` to build deterministic standalone-project and extension-only ZIPs plus checksums. A source allowlist excludes private/runtime directories; symlinks are rejected. Tagged releases run all platform checks before publication. Package/manifest/tag versions must agree.

## Connection lifecycle

1. The worker restricts storage to trusted extension contexts and restores session-owned tabs from `chrome.storage.session`. It starts suspended and invalidates old generations.
2. It connects to the configured loopback URL, rechecks website permission, and sends `hello` with the token, enabled preference, and ownership bindings.
3. The bridge checks host/origin, authenticates the token, and validates all ownership bindings before replacing a connected browser. It replies `ready`.
4. Only after `ready` echoes the expected profile ID does the worker enable controls. Named profiles use protocol 3 while browser access is enabled; protocol 2 is retained for a single legacy compatibility connection.
5. Disconnect suspends page controls, changes generations, rejects pending bridge calls, and schedules reconnection. Pairing changes also suspend controls before reconnecting.

Both modes support multiple authenticated browser-profile connections. In global mode, every project gets a stdio MCP adapter, and all adapters forward authenticated HTTP `/call` requests to one daemon. Concurrent startup attempts rely on exclusive loopback port binding: one daemon wins, and all adapters reuse its authenticated status. A mismatched token, standalone listener, or unrelated process is never terminated or replaced.

`bridge/profiles.js` maintains one `BrowserHub` per profile, isolates socket messages/results, and pins each conversation to a profile. The popup's protocol-3 handshake carries a persistent random profile ID and user label; protocol-2 extensions share one legacy compatibility connection. `bridge/profile-store.js` persists profile labels and conversation selections in the config directory's `profile-routing.json`, using serialized atomic writes and restrictive POSIX permissions. Reconnection of a different profile does not alter an existing selection, and offline/disabled selections never fall back. Commands wait for durable selection state; storage failure blocks actions. Profile selection cannot change during in-flight browser work. Named-profile refs add an outer `p<profileID>:` scope around the existing frame ref, and explicit numeric tab targets require matching profile context when profiles can overlap.

The daemon validates session metadata, fixed tool names and input schemas, and a 128 KiB request-body limit. Closing an adapter does not stop the daemon. Cancelling a call aborts its HTTP request; the response-close event aborts the corresponding BrowserHub action and forwards cancellation to Chrome. There is no automatic action retry. An authenticated `/shutdown` endpoint cancels pending work, closes Chrome, and stops the listener. Each new tool call checks daemon availability before dispatch, and the next call or adapter startup launches a fresh daemon if needed. The extension can restore session-owned bindings on reconnect; an early call fails safely until Chrome connects.

## Commands, cancellation, and refs

The content script's activity UI is separate from authorization. Chrome groups and the AI action badge remain persistent ownership markers; the page has no permanent banner. The main-frame dot appears during content actions, expands on click, and can be hidden per owned tab. Dot visibility is saved alongside temporary ownership records and applied before page actions and after navigation. Content-script messages may only hide the dot for their own verified owned tab; popup controls can show it again. Cursor/highlight layers stay pointer-transparent and fade when idle, independent of the dot. Only dot/panel buttons accept clicks, and shadow UI is excluded from page snapshots.

The bridge attaches a random request ID, session generation, and 25-second deadline. The worker queues commands per session; different sessions can run concurrently. SessionBrowser checks ownership and generation before work and after asynchronous boundaries. Content actions recheck enabled state, cancellation, snapshot revision, and DOM validity after the cursor animation before interaction.

`read_page` creates a fresh ref map. A monotonically increasing ref counter avoids accidentally reusing old names; snapshot revision checks also stop a pending action when a new snapshot replaces its map. Document IDs and URL checks prevent refs crossing documents or same-document navigation.

Snapshots now discover standard interactive ARIA roles, including custom multiselect options. Open popup controls are prioritized within each frame's 300-element cap. `extension/frame-refs.js` scopes child refs as `f<Chrome-frame-ID>:e<local-ref>` and combines snapshots without losing frame identity. A read of one frame refreshes only its refs; default reads cover all accessible frames. SessionBrowser tracks document IDs separately for each observed frame, without persisting stale routing across navigation or suspension.

Iframe mouse input remains a main-viewport browser action. Content scripts derive the frame's ancestry through cross-origin-safe WindowProxy identity, not page messages or DOM markers. Before pressing, the worker revalidates the target and projects its point through each containing frame, including borders and positive axis-aligned scaling. Each ancestor is hit-tested. Missing, navigated, covered, moved, or unsupported transformed frames fail closed. No new Chrome permission is required beyond existing script access and debugger input.

For `click`, the content script prepares viewport CSS coordinates from a visible, unobstructed client rectangle without calling `el.click()`. The worker validates the original ref, document, snapshot/control revisions, and hit target, acquires a debugger lease on the owned tab, and dispatches mouse movement. It revalidates after hover handlers before sending press/release, checks cancellation/generation/expiry between operations, and releases the lease in cleanup. A successful ordinary click debounces final detach for 30 seconds; authorized inspection/recording can retain the attachment with live leases. Attachment failures never fall back to DOM clicks. The result is `{ tabID, dispatched: true, applicationAccepted: null }`, not an application-state assertion. Once a press is attempted, errors warn that the page may already have changed; no retry is automatic. DOM validation and browser input remain separate operations, so page changes can still race dispatch.

MCP cancellation and timeouts send `cancel` to the worker. Queued work is marked cancelled; executing page interactions receive an extension message. Disable and disconnect notify all owned tabs. These are best-effort stops, not rollback: an already-issued Chrome call or network request may complete.

Bundled page actions, click/frame validation, recording conditions, and performance helpers catch their own exceptions inside the injected function, returning a small `opencodeError` envelope. The worker converts that envelope back to a normal tool failure. This avoids leaking expected refusals into Chrome's uncaught extension-error reporting while retaining the original message, cancellation/cleanup, pre-press guards, and post-press uncertain-outcome warning. Transport/permission/injection failures still reject normally. `test/page-errors.test.js` executes the actual injected callbacks in isolated VM contexts; the real-Chrome click regression also checks that a covered-target refusal does not escape as a script-evaluation exception.

## Persistence and trust

### Idle tab maintenance

The worker's 30-second reconnect alarm also schedules `TabLifecycle.sweep`. Maintenance runs only while the profile is connected/enabled, skips busy or paused sessions, and serializes with browser commands per session. Browser commands, owned-tab activation/navigation, and inherited tabs update the session's activity timestamp. Missing timestamps get a fresh grace period on worker restoration; inactivity is not proof that OpenCode has finished a conversation. There is no OpenCode session-status polling or conversation-archive event integration.

Retained recording plans and active inspection sessions also prevent idle cleanup between tool calls. Nested recorded actions use the parent step's session lock rather than recursively acquiring it. Explicit recording cancellation and inspection stop bypass the command queue/lock so they can interrupt pending attachment or capture.

After 15 minutes, inactive groups can collapse unless they contain active or non-owned tabs. Group marking is serialized per session and consolidates only verified owned tabs within each window; indicator updates never force groups open. With explicit popup opt-in, eligible tabs can be archived after the profile's configured `archiveAfterHours` delay (1–168 whole hours). The new default is 3; migration preserves 24 hours for profiles that had already opted into the old fixed rule. Settings mutations are serialized, validated, and persisted before the live cleanup preference changes. The sweep reads the current delay again before closing, so increasing it during archive persistence can prevent a close; invalid delays fail closed. Active, pinned, audible, loading, and Keep tabs are excluded. URL/title/session metadata is saved before removal, eligibility and ownership are checked again, and persistence failure prevents closing. These checks and Chrome removal are not atomic; unsaved page state cannot be detected reliably or restored.

Archives remain in the same Chrome profile. Restore creates an owned tab using the recorded session and current generation, requires the profile to be connected/enabled, and removes the saved record after opening. The popup can delete records without restoring them. Archive storage is capped at 1,000 entries; cleanup stops rather than evicting history. Crashes or uncertain closes can leave both a live tab and a saved URL. See [automatic cleanup](../README.md#automatic-tab-cleanup) and [security notes](../SECURITY.md#tab-cleanup-and-archives).

### Storage locations

- `.local/config.json`: token and port; ignored by Git.
- `.local/profile-routing.json`: opted-in profile IDs/labels and durable conversation selections; ignored by Git.
- `.local/mcp-config.json`: generated machine-specific OpenCode registration; ignored by Git.
- `chrome.storage.local`: pairing, profile identity/name, enabled/auto-archive preferences, and `tabArchives` URL/title/session records; restricted to trusted contexts and never synchronized across profiles.
- `chrome.storage.session`: temporary ownership, current tab, group IDs, generations, last activity, and Keep flags; cleared by a Chrome browser restart. Persistent URL archives do not restore ownership of existing tabs after that restart.
- Bridge memory: pending requests, routing bindings, and the last 100 activity summaries.

Session ownership is a tab-targeting boundary, not account isolation. Session IDs are trusted MCP routing metadata, not credentials. Page content is untrusted data. See [SECURITY.md](../SECURITY.md) for the complete threat model.

## Tab inspection

`bridge/inspection-tools.js` defines opt-in inspection and bounded network/console/profile tools. `extension/inspections.js` scopes event buffers to session/tab/generation, sanitizes captured metadata and invalidates IDs on navigation. `inspection-profiles.js` uses fixed CPU profiler commands and a bundled isolated-world PerformanceObserver helper, not global Chromium tracing. `inspection-privacy.js` bounds and redacts output.

`debugger-sessions.js` coordinates reference-counted attachments across clicks, recording and inspection, including pending-attach cancellation and detach invalidation. `bridge/inspection-artifacts.js` persists sanitized profiles/timelines at generated private local paths and returns only paths/summaries. See [inspection contract](inspection.md).

Only successful ordinary clicks request debounced release: when no other leases remain, schedule detach for 30 seconds later. The next acquisition cancels that timer and the next successful final click release resets it. A timer token prevents stale callbacks from closing a reacquired/new entry. Live leases always prevent idle detach; explicit inspection/recording releases and acquired click failures close the final attachment immediately. Clear/detach events cancel idle timers; suspend starts clearing before awaiting storage/UI work. No capture domains are enabled by retaining an idle click attachment. `test/debugger-sessions.test.js` covers debounce boundaries, reuse, live capture leases, safety cleanup, stale timers, and invalid generations/ownership.

The common tool layer adds profile routing to all 27 tools. Profile metadata is separated from strict artifact payload validation, then included in path/summary responses; recording cleanup after persistence carries its original profile ID. Captures never migrate when a conversation selects another Chrome profile. Stop/cancel before switching, or select the original profile explicitly to access retained data. Existing iframe action routing, pointer validation, per-tab activity-dot preferences, and configurable tab cleanup remain independent of capture.

## Verified recordings

`bridge/recording-tools.js` declares strict schemas for an immutable task plan and start/run/finish/cancel tools. `extension/recordings.js` scopes plans to a session-owned tab, checks ordered preconditions/postconditions, and accepts only verified segments. `recording-capture.js` temporarily attaches the debugger, captures bounded JPEG screencast frames, and shares its attachment with the existing guarded click path. Nested actions inherit parent cancellation and must stay in that same tab.

`recording-offscreen.js` receives authenticated extension-only encoding messages. `video-encoder.js` samples accepted segments onto a captioned canvas, encodes VP8 through WebCodecs, and `webm.js` builds the container with a deterministic timeline. `bridge/recording-artifacts.js` saves video/manifest into generated private `.local/recordings/` directories before returning only paths. No capture happens outside planned steps; excluded attempts are counted, not rolled back. See [recordings](recordings.md) for the contract and limitations.

## Verification

`test/lifecycle.test.js` covers grouping concurrency/collapse preservation, cleanup defaults, archive/restore/delete, Keep restoration, protected tabs, busy/disconnected/disabled sessions, personal group members, eligibility changes during persistence, and storage failure. Popup tests verify cleanup controls and inert rendering of page-provided titles.

`npm run check` runs lint, formatting, metadata checks, and automated tests. Tests cover authenticated transport with a real MCP client/server pair, session ownership with a simulated Chrome API, the worker readiness lifecycle, configuration validation, and DOM/cancellation behavior with jsdom. `CHROME_BINARY=/path/to/chrome npm run test:browser` uses an isolated real Chrome profile and local page to verify trusted pointer/mouse events and hit-testing. Its scripting/debugger adapter drives the same SessionBrowser click path through a test CDP connection; actual extension attachment and permission prompts still require the manual smoke test in [CONTRIBUTING.md](../CONTRIBUTING.md).
