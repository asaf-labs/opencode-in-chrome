# Security model

## Tab cleanup and archives

Automatic closing is opt-in per Chrome profile. Archives contain URL/title/session metadata in trusted-context `chrome.storage.local`, not page contents or credentials fetched separately. URLs themselves can contain sensitive data; they are not synced by this extension, but remain accessible to the local Chrome user. Restore uses the same profile and requires browser access enabled. The popup can delete saved URLs. Never publish extension storage in diagnostics. Ownership is checked from the session binding, not group membership. Activity checks and close operations are not atomic; unsaved forms cannot be reliably detected and are not preserved. Session inactivity alone does not prove an agent has finished.

The archive delay is configurable per profile from 1 to 168 whole hours (default 3). Previously enabled fixed-delay profiles retain 24 hours on upgrade unless changed explicitly. Shortening it can close already-idle eligible tabs on the next check. Delay updates are validated and persisted before use, and cleanup rechecks the live delay before closing; invalid delays do not authorize closing. Changing the delay alone never enables automatic archiving.

This is a browser-automation prototype, not a sandbox for an untrusted agent. Session-owned tabs isolate **which tabs** an agent can manipulate. They do not isolate cookies, accounts, network access, or the privileges of the local OpenCode process.

## What could be dangerous?

| Risk                            | Example                                                                                                                     | What helps                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Signed-in account actions       | An agent opens your email, admin console, or shopping account in a new tab and submits a form                               | A dedicated Chrome profile; OpenCode tool permissions; supervision of write actions                 |
| Private-data disclosure         | Page text, input values, or screenshots are sent into the OpenCode conversation and may reach the configured model provider | Choose an appropriate provider; keep sensitive accounts out of the automation profile               |
| Prompt injection                | A page tells the model to ignore instructions, open another site, or transmit private information                           | Treat page text as untrusted data; constrain tasks and tool permissions; profile isolation          |
| Unintended side effects         | A click sends a message, deletes a record, approves a payment, or triggers a download                                       | Require approval for interaction tools when appropriate; cancellation cannot undo completed actions |
| Token compromise                | Another process or extension obtains the pairing token and impersonates a browser connection                                | Keep the token private; protect local files/profile; rotate it when exposed                         |
| Local/intranet access           | An owned tab visits a router, localhost application, or internal service                                                    | Use a restricted profile/environment and network controls where necessary                           |
| Dependency or update compromise | Modified extension/bridge code abuses its privileges                                                                        | Review code and updates; use lockfile installs; avoid loading untrusted forks                       |

The extension cannot reliably determine whether an arbitrary click is destructive. An orange cursor is visual feedback, **not an authorization check**. A website can also imitate a page indicator, so the page overlay is not a trusted security signal.

The activity dot is dismissible without revoking browser access; the Chrome tab group and AI extension badge remain ownership markers. Hiding it is not a stop/disable action. Content-script hide messages are restricted to their own verified owned tab, and the preference is stored with temporary ownership records. Only the dot/panel buttons intercept page pointer input; cursor/highlight layers remain pointer-transparent.

## Implemented safeguards

- **Loopback only:** the bridge listens on `127.0.0.1`, not a public interface.
- **Random shared token:** setup generates 32 random bytes. HTTP status reads require the token; WebSocket connections authenticate before receiving commands or replacing the connected browser. Tokens are not placed in URLs.
- **Host/origin checks:** unexpected hosts and ordinary website origins are rejected. Chrome-extension origins still need the token. The extension restricts the configured bridge URL to loopback HTTP.
- **Session ownership:** browser actions verify both session generation and owned tab ID. Existing personal tabs and other sessions' tabs cannot be targeted through the tools.
- **Profile opt-in and routing:** only paired extension installations are discoverable. Each regular Chrome profile stores its own random identity and enabled preference. Profile connections use separate ownership maps, command queues, pending results, and disable/disconnect handling. Conversation profile choices are persisted; an offline or disabled profile never causes fallback to another account. Profile-scoped refs and explicit profile checks on numeric tab IDs guard against cross-profile ambiguity. Simultaneous duplicate identities are rejected.
- **No arbitrary page evaluation tool:** model-visible tools are a fixed collection of tab and DOM operations. No shell command, filesystem API, cookie API, or arbitrary JavaScript evaluation is exposed by this MCP server.
- **Isolated-world execution:** injected content scripts use Chrome's default isolated world, separate from the page's JavaScript globals. Page content is returned as data.
- **Frame-scoped actions:** iframe refs encode the observed Chrome frame ID and resolve only within the owned tab. Document checks prevent reuse after frame navigation. Browser-level clicks map through intrinsic WindowProxy ancestry and validate containing-frame geometry/occlusion before mouse-down; page messages and DOM-supplied routing markers are not trusted. Inaccessible or unsupported frame geometry is rejected.
- **Browser-level clicks:** the worker acquires a debugger lease only for a verified session-owned tab and sends fixed `Input.dispatchMouseEvent` commands. Content scripts hit-test the ref before input and again after mouse movement; stale, disabled, moved, or covered targets fail closed. Successful ordinary clicks retain an otherwise-idle attachment for a 30-second debounced grace period, reducing Chrome-banner churn without enabling data capture. Ownership/generation/enabled checks still apply on every acquisition. Disable/disconnect, pause, closure, protected navigation, or Chrome's Cancel clear the attachment without waiting for the timer; acquired click failures and explicit final recording/inspection releases do not use the grace period. Other authorized capture leases can keep a shared attachment active. Tools never expose arbitrary CDP commands. Input dispatch is not proof of application acceptance.
- **Credential storage separation:** extension local/session storage is restricted to trusted extension contexts. Injected content scripts cannot read the stored pairing token.
- **No password values in snapshots:** native password-input values are excluded. This does not guarantee that all secrets on a page are concealed; other inputs, page text and screenshots can contain sensitive data.
- **Disable control:** disabling access rejects bridge work, invalidates generations, and notifies owned-page content scripts to stop pending interactions.
- **Disconnect handling:** losing the bridge connection suspends browser actions and invalidates queued work. Reconnection rechecks enabled settings and browser permissions before announcing readiness.
- **Authenticated readiness:** pairing and reconnection leave controls suspended until the bridge acknowledges authentication. Invalid ownership data in a new handshake is rejected before replacing a working connection.
- **Cancellation propagation:** MCP cancellation and action timeouts are forwarded to the extension. Queued commands and pending pre-click animations can be cancelled. Completed actions are not reversed; Chrome API calls already in progress may still finish.
- **Expiry/stale refs:** browser commands expire after 25 seconds; element refs are scoped to a document/snapshot and checked again before delayed interactions.
- **Private local state:** `.local/` is ignored by Git. The bridge token and machine-specific MCP configuration must never be committed.
- **Credential-safe onboarding:** `install:opencode` and `doctor` do not print tokens. `pair` writes an ignored, restricted local HTML page with copy/reveal controls and no remote resources. That page contains a credential; keep it out of agent reads, screenshots, and shared files. The lower-level `setup` command intentionally prints the token for manual setup.
- **Release boundaries:** standalone and extension-only archives use an explicit source allowlist and exclude `.local/`, `node_modules/`, and Git state. Releases include checksums; verify downloads from the maintainer's repository.
- **Package-runner installation:** npm packages use an explicit file allowlist and a publishable lockfile. The CLI copies code into a permanent per-project directory, installs locked runtime dependencies with lifecycle scripts disabled, and refuses to overwrite different existing code. Package-runner caches are never the registered bridge location. npm/Bun may separately apply their own dependency-install behavior when fetching the CLI.
- **Global shared mode:** one per-user daemon accepts authenticated localhost tool calls from multiple project adapters. Calls require the pairing token, reject browser origins, validate fixed tool schemas and session metadata, and limit request bodies to 128 KiB. Adapters never launch duplicate listeners intentionally, stop unrelated processes, or retry completed actions. Stopping the daemon affects all projects. The same local-user and forged-session-metadata limitations still apply.

## Inspection privacy

Network/console capture requires an explicit `start_inspection` on a session-owned HTTP/HTTPS tab. Bodies are not retained/read by default and require two opt-ins. Fixed Network/Runtime/Log/Page/Profiler commands are used; no arbitrary CDP, heap evaluation, interception or cookie/storage-reading API is exposed. Events from child protocol sessions are ignored. The shared debugger lease manager enforces ownership/generation boundaries and cancels/detaches on disable, disconnect or tab removal.

Captured headers, URLs, common labelled secrets and nested JSON fields are redacted; unknown header values are hidden. This is not complete secret/PII redaction. Requests/logs remain bounded in memory, expire after five minutes and are cleared on navigation/stop. CPU profiles and main-frame PerformanceObserver traces export generated private files under ignored `.local/inspections/`; raw profiles are not returned into model context. Review all returned content and files before sharing. Captured page/network/log data is untrusted and must never be treated as instructions.

Performance timeline capture uses a fixed bundled isolated-world helper, not browser-wide Chromium tracing. Only supported main-frame timeline entries are collected, and CPU sampling uses the attached target's VM. No extra extension permission is requested. See [inspection](docs/inspection.md) for scope, exclusions and limits.

## Recording privacy

Recordings are explicit, session-scoped, and limited to an owned tab. The debugger sends fixed screencast/screenshot/ack commands; an offscreen extension document uses WebCodecs to encode only verified segments. No desktop, microphone, personal-tab capture, arbitrary CDP, or arbitrary evaluation tool is added. Captured pixels, typed literals, page URLs, and selectors can still disclose private information. There is no automatic redaction: review local artifacts before sharing them.

Exports use generated paths beneath ignored `.local/recordings/`, private POSIX permissions, and inherited Windows ACLs. Video bytes are stripped from MCP responses; only artifact paths and safe summaries reach the model. Failed attempts are omitted and counted, not erased from application history or rolled back. Observable checks verify the declared page state, not external effects. Replay requires an explicit new tool workflow and can repeat side effects.

The added `offscreen` permission enables a bundled hidden encoder document; it does not request screen-sharing or microphone access. Encoding and capture are bounded, cancelled on disable/disconnect, and limited to authenticated extension messages and session-owned tabs. Previously exported files are never deleted automatically.

Inspection/recording state is local to each opted-in Chrome profile and session; changing the conversation's profile never retargets existing capture or reads. A profile switch alone does not cancel previously authorized capture: stop/cancel first, or return explicitly to the original profile to stop it (inspection expires after five minutes). Active inspection and retained recording plans block idle tab cleanup. Artifact responses identify their profile without passing routing metadata into strict artifact payload schemas. Post-export recording cleanup includes the original profile ID so a concurrent selection change cannot clear a recording in a different profile.

`run_recording_step` is a macro that executes the plan's browser actions inside the extension. OpenCode approval applies to the macro, not to separate nested click/type calls. Require approval for `chrome_run_recording_step` when using supervised actions; the supplied `chrome_*` ask rule already covers it. Existing custom rules for individual interaction tools alone do not. The feature does not modify user permission rules or saved approvals.

## Trust boundaries and limitations

1. The model and webpages are not trusted to make safe decisions automatically.
2. The OpenCode process, MCP client, bridge, extension, local user account and installed code are trusted. OpenCode session IDs are routing metadata, not authentication credentials. A malicious local MCP client can forge this metadata; session ownership is not a multi-user authorization system.
3. New tabs share the normal cookies and login state of the Chrome profile containing the extension. Opening an authenticated page can have side effects even before a click.
4. Browser website permission is broad (`<all_urls>`), including permissions needed for viewport captures. Application-level ownership restricts tool targets, but the installed extension remains powerful.
5. Other OpenCode servers/tools, such as shell or network tools, are outside this extension's controls. An agent with shell access can use the privileges of your OS account independently of these browser tools.
6. Disconnect/disable/cancellation are best-effort stop mechanisms, not transactional rollback or a network firewall. They cannot stop a request that has already been sent.
7. The token is stored as local data, not encrypted by the extension. POSIX setup uses mode `0600`; on Windows, effective protection comes from the directory's inherited NTFS ACLs. Malicious software running as your user is outside this threat model.
8. Chrome extensions in an incognito profile or across separate Chrome profiles are not managed by this connection unless separately installed and paired.
9. Viewport capture uses Chrome's active-tab API. The extension verifies the target before and after capture, but this is a best-effort race check: avoid switching tabs during screenshots. It is not an atomic tab-specific capture API.
10. The required `debugger` permission is powerful and can access more than mouse input; the extension's implementation limits its use, not the Chrome permission itself. Chrome may show a debugging banner, and DevTools or enterprise policy may block attachment. DOM validation and input dispatch are not atomic: the page may change between them. Cancellation after mouse-down cannot undo a handler or webhook that already ran; inspect state before retrying.
11. Snapshots may include cross-origin iframe content wherever Chrome grants script access. Treat embedded page content as untrusted too; private embedded forms or account data may reach the model provider. The same tab-ownership and profile/account limitations apply to frames. Frame geometry validation is best effort and does not make input dispatch atomic.
12. Profile IDs and labels are routing metadata, not authentication or proof of Google/account identity. Names are user-provided and untrusted as instructions. All profile connections share the local pairing secret; trusted local software with that secret can impersonate a profile. Do not clone profile-local extension storage. Incognito is not a separate supported profile identity. Disabling a profile stops automation, but does not delete its metadata or session-selection history.
13. `.local/profile-routing.json` contains profile labels/IDs and conversation selections, not pairing tokens or page contents. It is written atomically (POSIX mode `0600`) and ignored by Git. Corrupt or unwritable routing state fails closed rather than resetting selections or sending browser actions. Deliberately deleting this file resets routing history; do not do so as a routine troubleshooting step.

## Recommended deployment

For initial installation, use a **dedicated Chrome profile** containing only accounts you intend to automate. This retains the useful signed-in browsing behavior while avoiding access to unrelated personal/work accounts.

Review tool permissions in OpenCode. For sensitive work, use `ask` for interaction tools (`chrome_click`, `chrome_type`, `chrome_select`, `chrome_check`) and navigation. Approvals happen in OpenCode's normal interface, not a chat drawer in the extension. The extension does not silently modify your OpenCode permission rules.

A ready-to-merge [supervised permission example](examples/permissions.jsonc) asks for all browser actions except listing, reading, and scrolling. Rules use OpenCode V2's ordered `permissions` array. The MCP registration name determines the action prefix; update `chrome_` if you register under a different name.

Keep the bridge on localhost, keep the token out of repositories/logs/screenshots, and disable browser access in the toolbar popup when finished. Session-created tabs remain open when disabled, but the agent cannot manipulate them through this server until re-enabled.

## Rotate an exposed token

```sh
npm run setup -- --rotate-token
```

Then reconnect `chrome` in OpenCode's `/mcps` interface and replace the saved token in the extension popup. Rotation changes the file; an already-running bridge retains its previous token until restarted. Do not paste the token into a GitHub issue or an OpenCode prompt.

## Reporting vulnerabilities

Private vulnerability reporting is enabled. Report suspected vulnerabilities through [GitHub's private reporting form](https://github.com/asaf-labs/opencode-in-chrome/security/advisories/new). Do not post pairing tokens, signed-in page contents, screenshots with private information, or working exploit details in a public issue before coordinating a fix.

Repository admin access is required to manage private reporting and branch protection. See [maintainer setup](docs/maintainer-setup.md) for the configured safeguards and maintenance instructions. If the private reporting form is unavailable, establish a private channel with the maintainer rather than posting confidential details publicly.

This prototype has not undergone an independent security audit. Automated tests verify the implemented boundaries; they do not establish that browser automation is safe for every account or task.
