# Contributing

Use Node.js 24+ and run:

```sh
npm ci
npm run check
```

There is no build step. The unpacked Chrome extension lives in `extension/`; the Node MCP bridge lives in `bridge/`. Tests use Node's test runner, a real MCP client/server pair, a simulated Chrome API, and jsdom for DOM interaction.

Use `npm run format` to apply Prettier and `npm run lint` for ESLint. `npm run check` also validates package/lockfile/Chrome version consistency and runs all tests. Keep JavaScript ES modules and two-space indentation. Runtime MCP version is read from `package.json`.

The published CLI entrypoint is `scripts/cli.js`. Test it from a checkout with `node /absolute/path/to/scripts/cli.js --help`. `npm pack` generates an ignored `npm-shrinkwrap.json` from the committed lockfile so package-runner installs retain locked dependencies. Tests verify the actual npm tarball and executable without publishing anything. Node.js remains the runtime even when launching through `bunx`.

See [architecture](docs/architecture.md) for module boundaries and connection lifecycle. To bump a release, run `npm version <version> --no-git-tag-version`, update `extension/manifest.json` to match, and add a changelog entry.

## Releases

1. Update package/Chrome versions together and add a matching changelog section.
2. Run `npm ci`, `npm run check`, and `npm run package`.
3. Review the generated source and extension ZIPs in `dist/`; they exclude local state and dependencies. Consumers run the installer to fetch locked dependencies.
4. Merge the reviewed changes with passing CI, then push a tag matching the package version, for example `v0.4.0`.
5. The release workflow reruns checks on Windows/Linux and publishes both ZIPs, SHA-256 checksums, and changelog notes. Do not move a published tag; release a new version for fixes.

Owner-only GitHub settings are documented in [maintainer setup](docs/maintainer-setup.md). Run `CHROME_BINARY=/path/to/chrome npm run test:browser` for the local trusted-click regression. On macOS, the usual binary is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; quote paths with spaces. The test starts a temporary headless profile and local page, never your signed-in Chrome profile. Linux CI runs it with `/usr/bin/google-chrome`. Extension loading and permission prompts still need manual smoke testing.

### npm publication

Publication is a separate maintainer action, not part of pushing a commit or the GitHub release workflow. Confirm ownership of the `@asaf-labs` npm scope, sign in locally, run `npm run check` and `npm pack --dry-run`, then explicitly publish with `npm publish --access public`. `prepublishOnly` reruns checks. Never put npm credentials in repository files or agent conversations.

When changing the extension, reload it at `chrome://extensions`. When changing bridge code, reconnect the `chrome` server in OpenCode's `/mcps` interface. After changing permissions, Chrome may require enabling the extension again.

The real-browser suite also verifies the [recording workflow](docs/recordings.md): it declares a task, excludes a failed attempt, captures verified actions including navigation, encodes WebM without FFmpeg, and checks playback metadata. Set `SAVE_RECORDING_DEMO=1` alongside `CHROME_BINARY` to retain its harmless local video/manifest under `.local/recordings/`. Production accounts and permission prompts are never driven by this test.

It also verifies real network/console events, opt-in bodies, CPU samples and main-frame performance entries. The four real-Chrome regressions (clicks, iframes, recording, inspection) run sequentially to avoid competing startup fixtures. Profile-aware MCP/shared-HTTP tests separately exercise real artifact persistence and ensure raw capture payloads stay out of MCP output.

For manual capture smoke testing, use a disposable Chrome profile and harmless local/public demo data. Reload/approve `offscreen`, discover all 27 tools after coordinating the shared-daemon restart, select that profile, and explicitly start inspection/recording on an owned tab. Verify body opt-in, stop/cancel during an action, private artifact exports, and disable/disconnect cleanup. Do not use signed-in production data or share raw artifact contents. Main-frame recording/performance limits and profile-switch behavior are documented in [recordings](docs/recordings.md) and [inspection](docs/inspection.md).

## Pull requests

External contributors can fork this public MIT-licensed repo, create a branch, run `npm run check`, and open a PR against `main`. A PR does not grant push or merge access. Keep changes focused and include verification evidence.

- Keep browser tools limited to session-owned tabs.
- Test changes that affect ownership, authentication, cancellation, or persistence.
- Preserve the distinction between page content (untrusted data) and extension code.
- Explain added Chrome permissions and their effects on the security model.
- Do not commit `.local/`, pairing tokens, local OpenCode configuration, browser-profile data, scraped private information, or screenshots containing account identifiers.
- Document behavior/installation changes in README.md and security changes in SECURITY.md.

For a manual smoke test, use the public sandbox at `https://www.scrapethissite.com/`. Verify automatic tab creation, reading, form interaction, the orange agent cursor, disable/re-enable, and reconnect. Use a dedicated browser profile for testing changes.

For the activity UI, verify there is no idle banner or page border; actions show a small dot and cursor, which fade when idle. Expand the dot, choose Hide for this tab, and confirm actions/cursor still work while the Chrome group/badge remain. Navigate/restart the worker and confirm hiding persists. Restore the dot from that tab's popup control. Confirm iframe snapshots do not produce duplicate dots and shadow UI never becomes an agent element ref.

### Tab cleanup smoke test

- Reload the updated extension in a disposable profile. Verify automatic archiving starts **off**, and indicator refresh/reconnection preserves a manually collapsed group.
- Create several owned tabs concurrently in one conversation/window; verify they share one group. Personal tabs must never acquire ownership merely by being dragged into that group.
- With the conversation inactive for 15 minutes and focus on a different tab, verify its group collapses. Groups containing active or personal tabs must remain alone.
- Only in this disposable profile, enable automatic archiving and set Archive after (hours). Verify the new default is 3, an already-enabled legacy profile retains 24 until changed, and invalid values outside 1–168 whole hours are rejected. Verify eligible idle tabs save URLs before closing at the chosen boundary. Active, pinned, audible, loading, and Keep tabs must remain open; disconnect/disable must not initiate cleanup. Use `node --test test/lifecycle.test.js test/cleanup-settings.test.js` for deterministic clock/storage-failure/migration cases instead of changing your system clock or production ownership records.
- Restore a saved URL and verify it opens as an owned tab in the same profile. Delete a saved URL and verify it disappears. Explain that restore does not recover unsaved forms or page state. Never include private archive URLs in screenshots or test reports.
