# Changelog

## Unreleased

- Serialize session group creation, consolidate owned tabs, and preserve manual group collapse.
- Collapse inactive groups after 15 minutes; add opt-in 24-hour URL archiving, Keep controls, local restore/delete, and guards for active/pinned/audible/loading tabs, busy sessions, disconnected profiles, and storage failure.
- Add one-time Chrome-profile opt-in, persistent profile names/IDs, simultaneous authenticated connections, and `list_profiles`/`select_profile` tools.
- Persist conversation profile selections across bridge restarts; never fall back to another account when the selected profile is disconnected or disabled.
- Namespace element refs by profile and guard numeric tab-ID ambiguity; isolate profile cancellation, disable controls, bindings, and results. Reject simultaneous cloned identities and fail closed on routing-state storage errors.
- Expose custom multiselect/listbox options, ARIA checkboxes, menu items, and associated checkbox labels as snapshot refs; prioritize open popups at the element cap and report truncation.
- Add searched-option click regressions for Coupa-style command menus while preserving stale-ref, disabled-target, and covered-target checks.
- Add frame-scoped snapshots and refs, targeted iframe reading/scrolling, and nested cross-origin iframe actions with validated main-viewport click geometry.
- Revalidate each containing iframe before mouse-down; reject inaccessible, covered, moved, or unsupported transformed frame targets instead of guessing coordinates.
- Replace synthetic DOM clicks with hit-tested browser-level mouse movement, press, and release using the Chrome debugger API on session-owned tabs.
- Report clicks as dispatched with application acceptance unknown; revalidate after hover handlers and warn about uncertain outcomes after mouse-down.
- Add the debugger permission and document extension reload, debugging banners, and DevTools conflicts.
- Add a real Chrome regression for trusted pointer handlers and dropdown selection, plus stale/covered-target and cancellation tests.

## 0.6.0

- Add `install --global` for automatic Chrome tools in every OpenCode project through one shared per-user daemon.
- Start the daemon on demand and reuse it across concurrent project adapters without port conflicts or per-project pairing.
- Preserve conversation-owned tabs, authenticated loopback access, fixed tool schemas, and cancellation across the shared transport.
- Keep the daemon alive when adapters close, provide explicit shared shutdown, and refuse to replace unrelated listeners.
- Add concurrent multi-project, startup-race, authentication, cancellation, reconnect, and global-installer tests.

## 0.5.0

- Add a publishable CLI for `npx` and `bunx` that defaults to the current project and keeps runtime files outside package-runner caches.
- Preserve existing installations and pairing settings, isolate permanent installations per project, and refuse to replace an existing Chrome MCP on first install.
- Ship a publishable dependency lockfile and install only runtime dependencies without lifecycle scripts.
- Automatically select macOS, Windows, or Linux pairing instructions with accessible tabs and an extension-folder copy button.
- Explain macOS folder selection with Command + Shift + G and retry MCP readiness while the server starts.
- Add CLI and package-distribution tests and macOS CI coverage.

## 0.4.0

- Add MIT licensing, code ownership rules, and owner instructions for protected branches and confidential vulnerability reporting.
- Add a one-command project installer that installs missing dependencies, preserves pairing, registers MCP through OpenCode's CLI, and installs a reusable agent skill.
- Add a private local pairing page with clipboard support; installer and diagnostics never print the pairing token.
- Add `npm run doctor` with human-readable and JSON readiness reports, plus actionable port-conflict startup errors.
- Publish reproducible standalone-project and extension-only ZIPs with SHA-256 checksums through tagged-release automation.
- Add a labeled control illustration, easier onboarding, and contributor/release instructions.

## 0.3.2

- Keep page controls suspended until the bridge acknowledges authentication, including pairing and reconnection.
- Prevent a new snapshot from reviving a delayed interaction using old element refs.
- Reject malformed ownership data before replacing an authenticated browser connection.
- Validate missing/invalid command expiry instead of accepting commands without deadlines.
- Share bridge configuration validation between startup and setup; support `--port` and tighten existing POSIX token-file permissions.
- Add a supervised OpenCode V2 permission example and architecture documentation.
- Add ESLint, Prettier, editor defaults, version checks, dependency-update automation, and Windows/Linux quality checks.

## 0.3.1

Initial standalone repository release:

- Twelve MCP tools for automatically created session-owned Chrome tabs.
- Orange tab groups, page indicators, target highlights, and an independent agent cursor.
- Authenticated localhost transport and trusted-context-only credential storage.
- Disconnect suspension, disable controls, cancellation forwarding, command expiry, and stale element refs.
- Installation instructions, security model, and Windows/Linux tests.
