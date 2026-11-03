const named = {
  Enter: [13, 'Enter'],
  Tab: [9, 'Tab'],
  Escape: [27, 'Escape'],
  Backspace: [8, 'Backspace'],
  Delete: [46, 'Delete'],
  Space: [32, 'Space'],
  ArrowLeft: [37, 'ArrowLeft'],
  ArrowUp: [38, 'ArrowUp'],
  ArrowRight: [39, 'ArrowRight'],
  ArrowDown: [40, 'ArrowDown'],
  Home: [36, 'Home'],
  End: [35, 'End'],
  PageUp: [33, 'PageUp'],
  PageDown: [34, 'PageDown'],
  F2: [113, 'F2'],
};
const modifiers = {
  Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, bit: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, bit: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, bit: 8 },
};

export function keyboardKey(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Unsupported key chord.');
  const parts = value.split('+');
  const base = parts.pop();
  const mods = parts.map(
    (part) => ({ Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta' })[part] || part,
  );
  if (
    new Set(mods).size !== mods.length ||
    mods.some((mod) => !Object.hasOwn(modifiers, mod)) ||
    (mods.includes('Control') && mods.includes('Meta'))
  )
    throw new Error('Unsupported key modifiers.');
  const shifted = mods.includes('Shift');
  const lower = base.toLowerCase();
  const control = mods.includes('Control'),
    meta = mods.includes('Meta');
  if (shifted && (base === 'Delete' || (control && base === 'Backspace')))
    throw new Error('Clipboard and browser-level shortcuts are not supported.');
  if (control || meta) {
    const editing =
      ((lower === 'a' || lower === 'y') && !shifted) || lower === 'z' || base === 'Enter';
    const navigation =
      control &&
      [
        'Home',
        'End',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Backspace',
        'Delete',
        'Space',
      ].includes(base);
    if (!editing && !navigation)
      throw new Error(
        'Clipboard and browser-level shortcuts are not supported. Use insert_text for literal text.',
      );
  }
  let key, code, windowsVirtualKeyCode, text;
  if (Object.hasOwn(named, base)) {
    [windowsVirtualKeyCode, code] = named[base];
    key = base === 'Space' ? ' ' : base;
    if (!control && !meta) text = base === 'Enter' ? '\r' : base === 'Space' ? ' ' : undefined;
  } else if (/^[a-zA-Z0-9]$/.test(base)) {
    key = /^[a-zA-Z]$/.test(base) ? (shifted ? base.toUpperCase() : lower) : base;
    code = /^[a-zA-Z]$/.test(base) ? `Key${base.toUpperCase()}` : `Digit${base}`;
    windowsVirtualKeyCode = base.toUpperCase().charCodeAt(0);
    if (!control && !meta)
      text = shifted && /^[0-9]$/.test(base) ? ')!@#$%^&*('[Number(base)] : key;
    if (text) key = text;
  } else throw new Error('Unsupported key. Use a navigation/editing key, F2, letter, or digit.');
  return {
    modifiers: mods.map((mod) => modifiers[mod]),
    key: {
      key,
      code,
      windowsVirtualKeyCode,
      ...(text
        ? { text, unmodifiedText: base === 'Enter' ? '\r' : base === 'Space' ? ' ' : lower }
        : {}),
    },
  };
}

export function keyboardText(text) {
  if (
    typeof text !== 'string' ||
    !text.length ||
    text.length > 10000 ||
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    })
  )
    throw new Error(
      'Text must contain 1–10000 characters, with no control characters except tabs/newlines.',
    );
  return text;
}

export function parseFocusToken(token) {
  const match = /^k(\d+):([0-9a-f-]{36})$/i.exec(token || '');
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new Error('Use the complete focus token from a fresh read_page.');
  return { frameID: Number(match[1]), token: match[2] };
}
