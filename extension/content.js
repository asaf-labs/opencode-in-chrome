(() => {
  if (globalThis.__opencodeChrome?.version === 8) return;
  globalThis.__opencodeChrome?.dispose?.();
  globalThis.__opencodeChrome?.setEnabled?.(false);
  let refs = new Map(),
    refCounter = 0,
    snapshotURL;
  let snapshotRevision = 0;
  const documentID = crypto.randomUUID();
  let controlHost, controlShadow, cursor, target, status, indicator, toggle, panel, idleTimer;
  let indicatorHidden = false;
  function setIndicatorHidden(value) {
    indicatorHidden = !!value;
    if (indicatorHidden && indicator) indicator.hidden = true;
  }
  let enabled = true,
    cursorShown = false,
    controlRevision = 0;
  const cancelledActions = new Set();
  function setEnabled(value) {
    if (enabled !== value) controlRevision++;
    enabled = value;
    if (!value) {
      controlHost?.remove();
      clearTimeout(idleTimer);
      return;
    }
    if (controlHost?.isConnected) return;
    controlHost = document.createElement('div');
    controlHost.id = 'opencode-agent-overlay';
    controlHost.style.cssText =
      'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    controlShadow = controlHost.attachShadow({ mode: 'open' });
    // This is static extension UI; no page text is inserted as HTML.
    controlShadow.innerHTML = `
      <style>
        :host { pointer-events:none; }
        * { box-sizing:border-box; pointer-events:none!important; }
        [hidden] { display:none!important; }
        .indicator { position:fixed; top:10px; right:10px; color:#ffedd5; font:600 12px/1.4 system-ui,sans-serif; }
        .indicator button { pointer-events:auto!important; cursor:pointer; color:inherit; font:inherit;
          border:1px solid #fb923c; background:#24170ff2; }
        .toggle { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; padding:0; margin-left:auto; }
        .panel { margin-top:6px; padding:10px; max-width:240px; border:1px solid #fb923c;
          border-radius:8px; background:#24170ff2; box-shadow:0 2px 12px #0004; }
        .panel button { display:block; margin-top:8px; padding:4px 8px; border-radius:5px; }
        .dot { width:8px; height:8px; border-radius:50%; background:#fb923c; box-shadow:0 0 0 4px #fb923c25; }
        .cursor { position:fixed; top:0; left:0; opacity:0; transform:translate3d(50vw,50vh,0);
          transition:transform 240ms cubic-bezier(.2,.75,.25,1),opacity 150ms; filter:drop-shadow(0 2px 3px #0005); }
        .cursor svg { display:block; width:28px; height:34px; overflow:visible; }
        .cursor-label { position:absolute; top:29px; left:19px; padding:3px 7px; border-radius:5px;
          color:#fff; background:#c2410c; font:600 11px/1.2 system-ui,sans-serif; white-space:nowrap; }
        .target { position:fixed; border:2px solid #fb923c; border-radius:6px; background:#fb923c18;
          box-shadow:0 0 0 4px #fb923c15; opacity:0; transition:opacity 150ms; }
        .ring { position:absolute; top:-14px; left:-14px; width:32px; height:32px; border:2px solid #fb923c;
          border-radius:50%; background:#fb923c22; opacity:0; }
        .pulse { animation:pulse 600ms ease-out; }
        @keyframes pulse { 0% { opacity:1; transform:scale(.6); } 100% { opacity:0; transform:scale(2); } }
      </style>
      <div class="indicator" hidden>
        <button class="toggle" type="button" aria-label="OpenCode activity" aria-expanded="false" aria-controls="opencode-status"><span class="dot"></span></button>
        <div class="panel" id="opencode-status" hidden><span class="status" role="status"></span><button class="hide" type="button">Hide for this tab</button></div>
      </div>
      <div class="target" aria-hidden="true"></div>
      <div class="cursor" aria-hidden="true"><span class="ring"></span>
        <svg viewBox="0 0 28 34"><path d="M2 2 L2 26 L8.5 20 L14 31 L19 28.5 L13.5 18 L23 18 Z" fill="#f97316" stroke="#fff7ed" stroke-width="2" stroke-linejoin="round"/></svg>
        <span class="cursor-label">OpenCode</span>
      </div>`;
    cursor = controlShadow.querySelector('.cursor');
    target = controlShadow.querySelector('.target');
    status = controlShadow.querySelector('.status');
    indicator = controlShadow.querySelector('.indicator');
    toggle = controlShadow.querySelector('.toggle');
    panel = controlShadow.querySelector('.panel');
    toggle.onclick = () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      scheduleIdle(panel.hidden ? 1800 : 8000);
    };
    controlShadow.querySelector('.hide').onclick = () => {
      setIndicatorHidden(true);
      void globalThis.chrome?.runtime
        ?.sendMessage?.({ type: 'hide-activity-indicator' })
        ?.catch(() => {});
    };
    document.documentElement.append(controlHost);
    cursorShown = false;
  }
  function activity(label) {
    if (!enabled) return;
    setEnabled(true);
    status.textContent = `OpenCode · ${label}`;
    indicator.hidden = indicatorHidden || globalThis.top !== globalThis.self;
    scheduleIdle();
  }
  function scheduleIdle(delay = 1800) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      indicator.hidden = true;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      target.style.opacity = '0';
      cursor.style.opacity = '0';
      cursorShown = false;
    }, delay);
  }
  async function pointAt(element, label, commandID) {
    if (!enabled) throw new Error('Browser access is disabled.');
    const revision = controlRevision;
    activity(label);
    const rect = element.getBoundingClientRect();
    const x = Math.max(4, Math.min(innerWidth - 32, rect.left + rect.width / 2));
    const y = Math.max(4, Math.min(innerHeight - 38, rect.top + rect.height / 2));
    if (!cursorShown) {
      cursor.style.opacity = '1';
      cursorShown = true;
    }
    cursor.style.transform = `translate3d(${x}px,${y}px,0)`;
    Object.assign(target.style, {
      left: `${rect.left - 3}px`,
      top: `${rect.top - 3}px`,
      width: `${rect.width + 6}px`,
      height: `${rect.height + 6}px`,
      opacity: '1',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (commandID && cancelledActions.has(commandID))
      throw new Error('Browser action cancelled before execution.');
    if (!enabled || revision !== controlRevision)
      throw new Error('Browser access was disabled before the action.');
    const ring = controlShadow.querySelector('.ring');
    ring.classList.remove('pulse');
    void ring.offsetWidth;
    ring.classList.add('pulse');
  }
  setEnabled(true);
  const interactiveRoles = [
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'option',
    'combobox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'textbox',
    'searchbox',
    'treeitem',
    'spinbutton',
    'slider',
  ];
  const interactiveSelector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    'label',
    '[contenteditable="true"]',
    ...interactiveRoles.map((role) => `[role~="${role}"]`),
  ].join(',');
  const popupSelector = '[role~="listbox"],[role~="menu"],[role~="dialog"],[aria-modal="true"]';
  const text = (element) =>
    (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  function label(element) {
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .filter(Boolean)
      .join(' ');
    return (
      labelledBy ||
      element.getAttribute('aria-label') ||
      [...(element.labels || [])].map(text).filter(Boolean).join(' ') ||
      text(element) ||
      element.placeholder ||
      element.name ||
      ''
    ).slice(0, 300);
  }
  function disabled(element) {
    return element.matches(':disabled') || !!element.closest('[aria-disabled="true"],[inert]');
  }
  function visible(element) {
    const style = getComputedStyle(element);
    return (
      element.getClientRects().length > 0 &&
      !element.closest('[hidden]') &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  }
  function frameContext() {
    const framePath = [];
    let current = window;
    while (current !== window.top) {
      const parent = current.parent;
      let index = -1;
      // WindowProxy identity and indexed frames are accessible across origins;
      // do not inspect another frame's DOM or trust page-supplied routing data.
      for (let i = 0; i < parent.length; i++) {
        if (parent.frames[i] === current) {
          index = i;
          break;
        }
      }
      if (index < 0 || framePath.length >= 32)
        throw new Error('Could not resolve frame ancestry safely.');
      framePath.unshift(index);
      current = parent;
    }
    return { documentID, framePath, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }
  function projectFramePoint(args) {
    if (!enabled || cancelledActions.has(args.commandID) || args.documentID !== documentID) {
      throw new Error('Containing frame changed or browser access stopped.');
    }
    const context = frameContext();
    if (JSON.stringify(context.framePath) !== JSON.stringify(args.framePath))
      throw new Error('Containing frame moved.');
    const child = window.frames[args.childIndex];
    const host = [...document.querySelectorAll('iframe,frame')].find(
      (element) => element.contentWindow === child,
    );
    if (!child || !host || !visible(host) || disabled(host))
      throw new Error('Containing iframe is unavailable or disabled.');
    for (let ancestor = host; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.rotate && !['none', '0deg'].includes(style.rotate))
        throw new Error('Rotated iframe clicks are not supported.');
      if (style.perspective && style.perspective !== 'none')
        throw new Error('Perspective iframe clicks are not supported.');
      if (
        style.scale &&
        style.scale !== 'none' &&
        style.scale.split(/\s+/).some((value) => Number(value) <= 0)
      )
        throw new Error('Reflected iframe clicks are not supported.');
      if (style.transform && style.transform !== 'none') {
        const matrix = new DOMMatrixReadOnly(style.transform);
        if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0)
          throw new Error('Rotated, skewed, or reflected iframe clicks are not supported.');
      }
    }
    const rect = host.getBoundingClientRect(),
      style = getComputedStyle(host);
    if (!host.offsetWidth || !host.offsetHeight || !args.viewportWidth || !args.viewportHeight)
      throw new Error('Containing iframe has no usable viewport.');
    const sx = rect.width / host.offsetWidth,
      sy = rect.height / host.offsetHeight;
    const edge = (name) => parseFloat(style[name]) || 0;
    const left = (edge('borderLeftWidth') + edge('paddingLeft')) * sx;
    const right = (edge('borderRightWidth') + edge('paddingRight')) * sx;
    const top = (edge('borderTopWidth') + edge('paddingTop')) * sy;
    const bottom = (edge('borderBottomWidth') + edge('paddingBottom')) * sy;
    const x = rect.left + left + (args.x * (rect.width - left - right)) / args.viewportWidth;
    const y = rect.top + top + (args.y * (rect.height - top - bottom)) / args.viewportHeight;
    if (
      x < 0 ||
      x >= innerWidth ||
      y < 0 ||
      y >= innerHeight ||
      document.elementFromPoint(x, y) !== host
    )
      throw new Error('Containing iframe is outside the viewport or covered by another element.');
    return { x, y, ...context };
  }
  function clickPoint(element) {
    for (const rect of element.getClientRects()) {
      const left = Math.max(0, rect.left),
        top = Math.max(0, rect.top),
        right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom);
      if (right <= left || bottom <= top) continue;
      const x = (left + right) / 2,
        y = (top + bottom) / 2,
        hit = document.elementFromPoint(x, y);
      if (hit && (hit === element || element.contains(hit))) return { x, y };
    }
    throw new Error('Click target is outside the viewport or covered by another element.');
  }
  function validateClick(args) {
    if (args.commandID && cancelledActions.has(args.commandID))
      throw new Error('Browser action cancelled before execution.');
    if (!enabled) throw new Error('Browser access is disabled.');
    const element = refs.get(args.ref);
    if (
      args.documentID !== documentID ||
      args.snapshotRevision !== snapshotRevision ||
      args.controlRevision !== controlRevision ||
      snapshotURL !== location.href ||
      !element?.isConnected ||
      !visible(element) ||
      disabled(element)
    )
      throw new Error('Click target changed or became disabled. Call read_page again.');
    const point = clickPoint(element);
    if (point.x !== args.x || point.y !== args.y)
      throw new Error('Click target moved. Call read_page again.');
    if (args.framePath) {
      const context = frameContext();
      if (
        JSON.stringify(context.framePath) !== JSON.stringify(args.framePath) ||
        context.viewportWidth !== args.viewportWidth ||
        context.viewportHeight !== args.viewportHeight
      )
        throw new Error('Click frame moved or resized. Call read_page again.');
    }
    return { valid: true };
  }
  function run(tool, args = {}) {
    if (typeof args.indicatorHidden === 'boolean') setIndicatorHidden(args.indicatorHidden);
    if (args.commandID && cancelledActions.has(args.commandID))
      throw new Error('Browser action cancelled before execution.');
    if (!enabled) throw new Error('Browser access is disabled.');
    if (tool === 'read_page') {
      activity('Reading page');
      refs = new Map();
      snapshotRevision++;
      snapshotURL = location.href;
      const elements = [];
      const candidates = [...document.querySelectorAll(interactiveSelector)].filter(
        (el) =>
          visible(el) &&
          (!el.matches('label') ||
            el.control?.matches('input[type="checkbox"],input[type="radio"]')),
      );
      // Portalled popup options often follow hundreds of table controls in DOM order.
      // Keep open menus/listboxes/dialogs ahead of background controls at the ref cap.
      candidates.sort(
        (a, b) => Number(!a.closest(popupSelector)) - Number(!b.closest(popupSelector)),
      );
      for (const el of candidates.slice(0, 300)) {
        const ref = `e${++refCounter}`;
        refs.set(ref, el);
        const entry = {
          ref,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('role') || el.type || null,
          label: label(el),
          disabled: disabled(el),
        };
        if (el.matches('input,textarea,select') && el.type !== 'password')
          entry.value = el.value?.slice(0, 2000);
        if (el.matches('select'))
          entry.options = [...el.options]
            .slice(0, 100)
            .map((o) => ({ value: o.value, text: o.text }));
        if (el.matches('input[type="checkbox"],input[type="radio"]')) entry.checked = el.checked;
        const checked = el.getAttribute('aria-checked');
        if (checked === 'true' || checked === 'false') entry.checked = checked === 'true';
        else if (checked === 'mixed') entry.checked = 'mixed';
        const selected = el.getAttribute('aria-selected');
        if (selected === 'true' || selected === 'false') entry.ariaSelected = selected === 'true';
        const expanded = el.getAttribute('aria-expanded');
        if (expanded === 'true' || expanded === 'false') entry.expanded = expanded === 'true';
        if (el.matches('a')) entry.href = el.href;
        elements.push(entry);
      }
      return {
        documentID,
        title: document.title,
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 40000),
        elements,
        totalElements: candidates.length,
        elementsTruncated: candidates.length > elements.length,
        ...frameContext(),
      };
    }
    if (tool === 'scroll') {
      if (args.documentID && args.documentID !== documentID)
        throw new Error('Frame changed. Call read_page again.');
      activity('Scrolling');
      cursor.style.opacity = '1';
      cursorShown = true;
      cursor.style.transform = `translate3d(${innerWidth / 2}px,${args.deltaY >= 0 ? innerHeight * 0.75 : innerHeight * 0.25}px,0)`;
      window.scrollBy({ top: args.deltaY, behavior: 'instant' });
      return { scrollY: window.scrollY };
    }
    if (args.documentID !== documentID || snapshotURL !== location.href)
      throw new Error('Page changed. Call read_page again.');
    const el = refs.get(args.ref);
    const revision = snapshotRevision;
    if (!el || !el.isConnected || !visible(el))
      throw new Error('Element ref expired. Call read_page again.');
    if (disabled(el)) throw new Error('Element is disabled');
    el.scrollIntoView({ block: 'center' });
    return (async () => {
      await pointAt(
        el,
        { click: 'Clicking', type: 'Typing', select: 'Selecting', check: 'Checking' }[tool] ||
          'Working',
        args.commandID,
      );
      if (
        revision !== snapshotRevision ||
        !el.isConnected ||
        snapshotURL !== location.href ||
        !visible(el) ||
        disabled(el)
      )
        throw new Error('Page changed before the action. Call read_page again.');
      if (tool === 'click') {
        const target = {
          ...clickPoint(el),
          documentID,
          snapshotRevision,
          controlRevision,
          ...(window !== window.top ? frameContext() : {}),
        };
        validateClick({ ...args, ...target });
        return { clickTarget: target };
      } else if (tool === 'type') {
        if (el.matches('input,textarea')) {
          if (
            el.readOnly ||
            (el.tagName === 'INPUT' &&
              ['checkbox', 'radio', 'file', 'submit', 'button', 'hidden'].includes(el.type))
          )
            throw new Error('Element is not a text input');
          el.focus();
          const prototype =
            el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, args.text);
        } else if (el.isContentEditable) {
          el.focus();
          el.textContent = args.text;
        } else throw new Error('Element is not editable');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tool === 'select') {
        if (
          !el.matches('select') ||
          ![...el.options].some((o) => o.value === args.value && !o.disabled)
        )
          throw new Error('Dropdown option not found');
        el.value = args.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (tool === 'check') {
        if (!el.matches('input[type="checkbox"],input[type="radio"]'))
          throw new Error('Element is not a checkbox or radio');
        if (el.checked !== args.checked) el.click();
        if (el.checked !== args.checked)
          throw new Error('Page did not accept the requested checked state');
      } else throw new Error('Unknown browser action');
      return { ok: true, url: location.href };
    })();
  }
  const onMessage = (message, sender, respond) => {
    if (sender.id !== globalThis.chrome?.runtime?.id) return;
    if (message.type === 'opencode-disable') setEnabled(false);
    else if (message.type === 'opencode-cancel' && typeof message.id === 'string') {
      cancelledActions.add(message.id);
      if (cancelledActions.size > 100)
        cancelledActions.delete(cancelledActions.values().next().value);
    } else return;
    respond?.({ ok: true });
  };
  globalThis.chrome?.runtime?.onMessage?.addListener(onMessage);
  globalThis.__opencodeChrome = {
    version: 8,
    run,
    validateClick,
    frameContext,
    projectFramePoint,
    setEnabled,
    setIndicatorHidden,
    dispose: () => {
      setEnabled(false);
      globalThis.chrome?.runtime?.onMessage?.removeListener(onMessage);
    },
  };
})();
