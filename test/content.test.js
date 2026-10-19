import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const script = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
function page(t, chrome) {
  const dom = new JSDOM(
    `<!doctype html><title>Account</title><body>
    <button id="button">Save</button><input id="name" aria-label="Name" value="Old">
    <input id="secret" type="password" value="private"><input id="box" type="checkbox">
    <select id="select"><option value="a">A</option><option value="b">B</option></select>
    <input id="disabled" disabled><button id="hidden" style="display:none">Hidden</button>
  </body>`,
    { url: 'https://example.com', runScripts: 'outside-only' },
  );
  const { window } = dom;
  if (chrome) window.chrome = chrome;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 10,
    top: 10,
    right: 110,
    bottom: 30,
    width: 100,
    height: 20,
  });
  window.HTMLElement.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()];
  };
  window.document.elementFromPoint = () => window.document.getElementById('button');
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(script);
  t.after(() => window.close());
  return { run: window.__opencodeChrome.run, document: window.document, window };
}

test('snapshot exposes visible controls without password values', (t) => {
  const { run } = page(t),
    snapshot = run('read_page');
  assert.equal(snapshot.title, 'Account');
  assert.ok(snapshot.elements.some((e) => e.label === 'Name'));
  assert.ok(!snapshot.elements.some((e) => e.label === 'Hidden'));
  assert.equal(snapshot.elements.find((e) => e.type === 'password').value, undefined);
  assert.equal(snapshot.elements.find((e) => e.tag === 'select').options[1].value, 'b');
});

test('searchable portalled multiselect exposes cmdk options as browser click refs', async (t) => {
  const { run, document, window } = page(t);
  const portal = document.createElement('div');
  portal.innerHTML = `<div role="dialog"><input id="portal-search" role="combobox" aria-label="Search portals" aria-expanded="true">
    <div role="listbox" aria-multiselectable="true">
      <div id="coupa" role="option" aria-selected="true" cmdk-item=""><div aria-hidden="true"><svg></svg></div><span>Coupa</span></div>
      <div id="other" role="option" cmdk-item=""><span>Other portal</span></div>
    </div></div>`;
  document.body.append(portal);
  document.getElementById('portal-search').addEventListener('input', () => {
    document.getElementById('other').hidden = true;
  });
  const first = run('read_page');
  const search = first.elements.find((element) => element.label === 'Search portals');
  assert.equal(search.type, 'combobox');
  assert.equal(search.expanded, true);
  await run('type', { ref: search.ref, documentID: first.documentID, text: 'Coupa' });
  const snapshot = run('read_page');
  const coupa = snapshot.elements.find((element) => element.label === 'Coupa');
  assert.equal(coupa.type, 'option');
  assert.equal(coupa.ariaSelected, true);
  assert.equal(
    snapshot.elements.some((element) => element.label === 'Other portal'),
    false,
  );
  document.elementFromPoint = () => document.querySelector('#coupa span');
  const args = { ref: coupa.ref, documentID: snapshot.documentID };
  const { clickTarget } = await run('click', args);
  assert.equal(window.__opencodeChrome.validateClick({ ...args, ...clickTarget }).valid, true);
});

test('custom checkbox, menu, tab, and switch roles expose labels and ARIA state', async (t) => {
  const { run, document } = page(t);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<span id="coupa-name">Coupa</span>
    <button role="checkbox" aria-labelledby="coupa-name" aria-checked="false">Decorative text</button>
    <div role="menuitemcheckbox" aria-label="Portal option" aria-checked="mixed"></div>
    <div role="menuitemradio" aria-label="Radio option" aria-checked="true"></div>
    <div role="switch" aria-label="Enabled" aria-checked="false"></div>
    <div role="tab" aria-label="Invoices" aria-selected="true"></div>
    <div role="option" aria-label="Disabled option" aria-disabled="true"></div>`,
  );
  const snapshot = run('read_page');
  const coupa = snapshot.elements.find((element) => element.label === 'Coupa');
  assert.equal(coupa.type, 'checkbox');
  assert.equal(coupa.checked, false);
  assert.equal(
    snapshot.elements.find((element) => element.label === 'Portal option').checked,
    'mixed',
  );
  assert.equal(snapshot.elements.find((element) => element.label === 'Radio option').checked, true);
  assert.equal(snapshot.elements.find((element) => element.label === 'Enabled').checked, false);
  assert.equal(
    snapshot.elements.find((element) => element.label === 'Invoices').ariaSelected,
    true,
  );
  const disabled = snapshot.elements.find((element) => element.label === 'Disabled option');
  assert.equal(disabled.disabled, true);
  assert.throws(
    () => run('click', { ref: disabled.ref, documentID: snapshot.documentID }),
    /disabled/,
  );
});

test('visible checkbox labels remain clickable when the native input is visually hidden', async (t) => {
  const { run, document } = page(t);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<input id="hidden-checkbox" type="checkbox" style="display:none">
    <label for="hidden-checkbox">Coupa</label><label>Unassociated decoration</label>`,
  );
  const snapshot = run('read_page');
  const label = snapshot.elements.find((element) => element.tag === 'label');
  assert.equal(label.label, 'Coupa');
  assert.equal(
    snapshot.elements.some((element) => element.label === 'Unassociated decoration'),
    false,
  );
  document.elementFromPoint = () => document.querySelector('label');
  assert.ok((await run('click', { ref: label.ref, documentID: snapshot.documentID })).clickTarget);
});

test('open popup controls get refs ahead of background tables at the snapshot cap', (t) => {
  const { run, document } = page(t);
  for (let index = 0; index < 310; index++) {
    const button = document.createElement('button');
    button.textContent = `Background action ${index}`;
    document.body.append(button);
  }
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div role="listbox"><div role="option">Coupa</div></div>',
  );
  const snapshot = run('read_page');
  assert.equal(snapshot.elements.length, 300);
  assert.equal(snapshot.elements[0].label, 'Coupa');
  assert.equal(snapshot.elementsTruncated, true);
  assert.equal(snapshot.totalElements, 317);
});

test('newly discovered custom-control refs still expire on a new snapshot', async (t) => {
  const { run, document } = page(t);
  document.body.insertAdjacentHTML('beforeend', '<div role="option">Coupa</div>');
  const first = run('read_page');
  const option = first.elements.find((element) => element.label === 'Coupa');
  run('read_page');
  assert.throws(
    () => run('click', { ref: option.ref, documentID: first.documentID }),
    /ref expired/,
  );
});

test('form interaction updates values and dispatches page events', async (t) => {
  const { run, document } = page(t),
    snapshot = run('read_page');
  const args = (ref) => ({ ref, documentID: snapshot.documentID });
  let inputEvents = 0,
    clicks = 0;
  document.getElementById('name').addEventListener('input', () => inputEvents++);
  document.getElementById('button').addEventListener('click', () => clicks++);
  const name = snapshot.elements.find((e) => e.label === 'Name');
  await run('type', { ...args(name.ref), text: 'Alice' });
  assert.equal(document.getElementById('name').value, 'Alice');
  assert.equal(inputEvents, 1);
  const prepared = await run('click', args(snapshot.elements.find((e) => e.tag === 'button').ref));
  assert.equal(clicks, 0);
  assert.equal(prepared.clickTarget.documentID, snapshot.documentID);
  assert.equal(prepared.ok, undefined);
  await run('select', {
    ...args(snapshot.elements.find((e) => e.tag === 'select').ref),
    value: 'b',
  });
  assert.equal(document.getElementById('select').value, 'b');
  const box = snapshot.elements.find((e) => e.type === 'checkbox');
  await run('check', { ...args(box.ref), checked: true });
  await run('check', { ...args(box.ref), checked: true });
  assert.equal(document.getElementById('box').checked, true);
  assert.throws(
    () => run('type', { ...args(snapshot.elements.find((e) => e.disabled).ref), text: 'x' }),
    /disabled/,
  );
});

test('old refs cannot target different elements after a fresh snapshot', (t) => {
  const { run } = page(t),
    first = run('read_page'),
    second = run('read_page');
  assert.notEqual(first.elements[0].ref, second.elements[0].ref);
  assert.throws(
    () => run('click', { ref: first.elements[0].ref, documentID: first.documentID }),
    /ref expired/,
  );
  assert.throws(
    () => run('click', { ref: second.elements[0].ref, documentID: 'another-document' }),
    /Page changed/,
  );
});

test('removed refs fail and re-injection preserves the document snapshot', (t) => {
  const { run, document, window } = page(t),
    snapshot = run('read_page');
  window.eval(script);
  assert.equal(window.__opencodeChrome.run, run);
  document.getElementById('button').remove();
  assert.throws(
    () => run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID }),
    /ref expired/,
  );
});

test('same-document navigation invalidates action refs', (t) => {
  const { run, window } = page(t),
    snapshot = run('read_page');
  window.history.pushState({}, '', '/another-page');
  assert.throws(
    () => run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID }),
    /Page changed/,
  );
});

test('agent cursor highlights a target without following the user mouse or polluting refs', async (t) => {
  const { run, document, window } = page(t);
  const button = document.getElementById('button');
  button.getBoundingClientRect = () => ({
    left: 100,
    top: 200,
    right: 180,
    bottom: 240,
    width: 80,
    height: 40,
  });
  const snapshot = run('read_page');
  assert.equal(snapshot.elements.length, 6);
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  const promise = run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID });
  const host = document.getElementById('opencode-agent-overlay');
  const cursor = host.shadowRoot.querySelector('.cursor');
  assert.equal(host.style.pointerEvents, 'none');
  assert.equal(cursor.style.transform, 'translate3d(140px,220px,0)');
  assert.equal(clicks, 0);
  window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 600, clientY: 500 }));
  assert.equal(cursor.style.transform, 'translate3d(140px,220px,0)');
  const prepared = await promise;
  assert.deepEqual(
    { ...prepared.clickTarget, documentID: 'document' },
    {
      x: 140,
      y: 220,
      documentID: 'document',
      snapshotRevision: 1,
      controlRevision: 0,
    },
  );
  assert.equal(clicks, 0);
  assert.match(host.shadowRoot.querySelector('.status').textContent, /Clicking/);
});

test('activity dot starts hidden, expands on click, can be hidden without disabling actions, and fades at idle', async (t) => {
  const messages = [];
  const { run, document, window } = page(t, {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
      },
    },
  });
  const shadow = document.getElementById('opencode-agent-overlay').shadowRoot;
  const indicator = shadow.querySelector('.indicator');
  const toggle = shadow.querySelector('.toggle');
  const panel = shadow.querySelector('.panel');
  assert.equal(indicator.hidden, true);
  assert.equal(panel.hidden, true);
  let idle;
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, ms) =>
    ms === 1800 ? ((idle = callback), 0) : timeout(callback, ms);
  const snapshot = run('read_page');
  assert.equal(indicator.hidden, false);
  assert.equal(snapshot.elements.length, 6);
  toggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  shadow.querySelector('.hide').click();
  assert.equal(indicator.hidden, true);
  assert.equal(messages[0].type, 'hide-activity-indicator');
  await run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID });
  assert.equal(indicator.hidden, true);
  assert.equal(shadow.querySelector('.cursor').style.opacity, '1');
  idle();
  assert.equal(shadow.querySelector('.cursor').style.opacity, '0');
  assert.equal(panel.hidden, true);
  window.__opencodeChrome.setIndicatorHidden(false);
  run('read_page');
  assert.equal(indicator.hidden, false);
  idle();
  assert.equal(indicator.hidden, true);
});

test('disabling removes the indicator and cancels an action before its click', async (t) => {
  const { run, document, window } = page(t),
    snapshot = run('read_page');
  let clicks = 0;
  document.getElementById('button').addEventListener('click', () => clicks++);
  const promise = run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID });
  const rejected = assert.rejects(promise, /disabled before the action/);
  window.__opencodeChrome.setEnabled(false);
  assert.equal(document.getElementById('opencode-agent-overlay'), null);
  await rejected;
  assert.equal(clicks, 0);
});

test('an authenticated cancellation message stops the pending agent click', async (t) => {
  let listener;
  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: (value) => {
          listener = value;
        },
        removeListener: () => {},
      },
    },
  };
  const { run, document } = page(t, chrome),
    snapshot = run('read_page');
  let clicks = 0;
  document.getElementById('button').addEventListener('click', () => clicks++);
  const promise = run('click', {
    ref: snapshot.elements[0].ref,
    documentID: snapshot.documentID,
    commandID: 'action-one',
  });
  const rejected = assert.rejects(promise, /cancelled before execution/);
  listener({ type: 'opencode-cancel', id: 'action-one' }, { id: 'test-extension' });
  await rejected;
  assert.equal(clicks, 0);
});

test('a new snapshot cancels interactions waiting on an older snapshot', async (t) => {
  const { run, document } = page(t),
    snapshot = run('read_page');
  let clicks = 0;
  document.getElementById('button').addEventListener('click', () => clicks++);
  const pending = run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID });
  const rejected = assert.rejects(pending, /Page changed before the action/);
  run('read_page');
  await rejected;
  assert.equal(clicks, 0);
});

test('disable then quick re-enable cannot revive a pending interaction', async (t) => {
  const { run, document, window } = page(t),
    snapshot = run('read_page');
  let clicks = 0;
  document.getElementById('button').addEventListener('click', () => clicks++);
  const promise = run('click', { ref: snapshot.elements[0].ref, documentID: snapshot.documentID });
  const rejected = assert.rejects(promise, /disabled before the action/);
  window.__opencodeChrome.setEnabled(false);
  window.__opencodeChrome.setEnabled(true);
  await rejected;
  assert.equal(clicks, 0);
});

test('click preparation hit-tests descendants and never emits a synthetic click', async (t) => {
  const { run, document, window } = page(t);
  const button = document.getElementById('button');
  const child = document.createElement('span');
  button.append(child);
  document.elementFromPoint = () => child;
  const snapshot = run('read_page');
  const args = { ref: snapshot.elements[0].ref, documentID: snapshot.documentID };
  const { clickTarget } = await run('click', args);
  assert.deepEqual(
    { ...window.__opencodeChrome.validateClick({ ...args, ...clickTarget }) },
    { valid: true },
  );
  document.elementFromPoint = () => document.getElementById('name');
  assert.throws(
    () => window.__opencodeChrome.validateClick({ ...args, ...clickTarget }),
    /covered/,
  );
  await assert.rejects(run('click', args), /covered/);
});

test('prepared click targets expire after movement, a new snapshot, or disable and re-enable', async (t) => {
  const { run, document, window } = page(t);
  const snapshot = run('read_page');
  const args = { ref: snapshot.elements[0].ref, documentID: snapshot.documentID };
  const { clickTarget } = await run('click', args);
  const validate = () => window.__opencodeChrome.validateClick({ ...args, ...clickTarget });
  const button = document.getElementById('button');
  const originalRect = button.getBoundingClientRect;
  button.getBoundingClientRect = () => ({ left: 50, top: 10, right: 150, bottom: 30 });
  assert.throws(validate, /moved/);
  button.getBoundingClientRect = originalRect;
  window.__opencodeChrome.setEnabled(false);
  window.__opencodeChrome.setEnabled(true);
  assert.throws(validate, /changed/);
  run('read_page');
  assert.throws(validate, /changed/);
});

test('click preparation rejects disabled, inert, and off-viewport targets', async (t) => {
  const { run, document } = page(t);
  const snapshot = run('read_page');
  const button = document.getElementById('button');
  const args = { ref: snapshot.elements[0].ref, documentID: snapshot.documentID };
  button.setAttribute('aria-disabled', 'true');
  assert.throws(() => run('click', args), /disabled/);
  button.removeAttribute('aria-disabled');
  button.setAttribute('inert', '');
  assert.throws(() => run('click', args), /disabled/);
  button.removeAttribute('inert');
  button.getBoundingClientRect = () => ({ left: -100, right: -10, top: 10, bottom: 30 });
  await assert.rejects(run('click', args), /outside the viewport/);
  button.getBoundingClientRect = () => ({ left: -20, right: 80, top: 10, bottom: 30 });
  assert.equal((await run('click', args)).clickTarget.x, 40);
});

test('recording targets resolve unique selectors, reject passwords, and expose stable snapshot selectors', (t) => {
  const { run, document } = page(t);
  const snapshot = run('read_page');
  assert.equal(document.querySelector(snapshot.elements[0].selector).id, 'button');
  assert.equal(run('resolve_target', { selector: '#button' }).documentID, snapshot.documentID);
  assert.throws(() => run('resolve_target', { selector: 'input' }), /exactly one/);
  assert.throws(
    () => run('resolve_target', { selector: '#secret', rejectPassword: true }),
    /Password/,
  );
});

test('recording conditions inspect observable state without revealing password values', (t) => {
  const { run } = page(t);
  assert.equal(
    run('inspect_conditions', {
      checks: [
        { selector: '#name', value: 'Old' },
        { selector: '#box', checked: false },
        { url: 'https://example.com/' },
      ],
    }).passed,
    true,
  );
  assert.equal(
    run('inspect_conditions', { checks: [{ selector: '#name', value: 'Wrong' }] }).passed,
    false,
  );
  assert.equal(
    run('inspect_conditions', { checks: [{ selector: '#secret', value: 'private' }] }).passed,
    false,
  );
  assert.equal(
    run('inspect_conditions', { checks: [{ selector: '#missing', visible: false }] }).passed,
    true,
  );
  assert.equal(
    run('inspect_conditions', { checks: [{ selector: 'input', visible: true }] }).passed,
    false,
  );
});

test('recording selectors also resolve anonymous buttons without ephemeral refs', (t) => {
  const { run, document } = page(t);
  const button = document.getElementById('button');
  button.removeAttribute('id');
  const entry = run('read_page').elements.find((element) => element.tag === 'button');
  assert.ok(entry.selector);
  assert.equal(document.querySelectorAll(entry.selector).length, 1);
  assert.equal(document.querySelector(entry.selector), button);
});
