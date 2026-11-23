# Reconnect or open a Chrome profile

`connect_profile({profileID})` waits for a specific opted-in Chrome profile to connect. It does **not** change the conversation's selected account, enable browser access, change pairing, adopt tabs, restart a healthy bridge, or retry a browser edit. Shared mode starts its daemon on demand if it is absent.

A **profile ID** is the extension's opaque UUID from `list_profiles`, not Chrome's profile name or directory. A **launch mapping** is a local approval linking that UUID to an existing Chrome executable and profile folder. The MCP tool accepts only the profile ID; filesystem paths, shell commands, arbitrary flags and website URLs are not tool arguments.

## One-time launch approval

1. Update the bridge and reconnect the MCP adapter, or let the existing safe-update mechanism activate the installed update. The catalog has **30 tools**. No new extension permission is required.
2. Open the intended regular Chrome profile manually, pair its extension with this bridge, and enable browser access. Use `list_profiles` to obtain its ID. The updated bridge must observe it enabled at least once. `lastKnownEnabled: null` means an older record has no confirmed state; it is not permission to launch.
3. In that profile, open `chrome://version`. Copy **Executable Path** and **Profile Path**. Use the exact paths; never infer an account from a display name or enumerate other profiles' account data.
4. From the permanent bridge installation, run:

   ```sh
   npm run profile:map -- --profile-id PROFILE_ID --chrome "/absolute/path/to/Chrome" --profile-path "/absolute/path/to/User Data/Profile 3"
   ```

   On Windows, use `npm.cmd`. For example:

   ```powershell
   npm.cmd run profile:map -- --profile-id PROFILE_ID --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --profile-path "C:\Users\YOUR_USER\AppData\Local\Google\Chrome\User Data\Profile 3"
   ```

   Typical macOS executable: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; Linux: `/usr/bin/google-chrome`. Profile paths must identify an initialized `Default` or `Profile N` folder, not the whole User Data directory, Guest Profile, System Profile or an incognito session.

The command saves only this launch approval in ignored `.local/profile-launchers.json`, next to this installation's configuration. It verifies the paths exist without reading Chrome's `Preferences` or `Local State` contents, preserves other mappings, and rejects mapping the same folder to a different profile ID. It does not open Chrome or alter pairing/account selection. Treat these machine-specific paths as private; do not publish the file. Rerun the command to update an approved mapping after a Chrome/path change.

To revoke launch approval, remove that profile ID's entry from this local file. This does not change pairing or enable/disable the extension.

## Use from MCP

```text
list_profiles({})
connect_profile({"profileID": "ID_FROM_LIST"})
select_profile({"profileID": "ID_FROM_LIST"})
open_tab({"profileID": "ID_FROM_LIST", "url": "https://example.com"})
```

Use the actual returned UUID. A successful connection returns `connected: true`, `launched` (whether this attempt started Chrome), profile metadata and the unchanged `selectedProfileID`. An already connected/enabled profile returns immediately and needs no launch mapping. Connecting a different profile never switches the existing selection.

If offline, the tool first gives the extension a short chance to reconnect normally. If still offline, it opens the approved Chrome executable with only the mapped user-data/profile directories, a new window and `about:blank`. It waits within a 20-second connection budget for the **requested authenticated profile ID** with browser access enabled. A different profile connecting is never accepted as success. Concurrent callers share a single attempt; repeated attempts have a 30-second launch cooldown to avoid window spam.

The launch window's blank tab is not automatically session-owned. Use `open_tab` for agent work. Chrome's startup/restore settings may open other tabs; the MCP does not adopt or control them. Browser restarts clear temporary ownership, so restored personal tabs are not reclaimed.

## Failure and cancellation

- A known-disabled or unconfirmed profile is not launched. Open it manually and enable the extension if you want it used. A disabled handshake after launch is also rejected; access is never enabled for you.
- Missing/malformed mappings, missing initialized profile directories and routing-persistence failures fail closed. A wrong mapping can open the configured profile, but cannot satisfy another ID's handshake or authorize actions there. Correct it locally; do not switch accounts as a workaround.
- A timeout does not mean Chrome failed to open. Check the requested profile's extension, pairing URL and website permission before trying again. Disabled extensions, a suspended/hung worker, wrong bridge URL or new permission prompts may still need manual attention.
- Cancelling a caller stops its wait, not other callers' shared attempt. When all callers cancel, waiting stops; an already opened Chrome window is not killed or silently retried.
- A connection attempt never restarts a healthy shared daemon or activates a pending code update. General automatic updates remain a separate idle-only mechanism. Deliberate shared-daemon restarts still require coordination because they interrupt other projects/profiles.

Once connected, take fresh snapshots before interactions. Nothing in this flow replays an interrupted edit.
