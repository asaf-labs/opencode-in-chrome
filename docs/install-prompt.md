# Install from an OpenCode conversation

The [copy-paste prompt in README.md](../README.md#install-from-an-opencode-chat) is the primary onboarding path for users who want an agent to do the work. Start the conversation in the **target project**, not necessarily the extension repository.

## What the agent does

1. Identifies the actual target Location directory and inspects existing Chrome MCP registration.
2. Reuses a suitable permanent checkout, or clones `https://github.com/asaf-labs/opencode-in-chrome.git` without overwriting user files.
3. Checks prerequisites and reads the installation skill. The skill provides the detailed setup and recovery workflow.
4. Runs `npm run install:opencode -- --project <absolute-target-path>` from the checkout. The installer installs missing dependencies, preserves pairing settings, registers MCP, and copies the skill into the target project.
5. Resolves setup failures with diagnostics. Disconnecting another project's bridge requires confirmation because that stops access for its conversations. Port changes affect every registration using that checkout's configuration.
6. Runs `npm run pair` to open the private local pairing page, then guides the user through the Chrome-only steps.
7. After user confirmation, checks target-project MCP connection and browser readiness, then performs the explicitly authorized public-page smoke action.

## What remains a user step

An OpenCode prompt cannot guarantee installation of prerequisites without OS permission, load an unpacked Chrome extension automatically, choose the right signed-in profile, or bypass Chrome's permission approval. The user selects a dedicated profile, loads the checkout's `extension/` folder, copies the token from the local pairing page into the extension popup, and accepts website access.

This is one guided setup conversation, not a promise of completely unattended browser installation. The agent should execute available terminal steps, pause only for approval or genuinely manual work, and continue afterward.

### Cleanup defaults after installation

The extension [collapses inactive groups after 15 minutes](../README.md#automatic-tab-cleanup). Automatic closing/archiving is **off by default**; installing agents must not enable it without the user's request. The popup's **Archive after (hours)** setting accepts 1–168 whole hours, defaulting to 3; already-enabled legacy profiles retain 24 hours until changed. The popup also offers Keep, Restore, and Delete saved URL controls. Explain that shortening the delay can close already-idle eligible tabs on the next check, archives save profile-local URLs rather than unsaved forms/page state, and browser inactivity is not OpenCode conversation archival. After updating extension code, reload it in each participating Chrome profile; this cleanup feature does not require new permissions or token rotation.

## Credential handling

- The prompt never asks for a pairing token in chat.
- Installer and doctor output are credential-safe. Prefer them over the lower-level `setup` command, which prints the token.
- `.local/config.json`, `.local/pairing.html`, and the clipboard must stay outside agent context, screenshots, issues, and version control.
- The pairing page is local and ignored by Git; the user transfers the token directly into the popup.

## Completion criteria

- Target project: `opencode mcp list` shows `chrome connected`.
- Checkout: `npm run doctor` exits `0` and reports connected Chrome with browser access enabled.
- The agent actually opens and reads the public test page using this extension's MCP tools, not unrelated browser tools or a fabricated result.

If any criterion fails, the agent reports the specific blocker and the next action. In particular, a ready browser connected to an old project's bridge does not prove that the new target project's MCP is connected.
