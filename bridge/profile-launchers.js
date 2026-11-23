import { readFile, realpath, stat, access, mkdir, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { profileIDPattern } from './profile-store.js';
import { writePrivateJSON } from './private-store.js';

export function validateLauncher(mapping, platform = process.platform) {
  if (!['win32', 'darwin', 'linux'].includes(platform))
    throw new Error('Chrome profile launching supports Windows, macOS and Linux.');
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (
    !mapping ||
    Object.keys(mapping).some((key) => !['executable', 'profilePath'].includes(key)) ||
    ![mapping.executable, mapping.profilePath].every(
      (value) =>
        typeof value === 'string' &&
        value.length <= 2048 &&
        paths.isAbsolute(value) &&
        ![...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    throw new Error('Chrome launch mapping requires absolute executable and profile paths.');
  const executables =
    platform === 'win32'
      ? ['chrome.exe']
      : platform === 'darwin'
        ? ['Google Chrome']
        : ['google-chrome', 'google-chrome-stable', 'chrome'];
  const executable = paths.basename(mapping.executable);
  if (!executables.includes(platform === 'win32' ? executable.toLowerCase() : executable))
    throw new Error('Use an explicit Google Chrome executable, not a shell or launcher command.');
  if (!/^(?:Default|Profile \d{1,6})$/.test(paths.basename(mapping.profilePath)))
    throw new Error(
      'Choose an existing regular Chrome profile folder: Default or Profile N, not Guest/System Profile.',
    );
  return { executable: mapping.executable, profilePath: mapping.profilePath };
}

export async function resolveLauncher(mapping) {
  validateLauncher(mapping);
  const resolved = {
    executable: await realpath(mapping.executable),
    profilePath: await realpath(mapping.profilePath),
  };
  validateLauncher(resolved);
  if (
    !(await stat(resolved.executable)).isFile() ||
    !(await stat(resolved.profilePath)).isDirectory() ||
    !(await stat(path.join(resolved.profilePath, 'Preferences'))).isFile() ||
    !(await stat(path.join(path.dirname(resolved.profilePath), 'Local State'))).isFile()
  )
    throw new Error('Chrome executable and an existing initialized profile folder are required.');
  if (process.platform !== 'win32') await access(resolved.executable, constants.X_OK);
  return resolved;
}

export async function readLaunchers(url) {
  if (!url) return { version: 1, profiles: {} };
  let text;
  try {
    text = await readFile(url, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, profiles: {} };
    throw error;
  }
  try {
    const config = JSON.parse(text);
    if (
      config.version !== 1 ||
      !config.profiles ||
      typeof config.profiles !== 'object' ||
      Array.isArray(config.profiles) ||
      Object.keys(config).some((key) => !['version', 'profiles'].includes(key))
    )
      throw new Error();
    for (const [id, mapping] of Object.entries(config.profiles)) {
      if (!profileIDPattern.test(id) || id === 'legacy' || id !== id.toLowerCase())
        throw new Error();
      validateLauncher(mapping);
    }
    return config;
  } catch {
    throw new Error(
      'Invalid local Chrome launch mappings. Fix .local/profile-launchers.json privately; no browser was launched.',
    );
  }
}

export async function mapLauncher(url, profileID, mapping) {
  if (
    !profileIDPattern.test(profileID) ||
    profileID === 'legacy' ||
    profileID !== profileID.toLowerCase()
  )
    throw new Error('Use a named profile ID from list_profiles.');
  const resolved = await resolveLauncher(mapping);
  await mkdir(new URL('./', url), { recursive: true, mode: 0o700 });
  const lockURL = new URL('./profile-launchers.lock', url);
  let lock;
  try {
    lock = await open(lockURL, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Another profile mapping is being saved. If no mapping command is running, remove only .local/profile-launchers.lock and retry.',
        { cause: error },
      );
    throw error;
  }
  try {
    const config = await readLaunchers(url);
    for (const [id, other] of Object.entries(config.profiles)) {
      if (id !== profileID && (await realpath(other.profilePath)) === resolved.profilePath)
        throw new Error(
          'This Chrome profile folder is already mapped to another extension profile ID.',
        );
    }
    config.profiles[profileID] = resolved;
    await writePrivateJSON(url, config);
  } finally {
    await lock.close();
    await rm(lockURL, { force: true });
  }
}

export async function launchChrome(mapping, { spawnProcess = spawn } = {}) {
  const child = spawnProcess(
    mapping.executable,
    [
      `--user-data-dir=${path.dirname(mapping.profilePath)}`,
      `--profile-directory=${path.basename(mapping.profilePath)}`,
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { shell: false, detached: true, stdio: 'ignore' },
  );
  await new Promise((resolve, reject) => {
    child.once('error', () =>
      reject(new Error('Chrome could not be started from the approved local mapping.')),
    );
    child.once('spawn', resolve);
  });
  child.unref();
}
