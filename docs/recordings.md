# Verified task walkthroughs

An agent can declare a browser task for itself, execute a fixed plan, and export **a local video plus deterministic actions**. This records a session-owned Chrome tab, not the OpenCode terminal, full desktop, microphone, or other tabs.

The export is an **edited, verified walkthrough**, not an uninterrupted audit recording. Failed attempts and activity between planned steps are omitted. The video is labelled as edited and the manifest reports the number of excluded attempts. Exclusion never undoes a browser action, payment, webhook, or other side effect.

## Agent workflow

Choose the intended Chrome profile with `list_profiles`/`select_profile` first. Every recording tool accepts `profileID`; include it on all recording calls to make account affinity explicit, and always include it with an explicit `tabID` when multiple profiles are registered. Plans and videos stay in the original profile/session and are not moved or cancelled by switching profiles. Finish or cancel before switching; otherwise explicitly select the original profile again to continue. A declared recording plan prevents idle tab cleanup until it is finished/cancelled or discarded by disable/disconnect. Main-frame selectors only: an iframe snapshot's `frameID` does not make a selector-based plan target that iframe.

1. Explain the intended task and goal before acting. Open an owned tab and use `read_page` to inspect it. Snapshot elements include a unique `selector`, preferring IDs/test IDs/ARIA labels and falling back to a bounded structural path. Prefer stable application test IDs; structural paths can change with layout, so include meaningful target/page preconditions.
2. Declare the full immutable plan with `start_recording`: task, goal, tab, ordered steps, and final goal checks. Each step must have observable preconditions, literal actions, and postconditions. Use unique CSS selectors, never snapshot refs.
3. Call `run_recording_step` for each step ID in order. The extension captures only that attempt, runs its literal actions, and retains the segment only if all postconditions pass.
4. If an attempt fails, its video and actions are discarded. Inspect the page and decide whether recovery is safe. Restore the declared preconditions with ordinary tools before retrying; recovery is outside the walkthrough. Never blindly repeat side-effecting actions.
5. Call `finish_recording`. Every planned step and the final goal checks must pass. Chrome encodes the accepted segments, and the bridge saves private local artifacts. The in-memory recording is cleared after a successful file export.
6. Share the returned file paths only after reviewing the files for private data. No upload, publication, or replay is automatic.

To abandon a plan, use `cancel_recording`. Changing the task, actions, or conditions requires cancelling and declaring a new plan, not retroactively changing the success criteria.

## Plan example

For a page containing a uniquely identified checkbox:

```json
{
  "tabID": 123,
  "task": "Enable the demo preference",
  "goal": "The demo checkbox is checked",
  "steps": [
    {
      "id": "enable-preference",
      "description": "Check the demo preference",
      "before": [{ "selector": "#demo-preference", "checked": false }],
      "actions": [{ "tool": "check", "selector": "#demo-preference", "checked": true }],
      "after": [{ "selector": "#demo-preference", "checked": true }]
    }
  ],
  "goalChecks": [{ "selector": "#demo-preference", "checked": true }]
}
```

Use the actual owned `tabID` and selectors from the page. After `start_recording` returns its `recordingID`, call:

```json
{ "recordingID": "<returned UUID>", "stepID": "enable-preference" }
```

Then call `finish_recording` with `{ "recordingID": "<returned UUID>" }`.

### Actions and conditions

Actions are limited to existing fixed operations: `navigate` with an HTTP/HTTPS URL; `click` with a selector; `type` with selector/text; `select` with selector/value; `check` with selector/checked; and `scroll` with deltaY. Navigation stays in the same owned tab. Password fields cannot be recorded as replayable input.

Conditions can assert a URL or a unique selector's normalized text, native value, checked state, or visibility. Text comparisons trim and collapse whitespace. An absent selector satisfies only `visible: false`; ambiguous selectors never pass. Native password values are never inspected. Conditions are checked before action and polled briefly afterward to allow UI updates.

`goalVerified` means **the declared browser conditions passed**. It is not independent proof that a task description was fulfilled, a backend transaction committed, or a webhook ran. Choose meaningful checks and verify external effects separately when required.

## Artifacts and replay

Exports live under the permanent installation's `.local/recordings/<generated UUID>/`:

- `walkthrough.webm`: a 960×540, 10 fps, VP8 video of accepted segments, with edited-walkthrough and step captions.
- `actions.json`: the declared task/goal, starting URL, accepted steps with literal selectors and arguments, pre/postconditions, final checks, excluded-attempt count, video timeline for each step, and a `replayPlan` containing only the accepted plan fields.

POSIX directories/files use private permissions. On Windows, inherited NTFS permissions apply. Paths are generated by the bridge, not supplied by the model. Video bytes are not returned into model context; artifact responses identify the routing `profileID`. Post-export in-memory cleanup is pinned to that profile and never retargeted to a newly selected profile. If selection changed during file persistence, select the original profile and explicitly cancel any retained recording. Exported files are excluded from packages and releases.

To replay, explicitly authorize it, open a new owned tab at `initialURL`, pass `replayPlan` plus its new `tabID` to `start_recording`, and run the steps in order. Selectors must remain unique and preconditions must match. The plan is deterministic; the website, account state, and network are not. Replay can repeat external side effects, so it is never automatic.

## Limits and setup

- Reload the extension and accept its `debugger` and `offscreen` permissions, then reconnect `chrome` in OpenCode to discover the four recording tools. Existing pairing is preserved.
- In global shared mode, adapter reconnection alone does not reload an already running daemon. Coordinate with other users of that Chrome profile, then run `npm run stop:shared` from the installation directory before reconnecting `chrome`; the adapter starts the updated daemon. Stopping interrupts browser access across projects. No daemon is stopped automatically by this feature.
- A debugging banner may appear while a step is captured. Close DevTools on the target tab if attachment fails. No generic CDP or page-evaluation tool is exposed.
- Approval of `chrome_run_recording_step` covers all declared actions in that step. It does not request separate `chrome_click`/`chrome_type` approvals. The supervised `chrome_*` permission example already asks for recording tools; custom rules covering only individual interaction tools must also require approval for this macro. No user permissions are changed automatically.
- Plans allow up to 10 steps, 5 actions per step, and 10 conditions per phase. Each captured step is limited to 15 seconds; the final video is limited to 90 seconds and 5 MiB.
- Up to three recordings are retained in memory, with a 32 MiB frame budget per recording. Only one step may capture at a time; concurrent captures fail safely rather than interleaving. Video exports are serialized by the offscreen encoder.
- Disabling access, connection loss, tab closure, or navigation to a protected page cancels capture and clears affected in-memory recordings. Previously exported files remain untouched.
- Main-frame selectors only. Audio, desktop/terminal capture, automatic secret redaction, and external application verification are not supported. Screenshots can contain sensitive data even when password fields are masked.

## Verification and local demo

`npm run check` exercises plan validation, order/immutability, session isolation, exclusion, cancellation, output privacy, and deterministic WebM container construction. Real Chrome capture/encoding is opt-in and runs in Linux CI:

```sh
CHROME_BINARY="/path/to/chrome" npm run test:browser
```

To retain a harmless demo video and manifest from the local regression page:

```sh
SAVE_RECORDING_DEMO=1 CHROME_BINARY="/path/to/chrome" npm run test:browser
```

The test uses a temporary headless profile, deliberately fails one attempt, then executes its predeclared successful steps and verifies that Chrome can load the exported WebM. It does not use signed-in accounts. The test's CDP adapter covers capture, browser input, navigation, and encoding; actual extension offscreen creation and permission prompts still need a manual smoke test.
