# Network, console and performance inspection

Inspection is explicit and restricted to a session-owned HTTP/HTTPS tab. It does not adopt personal tabs, attach child targets, intercept requests, expose arbitrary CDP, evaluate arbitrary page code, or read cookies/storage directly. The debugger permission already used for guarded clicks is sufficient; no additional manifest permission is added.

## Workflow

First call `list_profiles` and `select_profile` for the intended Chrome account/profile. All inspection tools accept `profileID`; include the selected profile's ID with explicit `tabID` when multiple profiles are registered. Inspection remains attached to its original profile/tab, never follows a profile selection, and is not automatically stopped just by switching the conversation's profile. Stop it before switching, or explicitly select the original profile to stop it later. Its five-minute expiry still applies; disabling/disconnecting the original profile discards its captures. Active inspection sessions are excluded from idle tab cleanup.

1. Use `open_tab`/`list_tabs` to get the explicit owned `tabID`.
2. Call `start_inspection({ tabID })` before reproducing the issue. Historical console messages and traffic are not returned. Set `captureBodies: true` only if reading potentially sensitive request/response content is authorized.
3. Reproduce using existing browser tools or manual interaction.
4. Read `network_requests({ tabID, urlContains, limit })` and `console_logs({ tabID, level, limit })`.
5. Inspect an exact returned request UUID with `network_request({ tabID, requestID })`. Headers are redacted. Bodies require **both** `captureBodies: true` at start and `includeBody: true` here; `maxBodyChars` bounds returned text.
6. Optionally profile the same tab with the start/stop tools below.
7. Call `stop_inspection({ tabID })` to discard in-memory captures and release its debugger lease. It never closes the tab or deletes previously exported files.

Example:

```js
// profileID and tabID must come from this conversation's selected profile and owned tabs.
await chrome.start_inspection({ profileID, tabID: 123, captureBodies: true });
// Reproduce on this tab using its browser tools.
await chrome.network_requests({ profileID, tabID: 123, urlContains: '/api/', limit: 20 });
await chrome.console_logs({ profileID, tabID: 123, level: 'warning', limit: 20 });
// Use an actual requestID returned above, never invent one.
await chrome.network_request({ profileID, tabID: 123, requestID, includeBody: true });
await chrome.stop_inspection({ profileID, tabID: 123 });
```

These illustrate MCP inputs, not standalone JavaScript imports. In OpenCode Code Mode, discover and call the corresponding `tools.chrome` tools.

## Network data

Requests include redacted URLs, methods, resource types, HTTP status, total duration, and available DNS/connect/wait timing. HTTP 4xx/5xx responses are `completed`, not transport failures. Redirect hops get distinct public request IDs; a previous hop cannot return the final hop's body. Request and response header metadata can be incomplete due to protocol event ordering, cache behavior, or eviction.

Response bodies are read from Chrome's existing capture buffer using a fixed protocol command; they are never re-fetched. Binary, oversized, evicted, pending, failed, redirected, or unavailable captures return an explicit state/reason rather than guessed data. Request bodies are retained only with opt-in. File uploads and multipart data are not reconstructed. WebSocket messages, service-worker background targets, and out-of-process iframe targets are not captured. Tab-target traffic may include resources from same-process frames within that tab.

Document changes clear old requests and logs, discard profiles, and invalidate old request IDs. The incoming navigation's request is preserved when its loader is identifiable. Inspection remains attached for the new page until stopped, except protected-page navigation ends it. Same-document navigation also clears retained data.

## Console data

`console_logs` includes console calls, browser log entries, and uncaught exceptions, with level filtering and available source location. Selecting a level includes more severe levels. Strings and primitive values are bounded; errors include their description, but ordinary objects are represented by type placeholders. No getters, object properties, or heap state are evaluated. Clear-console calls do not erase the diagnostic buffer. Duplicate browser/protocol reports of an error may appear.

## CPU profiles

Call `start_cpu_profile({ tabID, durationMs: 10000 })`, reproduce the workload, then `stop_cpu_profile({ tabID })`. Sampling uses a fixed 1 ms interval and automatically stops at the deadline, up to 30 seconds. The stop tool also retrieves an already auto-completed profile.

The bridge saves a generated private `.local/inspections/<UUID>/profile.cpuprofile` and returns only its path, summary, and routing `profileID`. Import the file into Chrome DevTools' JavaScript profiler or compatible tooling. Function names/URLs are sanitized; raw samples do not enter model context through the MCP response. Profiling is scoped to the attached tab target's JavaScript VM, not the system or other debugging targets.

## Performance timeline traces

Call `start_performance_trace({ tabID, durationMs: 10000 })`, reproduce the workload, then `stop_performance_trace({ tabID })`. A bundled isolated-world helper observes supported main-frame performance entries: marks, measures, long tasks, navigation, paint, layout shifts, and resource timings. Unsupported entry types are reported in artifact metadata, and events predating the start are excluded.

Exports are private `.local/inspections/<UUID>/timeline.json` files in Chrome trace-event JSON format, labelled `main-frame-performance-observer`. They include relative microsecond timestamps, durations and bounded numeric details, suitable for compatible trace viewers such as Perfetto.

**This is not a full Chromium renderer/system trace.** Browser-wide `Tracing.start` is deliberately not exposed: it can collect unrelated tabs/processes. GPU, browser internals, network payloads, screenshots, and complete engine scheduling are not part of this timeline. Navigation generally finishes before inspection starts, so its already-completed navigation entry is not backfilled. Resource/mark names can still contain private content.

Each profile is retained for retry if file persistence fails. After retrieving it, a new explicit start replaces that profile. Stop inspection to discard both profiles and all captured data.

## Limits, cleanup and privacy

- At most three inspected tabs, each with a five-minute capture window.
- Up to 200 request records within a 2 MiB metadata budget; evictions are counted.
- Up to 300 console entries, each 2,000 characters; reads return at most 100 messages/requests and report truncation.
- Chrome's network body buffers are bounded to 2 MiB total / 128 KiB per resource. Returned body text is at most 20,000 characters. Availability is best effort.
- CPU/performance capture is at most 30 seconds; CPU profiles allow at most 10,000 nodes / 60,000 samples, performance timelines 1,000 entries, and an exported artifact at most 5 MiB.
- Stop, disable, disconnect, session generation changes, tab closure, protected-page navigation, and debugger detachment discard affected inspection data. Navigation discards profiles but continues inspection on HTTP/HTTPS pages.
- A debugger lease manager coordinates inspection, verified recording and guarded clicks. Stopping one does not detach a debugger still used by another. DevTools attachment conflicts fail without fallback or taking over another debugger.
- Successful ordinary clicks keep an idle attachment for a 30-second debounced grace period to reduce Chrome-banner flicker. Starting inspection reuses that attachment, but never starts capture implicitly; explicit inspection stop still releases its final lease immediately. Disable/disconnect or Chrome's Cancel do not wait for the grace period.
- The performance helper has its own bounded timer. All capture state is in memory; worker restarts do not resume it. Exported files remain local, ignored by git and excluded from packages/releases.
- Standard authorization/cookie/secret headers are redacted; unknown header values are also redacted. Common sensitive query parameters, nested JSON fields and labelled console secrets are masked. URL credentials/fragments are removed. This is **best-effort redaction**, not a guarantee: page text, endpoint paths, unlabelled secrets and user data can still be sensitive. Inspect files before sharing.
- POSIX directories/files use private permissions; Windows inherits NTFS ACLs. Artifact names/paths are generated by the bridge and no upload happens automatically.

## Activation and tests

Reload the unpacked extension in each opted-in profile and reconnect `chrome` to discover the nine added tools (**27 total** including verified recordings and profile routing). Recording also adds the `offscreen` permission; accept updated permissions if Chrome prompts. In global shared mode, coordinate `npm run stop:shared` from the installation directory before reconnecting; adapter reconnection alone does not reload the running daemon. This affects every project and connected profile using that daemon. No configuration, approvals or live bridge are changed by tests.

`npm run check` exercises ownership, schema bounds, redaction, navigation/redirects, body opt-in, eviction, cancellation races, shared debugger leases, artifact privacy and MCP output stripping. The isolated real-Chrome regression verifies actual network/console events, uncaught errors, response bodies, CPU samples and performance timeline events:

```sh
CHROME_BINARY="/path/to/chrome" npm run test:browser
```

This uses a temporary headless profile and local test website. It does not touch signed-in accounts or exercise extension permission prompts/Chrome UI. A manual unpacked-extension smoke test remains separate.
