import { z } from 'zod';
import { keyboardKey, keyboardText } from '../extension/keyboard-keys.js';

const valid = (validate) => (value) => {
  try {
    validate(value);
    return true;
  } catch {
    return false;
  }
};
const focusToken = z
  .string()
  .max(100)
  .regex(/^(?:p(?:legacy|[0-9a-f-]{36}):)?k\d+:[0-9a-f-]{36}$/i)
  .describe(
    'Complete single-use read_page.focus.token. Call focus_tab/read_page first; never guess tokens. Tokens expire on focus/document changes and the next snapshot.',
  );

export function keyboardToolDefinitions(tabID) {
  return [
    [
      'press_key',
      'Send one trusted key/chord to the current focused control of an owned foreground tab, using a fresh focus token. Supports Enter, Tab, Escape, arrows, Home/End, PageUp/Down, F2, letters/digits, Shift, Control/Meta+A/Z/Y and guarded navigation. Clipboard/browser shortcuts are blocked. Can submit/delete/modify data; approval is required as for other write actions. dispatched is not proof of application acceptance. Read again to verify; never blindly retry.',
      {
        tabID,
        focusToken,
        key: z.string().max(80).refine(valid(keyboardKey), 'Unsupported or unsafe key chord.'),
      },
    ],
    [
      'insert_text',
      'Insert literal text using trusted browser input at the focused editable control/caret of an owned foreground tab. Requires a fresh focus token. Does not replace the whole field: use Control+A then read again to replace its selection. Never reads/writes the system clipboard. Tabs/newlines are literal input, not guaranteed spreadsheet multi-cell paste. Read page/formula/accessibility state or screenshot to verify; no automatic retries.',
      {
        tabID,
        focusToken,
        text: z
          .string()
          .min(1)
          .max(10000)
          .refine(valid(keyboardText), 'Unsupported text control characters.'),
      },
    ],
  ];
}
