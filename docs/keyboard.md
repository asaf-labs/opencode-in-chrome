# Trusted keyboard input

`press_key` and `insert_text` use Chrome debugger input in a conversation-owned foreground tab. They do not read or overwrite the system clipboard and never automatically retry edits. Existing `type` replaces an element's value through DOM APIs; `insert_text` instead inserts at the focused editable caret/selection.

## Workflow

1. Select the authorized Chrome profile and open an owned tab. Obtain approval for writes as required by the user's task.
2. Use `focus_tab`, then click the intended control or use the application's own cell/address control. Take `read_page` after establishing focus.
3. Copy the complete `focus.token` into `press_key({focusToken, key})` or `insert_text({focusToken, text})`. Include `profileID`/`tabID` when targeting them explicitly.
4. Take a fresh snapshot before every next command. To replace selected editor contents, use `Control+a`, read again, then `insert_text`. Selection scope is application-dependent; verify it before replacing data.
5. Commit using the application's expected key (for example Enter or Tab), using another fresh token. Verify the intended cell/value and saved application state through accessible state, a formula/address control, or a screenshot. Do not infer success from focus metadata alone.

`focus` is null when no unambiguous accessible frame reports eligible focus. Otherwise it reports `token`, `frameID`, `tag`, `type`, `role`, `label`, and `editable`; named profiles also include `profileID`. Tokens look like `p<profileID>:k<frameID>:<UUID>` (legacy profiles omit the profile prefix). Copy them unchanged. Focus metadata has no value or selection fields; labels remain page-provided text. Native password values are never included or retained for focus comparison.

Tokens are single-use and expire on the next snapshot in that frame, document/focus changes, or changed non-password editor contents/caret. Existing command expiry also applies. Guards validate ownership, foreground tab/window, observed frame/document, generation and cancellation before dispatch. A hidden iframe editor can be eligible when actually focused; the tools do not choose a spreadsheet cell from canvas coordinates. Input and focus checks are not atomic with user/page activity.

## Supported input

- Named keys: Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown and F2; letters and digits, optionally Shift.
- Editing chords: Control/Meta+A/Y (without Shift), Control/Meta+Z (with or without Shift), and Control/Meta+Enter.
- Control navigation: Home, End, arrows, Backspace, Delete and Space, optionally Shift, except Shift+Delete and Control+Shift+Backspace/Delete.
- `Ctrl` aliases Control; `Cmd`/`Command` alias Meta. Alt, arbitrary function keys, clipboard and browser-level shortcuts are blocked. Use `insert_text` for literal punctuation, Unicode and text rather than keyboard-layout assumptions.
- Text: 1–10,000 characters; control characters other than tabs/newlines are rejected. Tabs/newlines are literal input, **not clipboard paste or guaranteed multi-cell TSV insertion**.

Both tools return `dispatched: true`, `applicationAccepted: null`, and `focusTokenConsumed: true`. A dispatch error after attempted input warns that the page may already have changed. Inspect before retrying; do not silently repeat writes. Key-up cleanup is attempted in reverse order, with immediate debugger release after failures. Successful input shares the 30-second idle debugger lease with clicks/inspection; Chrome may display its debugger banner.

Keyboard tools are not supported in recording plans. Real-Chrome tests cover a local canvas grid with a focused hidden iframe editor, trusted key/input events, Unicode replacement and Enter/Tab commits. They do not establish compatibility with real Google Sheets, extension permission prompts, or every canvas editor. Use an explicitly authorized disposable sheet for application testing, never production data as a diagnostic.

## Activate after upgrade

Update the installation, reload the unpacked extension in each opted-in profile (content version 10), and reconnect the MCP adapters to discover **29 tools**. In shared mode, coordinate and obtain authorization before `npm run stop:shared` from the installation directory: stopping the daemon interrupts all connected projects/profiles. Reconnecting then starts the updated daemon; reconnecting adapters alone does not update an already-running daemon. Verify both new tools appear before use. Updating code does not itself activate Chrome-side changes or authorize edits.
