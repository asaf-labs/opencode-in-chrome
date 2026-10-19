import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import {
  findNpmCLI,
  installationDirectory,
  installFromPackage,
  parseCLIOptions,
  prepareInstallation,
} from '../scripts/cli-installation.js';
import { install, repositoryRoot, runCommand } from '../scripts/installation.js';
import { readConfig } from '../bridge/config.js';
import { sharedStatus } from '../bridge/shared-process.js';

async function fixture(t, cleanup) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'chrome-cli-')));
  t.after(async () => {
    await cleanup?.();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const project = path.join(directory, 'project with spaces');
  const root = path.join(directory, 'permanent installation');
  await mkdir(project);
  return { directory, project, root };
}

test('CLI defaults to the current project and accepts explicit project, port, and browser options', () => {
  const cwd = path.resolve('project with spaces');
  assert.deepEqual(parseCLIOptions(['install'], cwd), { project: cwd, noOpen: false });
  assert.deepEqual(parseCLIOptions(['install', '--no-open', '--port', '8791'], cwd), {
    project: cwd,
    noOpen: true,
    port: 8791,
  });
  assert.equal(parseCLIOptions(['install', '--project', cwd]).project, cwd);
  assert.equal(parseCLIOptions([]).help, true);
  assert.equal(parseCLIOptions(['--help']).help, true);
  assert.equal(parseCLIOptions(['install', '--help']).help, true);
  assert.deepEqual(parseCLIOptions(['install', '--global', '--no-open']), {
    global: true,
    noOpen: true,
  });
  for (const args of [
    ['publish'],
    ['install', '--global', '--project', cwd],
    ['install', '--port', '0'],
    ['install', '--project'],
  ])
    assert.throws(() => parseCLIOptions(args));
});

test('permanent directories follow OS conventions and separate projects', () => {
  const mac = installationDirectory('/project', {
    platform: 'darwin',
    home: '/Users/Test',
    env: {},
  });
  assert.match(
    mac,
    /^\/Users\/Test\/Library\/Application Support\/opencode-in-chrome\/projects\/[a-f0-9]{16}$/,
  );
  assert.equal(
    installationDirectory(null, { platform: 'darwin', home: '/Users/Test', env: {} }),
    '/Users/Test/Library/Application Support/opencode-in-chrome/global',
  );
  const windows = installationDirectory('C:\\Project', {
    platform: 'win32',
    home: 'C:\\Users\\Test',
    env: { LOCALAPPDATA: 'D:\\AppData' },
  });
  assert.match(windows, /^D:\\AppData\\opencode-in-chrome\\projects\\[a-f0-9]{16}$/);
  assert.equal(
    windows,
    installationDirectory('c:\\project', {
      platform: 'win32',
      env: { LOCALAPPDATA: 'D:\\AppData' },
    }),
  );
  const linux = installationDirectory('/project', {
    platform: 'linux',
    home: '/home/test',
    env: { XDG_DATA_HOME: '/data' },
  });
  assert.match(linux, /^\/data\/opencode-in-chrome\/projects\/[a-f0-9]{16}$/);
  assert.notEqual(
    linux,
    installationDirectory('/other-project', {
      platform: 'linux',
      home: '/home/test',
      env: { XDG_DATA_HOME: '/data' },
    }),
  );
  assert.match(
    installationDirectory('/project', {
      platform: 'linux',
      home: '/home/test',
      env: { XDG_DATA_HOME: 'relative' },
    }),
    /^\/home\/test\/\.local\/share\//,
  );
});

test('global package installation uses one user-wide identity and forwards global registration', async (t) => {
  const { root } = await fixture(t);
  const identities = [];
  const registrations = [];
  const result = await installFromPackage(
    { global: true, noOpen: true },
    {
      directory: (identity) => {
        identities.push(identity);
        return root;
      },
      locateNpm: async () => '/npm-cli.js',
      run: (_command, args) => ({
        stdout: args.includes('--version') ? 'opencode v2.0.24' : '✓ chrome connected',
      }),
      installProject: async (options) => {
        registrations.push(options);
        return { global: options.global, root: options.root, project: options.project };
      },
    },
  );
  assert.equal(result.global, true);
  assert.deepEqual(identities, [null]);
  assert.equal(registrations[0].global, true);
  assert.equal(
    JSON.parse(await readFile(path.join(root, '.installer.json'), 'utf8')).project,
    null,
  );
});

test('permanent payload excludes local state and repeat installs preserve pairing', async (t) => {
  const { project, root } = await fixture(t);
  await prepareInstallation(repositoryRoot, root, project);
  for (const file of [
    'bridge/main.js',
    'extension/manifest.json',
    'scripts/cli.js',
    'scripts/pair.js',
    'package-lock.json',
    '.opencode/skills/install-opencode-in-chrome/SKILL.md',
  ])
    assert.ok((await stat(path.join(root, file))).isFile());
  for (const entry of ['.local', '.git', 'node_modules', 'test'])
    await assert.rejects(stat(path.join(root, entry)), { code: 'ENOENT' });
  await mkdir(path.join(root, '.local'));
  await writeFile(path.join(root, '.local/config.json'), 'private pairing settings');
  await prepareInstallation(repositoryRoot, root, project);
  assert.equal(
    await readFile(path.join(root, '.local/config.json'), 'utf8'),
    'private pairing settings',
  );
});

test('existing user directories and modified installations are never overwritten', async (t) => {
  const { project, root } = await fixture(t);
  await mkdir(root);
  await writeFile(path.join(root, 'user.txt'), 'keep me');
  await assert.rejects(prepareInstallation(repositoryRoot, root, project), /already exists/);
  assert.equal(await readFile(path.join(root, 'user.txt'), 'utf8'), 'keep me');
  const otherRoot = `${root}-managed`;
  await prepareInstallation(repositoryRoot, otherRoot, project);
  const filename = path.join(otherRoot, 'bridge/main.js');
  await writeFile(filename, 'user modified bridge');
  await assert.rejects(prepareInstallation(repositoryRoot, otherRoot, project), /different code/);
  assert.equal(await readFile(filename, 'utf8'), 'user modified bridge');
  await assert.rejects(
    prepareInstallation(repositoryRoot, otherRoot, '/other-project'),
    /another project/,
  );
});

test('npm discovery uses the Node installation, not a Bun executable from npm_execpath', async (t) => {
  const { directory } = await fixture(t);
  const npm = path.join(directory, 'lib/node_modules/npm/bin/npm-cli.js');
  await mkdir(path.dirname(npm), { recursive: true });
  await writeFile(npm, 'npm test stub');
  assert.equal(
    await findNpmCLI({
      execPath: path.join(directory, 'bin/node'),
      env: { npm_execpath: '/not/npm/bun' },
    }),
    npm,
  );
  await assert.rejects(
    findNpmCLI({ execPath: path.join(directory, 'missing/bin/node'), env: {} }),
    /npm was not found/,
  );
});

test('CLI rejects unsupported runtimes and OpenCode V1 before creating files', async (t) => {
  const { project, root } = await fixture(t);
  await assert.rejects(
    installFromPackage({ project }, { nodeVersion: '23.4.0', bunVersion: undefined }),
    /Node.js 24/,
  );
  await assert.rejects(
    installFromPackage({ project }, { nodeVersion: '24.0.0', bunVersion: '1.3.7' }),
    /without --bun/,
  );
  await assert.rejects(
    installFromPackage(
      { project },
      { directory: () => root, run: () => ({ stdout: 'opencode v1.0.0' }) },
    ),
    /OpenCode V2/,
  );
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('CLI installs and pairs from a permanent directory with shell-free arguments', async (t) => {
  const { project, root } = await fixture(t);
  const calls = [];
  const registrations = [];
  const result = await installFromPackage(
    { project, port: 8791, noOpen: true },
    {
      directory: () => root,
      locateNpm: async () => '/npm-cli.js',
      run: (...args) => {
        calls.push(args);
        return { stdout: args[1].includes('--version') ? 'opencode v2.0.24' : '' };
      },
      installProject: async (options) => {
        registrations.push(options);
        return { root: options.root, project: options.project, port: options.port };
      },
    },
  );
  assert.equal(result.root, root);
  assert.equal(registrations[0].root, root);
  assert.equal(registrations[0].npmCLI, '/npm-cli.js');
  assert.equal(registrations[0].port, 8791);
  assert.deepEqual(calls.at(-1), [
    process.execPath,
    [path.join(root, 'scripts/pair.js'), '--no-open'],
    root,
  ]);
  assert.equal(
    calls.some(([, args]) => args.some((arg) => arg.includes(repositoryRoot))),
    false,
  );
});

test('CLI refuses to silently replace an already configured checkout on first install', async (t) => {
  const { project, root } = await fixture(t);
  await assert.rejects(
    installFromPackage(
      { project },
      {
        directory: () => root,
        run: (_command, args) => ({
          stdout: args.includes('--version') ? 'opencode v2.0.24' : '✓ chrome connected',
        }),
      },
    ),
    /already configured/,
  );
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('a full permanent install remains runnable after the package-runner cache is removed', async (t) => {
  const { directory, project, root } = await fixture(t);
  const cache = path.join(directory, 'package runner cache');
  await prepareInstallation(repositoryRoot, cache, project);
  await rename(path.join(cache, 'package-lock.json'), path.join(cache, 'npm-shrinkwrap.json'));
  let registered = false;
  const run = (command, args, cwd, options) => {
    if (command === 'opencode') {
      if (args.includes('--version')) return { stdout: 'opencode v2.0.24' };
      if (args.includes('add')) {
        assert.equal(args.at(-1), path.join(root, 'bridge/main.js'));
        registered = true;
      }
      return { stdout: registered ? '✓ chrome connected\n' : '' };
    }
    const commandArgs = args.includes('ci')
      ? [...args, '--offline', '--no-audit', '--no-fund']
      : args;
    return runCommand(command, commandArgs, cwd, options);
  };
  await installFromPackage(
    { project, noOpen: true },
    {
      source: cache,
      directory: () => root,
      run,
      installProject: (options) => install({ ...options, checkPort: async () => true }),
    },
  );
  await rm(cache, { recursive: true, force: true });
  const require = createRequire(path.join(root, 'package.json'));
  for (const name of ['@modelcontextprotocol/sdk/server/mcp.js', 'ws', 'zod'])
    assert.ok(require.resolve(name).startsWith(root + path.sep));
  const help = spawnSync(process.execPath, [path.join(root, 'scripts/cli.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /opencode-in-chrome install/);
  assert.ok((await stat(path.join(root, '.local/pairing.html'))).isFile());
});

test('a full global install runs its shared daemon outside the package cache', async (t) => {
  let config;
  let client;
  const { directory, root } = await fixture(t, async () => {
    await client?.close();
    if (config)
      await fetch(`http://127.0.0.1:${config.port}/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
  });
  const cache = path.join(directory, 'package runner cache');
  await prepareInstallation(repositoryRoot, cache, null);
  await rename(path.join(cache, 'package-lock.json'), path.join(cache, 'npm-shrinkwrap.json'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const run = (command, args, cwd, options) => {
    if (command === 'opencode') {
      if (args.includes('add')) {
        assert.ok(args.includes('--global'));
        assert.equal(args.at(-1), path.join(root, 'bridge/shared-main.js'));
      }
      return { stdout: args.includes('--version') ? 'opencode v2.0.24' : '✓ chrome connected\n' };
    }
    return runCommand(
      command,
      args.includes('ci') ? [...args, '--offline', '--no-audit', '--no-fund'] : args,
      cwd,
      options,
    );
  };
  const result = await installFromPackage(
    { global: true, noOpen: true, port },
    { source: cache, directory: () => root, run },
  );
  assert.equal(result.global, true);
  config = await readConfig(pathToFileURL(path.join(root, '.local/config.json')));
  const started = await sharedStatus(config);
  await rm(cache, { recursive: true, force: true });
  client = new Client({ name: 'another-project', version: 'test' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'bridge/shared-main.js')],
      stderr: 'pipe',
    }),
  );
  assert.equal((await client.listTools()).tools.length, 27);
  assert.equal((await sharedStatus(config)).bridgeID, started.bridgeID);
  await client.close();
});
