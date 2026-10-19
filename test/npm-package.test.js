import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findNpmCLI } from '../scripts/cli-installation.js';
import { repositoryRoot } from '../scripts/installation.js';

test('actual npm package includes the CLI, runtime, extension, skill, and publishable lockfile only', async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), 'chrome-npm-package-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const npmCLI = await findNpmCLI();
  const packed = spawnSync(
    process.execPath,
    [npmCLI, 'pack', '--json', '--pack-destination', output],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [report] = JSON.parse(packed.stdout);
  assert.ok((await stat(path.join(output, report.filename))).size > 0);
  const files = report.files.map((file) => file.path);
  for (const filename of [
    'scripts/cli.js',
    'scripts/cli-installation.js',
    'scripts/installation.js',
    'scripts/pairing.js',
    'bridge/main.js',
    'bridge/shared-main.js',
    'bridge/shared-daemon.js',
    'bridge/shared-client.js',
    'bridge/shared-server.js',
    'bridge/shared-process.js',
    'bridge/shared-config.js',
    'bridge/recording-tools.js',
    'bridge/inspection-tools.js',
    'bridge/inspection-artifacts.js',
    'extension/debugger-sessions.js',
    'extension/inspections.js',
    'extension/inspection-privacy.js',
    'extension/inspection-profiles.js',
    'extension/performance-capture.js',
    'bridge/recording-artifacts.js',
    'extension/recording-capture.js',
    'extension/recordings.js',
    'extension/recording-offscreen.html',
    'extension/recording-offscreen.js',
    'extension/video-encoder.js',
    'extension/webm.js',
    'scripts/stop-shared.js',
    'extension/manifest.json',
    '.opencode/skills/install-opencode-in-chrome/SKILL.md',
    'npm-shrinkwrap.json',
    'LICENSE',
  ])
    assert.ok(files.includes(filename), filename);
  for (const filename of files)
    assert.equal(
      /(^|\/)(\.local|\.git|node_modules|test|dist|\.env[^/]*|\.npmrc)(\/|$)/.test(filename),
      false,
      filename,
    );
  assert.equal(files.includes('package-lock.json'), false);
  const pkg = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(pkg.name, '@asaf-labs/opencode-in-chrome');
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.bin['opencode-in-chrome'], 'scripts/cli.js');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  const executable = await readFile(
    path.join(repositoryRoot, pkg.bin['opencode-in-chrome']),
    'utf8',
  );
  assert.ok(executable.startsWith('#!/usr/bin/env node\n'));
  const help = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, pkg.bin['opencode-in-chrome']), '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /opencode-in-chrome install/);
});
