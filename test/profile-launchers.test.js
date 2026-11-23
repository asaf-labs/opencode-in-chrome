import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateLauncher,
  resolveLauncher,
  readLaunchers,
  mapLauncher,
  launchChrome,
} from '../bridge/profile-launchers.js';
import { writePrivateJSON } from '../bridge/private-store.js';
import { parseMappingOptions, saveProfileMapping } from '../scripts/profile-mapping.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'chrome-profile-launch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const directory = path.join(root, 'Chrome installation with spaces');
  await mkdir(directory);
  const executable = path.join(
    directory,
    process.platform === 'win32'
      ? 'chrome.exe'
      : process.platform === 'darwin'
        ? 'Google Chrome'
        : 'chrome',
  );
  await writeFile(executable, 'fixture only; never executed');
  await chmod(executable, 0o700);
  const profilePath = path.join(root, 'User Data', 'Profile 3');
  await mkdir(profilePath, { recursive: true });
  await writeFile(path.join(profilePath, 'Preferences'), 'fixture contents must not be read');
  await writeFile(
    path.join(path.dirname(profilePath), 'Local State'),
    'fixture contents must not be read',
  );
  const url = pathToFileURL(path.join(root, '.local/profile-launchers.json'));
  return { root, executable, profilePath, url };
}

test('local Chrome mappings validate all supported OS paths and reject flags, scripts, guest profiles and relative paths', () => {
  assert.ok(
    validateLauncher(
      {
        executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        profilePath: 'C:\\Users\\Someone\\User Data\\Profile 3',
      },
      'win32',
    ),
  );
  assert.ok(
    validateLauncher(
      {
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        profilePath: '/Users/someone/Library/Application Support/Google/Chrome/Default',
      },
      'darwin',
    ),
  );
  assert.ok(
    validateLauncher(
      {
        executable: '/usr/bin/google-chrome',
        profilePath: '/home/someone/.config/google-chrome/Profile 1',
      },
      'linux',
    ),
  );
  const valid = { executable: '/usr/bin/google-chrome', profilePath: '/home/user/Chrome/Default' };
  for (const mapping of [
    { ...valid, executable: 'google-chrome' },
    { ...valid, executable: '/bin/sh' },
    { ...valid, executable: '/tmp/chrome.cmd' },
    { ...valid, profilePath: 'Profile 1' },
    { ...valid, profilePath: '/home/user/Chrome/Guest Profile' },
    { ...valid, profilePath: '/home/user/Chrome/System Profile' },
    { ...valid, profilePath: '/home/user/Chrome/--incognito' },
    { ...valid, args: ['--remote-debugging-port=9222'] },
    { ...valid, executable: '/usr/bin/google-chrome\n' },
  ])
    assert.throws(() => validateLauncher(mapping, 'linux'));
});

test('mapping setup requires an existing initialized profile, preserves other mappings, and writes private atomic files', async (t) => {
  const f = await fixture(t);
  const mapping = { executable: f.executable, profilePath: f.profilePath };
  const resolved = await resolveLauncher(mapping);
  await mapLauncher(f.url, first, mapping);
  assert.deepEqual((await readLaunchers(f.url)).profiles[first], resolved);
  await assert.rejects(mapLauncher(f.url, second, mapping), /already mapped/);
  const otherPath = path.join(path.dirname(f.profilePath), 'Profile 4');
  await mkdir(otherPath);
  await assert.rejects(mapLauncher(f.url, second, { ...mapping, profilePath: otherPath }));
  await writeFile(path.join(otherPath, 'Preferences'), '{}');
  await mapLauncher(f.url, second, { ...mapping, profilePath: otherPath });
  assert.equal(Object.keys((await readLaunchers(f.url)).profiles).length, 2);
  if (process.platform !== 'win32') assert.equal((await stat(f.url)).mode & 0o777, 0o600);
  await writeFile(new URL('./profile-launchers.lock', f.url), 'another setup');
  await assert.rejects(mapLauncher(f.url, first, mapping), /Another profile mapping/);
  assert.equal(await readFile(new URL('./profile-launchers.lock', f.url), 'utf8'), 'another setup');
});

test('missing mappings are empty and malformed mappings fail closed without resetting the file', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await readLaunchers(f.url), { version: 1, profiles: {} });
  for (const contents of [
    '{',
    '{"version":2,"profiles":{}}',
    '{"version":1,"profiles":{"legacy":{}}}',
  ]) {
    await mkdir(new URL('./', f.url), { recursive: true });
    await writeFile(f.url, contents);
    await assert.rejects(readLaunchers(f.url), /Invalid local Chrome/);
    assert.equal(await readFile(f.url, 'utf8'), contents);
  }
});

test('Chrome launch uses a fixed shell-free argument array and opens no website or debug port', async (t) => {
  const f = await fixture(t);
  let invocation,
    unref = false;
  const spawnProcess = (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.unref = () => {
      unref = true;
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  await launchChrome(f, { spawnProcess });
  assert.equal(invocation.executable, f.executable);
  assert.deepEqual(invocation.args, [
    `--user-data-dir=${path.dirname(f.profilePath)}`,
    '--profile-directory=Profile 3',
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, 'ignore');
  assert.equal(unref, true);
  await assert.rejects(
    launchChrome(f, {
      spawnProcess: () => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('error', new Error('private path must not leak')));
        return child;
      },
    }),
    (error) => !error.message.includes('private path'),
  );
});

test('mapping CLI requires explicit values and known profile identity without changing pairing or routing', async (t) => {
  const f = await fixture(t);
  const config = new URL('./config.json', f.url);
  const state = new URL('./profile-routing.json', f.url);
  const saved = {
    version: 1,
    profiles: [{ id: first, name: 'Approved', enabled: true }],
    selections: { ses_existing: first },
  };
  await writePrivateJSON(state, saved);
  await writePrivateJSON(config, { fixture: 'unchanged private config' });
  for (const args of [
    [],
    ['--profile-id', 'legacy'],
    ['--profile-id', first],
    ['--profile-id', first, '--chrome'],
    ['constructor', 'x'],
    ['--chrome', 'one', '--chrome', 'two'],
  ])
    assert.throws(() => parseMappingOptions(args));
  const options = parseMappingOptions([
    '--profile-id',
    first,
    '--chrome',
    f.executable,
    '--profile-path',
    f.profilePath,
    '--config',
    path.join(f.root, '.local/config.json'),
  ]);
  await assert.rejects(saveProfileMapping({ ...options, profileID: second }), /not registered/);
  const before = await readFile(config, 'utf8');
  await saveProfileMapping(options);
  assert.equal(await readFile(config, 'utf8'), before);
  assert.deepEqual(JSON.parse(await readFile(state, 'utf8')), saved);
  assert.ok((await readLaunchers(f.url)).profiles[first]);
});
