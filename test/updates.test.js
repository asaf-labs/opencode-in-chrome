import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, cp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionFiles, extensionRevision } from '../extension/update-revision.js';
import { ExtensionUpdates, restoreUpdateCheckpoint } from '../extension/updates.js';
import { runtimeRevision, runtimeRoot } from '../bridge/runtime-revision.js';
import { RefreshingAdapter } from '../bridge/refreshing-adapter.js';

const old = 'a'.repeat(64),
  next = 'b'.repeat(64);

test('revision manifests cover all extension files and fingerprint runtime bytes, not local credentials', async (t) => {
  assert.deepEqual(
    [...extensionFiles].sort(),
    (await readdir(new URL('../extension/', import.meta.url))).sort(),
  );
  const revision = await runtimeRevision();
  assert.equal(
    revision.extensionRevision,
    await extensionRevision((name) =>
      readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8'),
    ),
  );
  const root = await mkdtemp(path.join(tmpdir(), 'chrome-update-revision-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const directory of ['bridge', 'extension', 'scripts'])
    await cp(path.join(runtimeRoot, directory), path.join(root, directory), { recursive: true });
  for (const filename of ['package.json', 'package-lock.json'])
    await cp(path.join(runtimeRoot, filename), path.join(root, filename));
  const copied = await runtimeRevision(root);
  assert.equal(copied.revision, revision.revision);
  assert.notEqual(copied.installation, revision.installation);
  const alias = path.join(root, 'installation-alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await runtimeRevision(alias), copied);
  await mkdir(path.join(root, '.local'));
  await writeFile(path.join(root, '.local/config.json'), 'private fixture, never hashed');
  assert.deepEqual(await runtimeRevision(root), copied);
  await writeFile(path.join(root, 'extension/content.js'), 'changed content');
  const changed = await runtimeRevision(root);
  assert.notEqual(changed.revision, copied.revision);
  assert.notEqual(changed.extensionRevision, copied.extensionRevision);
});

function extensionFixture() {
  const local = {},
    session = {};
  let disk = old,
    busy = false,
    cleared = 0;
  const targets = [
    { type: 'page', tabId: 7, id: 'native-target-owned' },
    { type: 'page', tabId: 1, id: 'native-target-personal' },
  ];
  const chrome = {
    storage: {
      local: {
        set: async (data) => Object.assign(local, structuredClone(data)),
        remove: async (key) => {
          delete local[key];
        },
      },
      session: { set: async (data) => Object.assign(session, structuredClone(data)) },
    },
    debugger: { getTargets: async () => targets },
  };
  const browser = {
    bindings: {
      ses_owned: { generation: 'g', tabs: [{ id: 7, keep: true, indicatorHidden: true }] },
    },
    debuggers: {
      clear: async () => {
        cleared++;
      },
    },
  };
  const updates = new ExtensionUpdates(chrome, browser, {
    busy: () => busy,
    readRevision: async () => disk,
  });
  return {
    updates,
    local,
    session,
    targets,
    chrome,
    browser,
    setDisk: (value) => {
      disk = value;
    },
    setBusy: (value) => {
      busy = value;
    },
    cleared: () => cleared,
  };
}

test('extension activation checks idle state and matching code, preserving owned tabs with native identities', async () => {
  const f = extensionFixture();
  await f.updates.loaded;
  f.setBusy(true);
  await assert.rejects(f.updates.prepare('id', next), /deferred/);
  f.setBusy(false);
  await assert.rejects(f.updates.prepare('id', next), /differs/);
  assert.equal(f.updates.locked, false);
  f.setDisk(next);
  assert.deepEqual(await f.updates.prepare('id', next), { prepared: true });
  assert.equal(f.updates.locked, true);
  await assert.rejects(f.updates.commit('wrong'), /no longer prepared/);
  assert.equal(await f.updates.commit('id'), true);
  f.updates.disconnected();
  assert.equal(f.updates.canReload('id'), true);
  assert.equal(f.cleared(), 1);
  assert.deepEqual(f.session.ownedSessionsV2, f.browser.bindings);
  assert.deepEqual(f.local.updateCheckpoint.targets, { 7: 'native-target-owned' });
  const restored = await restoreUpdateCheckpoint(f.chrome, f.local.updateCheckpoint);
  assert.deepEqual(restored, f.browser.bindings);
  assert.equal(f.local.updateCheckpoint, undefined);
  f.updates.release('id');
  assert.equal(f.updates.locked, false);
  assert.throws(() => f.updates.canReload('id'), /no longer prepared/);
});

test('late update commits cannot reload after their barrier was released', async () => {
  const f = extensionFixture();
  await f.updates.loaded;
  f.setDisk(next);
  await f.updates.prepare('id', next);
  let resume, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  f.updates.readRevision = () => {
    entered();
    return new Promise((resolve) => {
      resume = resolve;
    });
  };
  const pending = f.updates.commit('id');
  await reached;
  f.updates.release('id');
  resume(next);
  await assert.rejects(pending, /no longer prepared/);
  assert.equal(f.cleared(), 0);
  assert.equal(f.local.updateCheckpoint, undefined);
});

test('checkpoints are single-use, expire, and never adopt recycled tab IDs after browser restart', async () => {
  const f = extensionFixture();
  await f.updates.loaded;
  f.setDisk(next);
  await f.updates.prepare('id', next);
  await f.updates.commit('id');
  const checkpoint = structuredClone(f.local.updateCheckpoint);
  f.targets[0].id = 'new-browser-target-with-same-tab-id';
  assert.deepEqual(await restoreUpdateCheckpoint(f.chrome, checkpoint), {});
  assert.equal(
    await restoreUpdateCheckpoint(f.chrome, { ...checkpoint, expiresAt: Date.now() - 1 }),
    null,
  );
  assert.equal(
    await restoreUpdateCheckpoint(f.chrome, { ...checkpoint, expiresAt: Date.now() + 120000 }),
    null,
  );
});

test('extension update fails closed on storage, identity, source changes and newly busy work', async () => {
  const f = extensionFixture();
  await f.updates.loaded;
  f.setDisk(next);
  f.chrome.storage.session.set = async () => {
    throw new Error('storage failed');
  };
  await assert.rejects(f.updates.prepare('id', next), /storage failed/);
  assert.equal(f.updates.locked, false);
  const second = extensionFixture();
  await second.updates.loaded;
  second.setDisk(next);
  await second.updates.prepare('id', next);
  second.setBusy(true);
  await assert.rejects(second.updates.commit('id'), /no longer prepared/);
  second.setBusy(false);
  second.setDisk(old);
  await assert.rejects(second.updates.commit('id'), /changed/);
  second.setDisk(next);
  second.targets.length = 0;
  await assert.rejects(second.updates.commit('id'), /tab identity/);
  assert.equal(second.local.updateCheckpoint, undefined);
});

test('unchanged extensions do not request a reload or persist an ownership checkpoint', async () => {
  const f = extensionFixture();
  await f.updates.prepare('id', old);
  assert.equal(await f.updates.commit('id'), false);
  assert.equal(f.local.updateCheckpoint, undefined);
});

test('adapter refresh loads a fresh generation on next use, defers in-flight work and announces catalog changes', async () => {
  let revision = old,
    started = 0,
    closed = 0,
    changes = 0;
  const adapter = new RefreshingAdapter({
    revision: async () => ({ revision }),
    launch: async () => ({
      generation: ++started,
      close: async () => {
        closed++;
      },
    }),
    changed: () => {
      changes++;
    },
  });
  assert.equal(await adapter.use((client) => client.generation), 1);
  let release;
  const pending = adapter.use(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await adapter.queue;
  await Promise.resolve();
  revision = next;
  assert.equal(await adapter.use((client) => client.generation), 1);
  release('completed once');
  assert.equal(await pending, 'completed once');
  assert.equal(await adapter.use((client) => client.generation), 2);
  assert.equal(changes, 1);
  assert.equal(closed, 1);
  await adapter.close();
  assert.equal(closed, 2);
});

test('failed or changing adapter updates never replay a call and keep the old generation alive', async () => {
  let revision = old,
    fail = false,
    work = 0,
    closed = 0;
  const adapter = new RefreshingAdapter({
    revision: async () => ({ revision }),
    launch: async () => {
      if (fail) throw new Error('new code failed');
      return {
        close: async () => {
          closed++;
        },
      };
    },
  });
  await adapter.use(() => {
    work++;
  });
  revision = next;
  fail = true;
  await assert.rejects(
    adapter.use(() => {
      work++;
    }),
    /new code failed/,
  );
  assert.equal(work, 1);
  assert.equal(closed, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    adapter.use(() => {
      work++;
    }, abort.signal),
    /cancelled/,
  );
  assert.equal(work, 1);
  await adapter.close();
});

test('deferred daemon activation keeps the previous adapter/catalog usable to finish captures', async () => {
  let revision = old,
    deferred = false,
    launched = 0,
    changes = 0;
  const closed = [];
  const adapter = new RefreshingAdapter({
    revision: async () => ({ revision }),
    launch: async () => {
      const generation = ++launched;
      const state = deferred;
      return {
        generation,
        getServerCapabilities: () => ({ experimental: { chromeUpdate: { deferred: state } } }),
        close: async () => closed.push(generation),
      };
    },
    changed: () => {
      changes++;
    },
  });
  assert.equal(await adapter.use((client) => client.generation), 1);
  revision = next;
  deferred = true;
  assert.equal(await adapter.use((client) => client.generation), 1);
  assert.deepEqual(closed, [2]);
  assert.equal(changes, 0);
  deferred = false;
  assert.equal(await adapter.use((client) => client.generation), 3);
  assert.equal(changes, 1);
  await adapter.close();
});
