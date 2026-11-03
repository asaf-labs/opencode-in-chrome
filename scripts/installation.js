import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { ensureConfig } from '../bridge/config.js';
import { ensureSharedDaemon } from '../bridge/shared-process.js';
import { portAvailable, inspectBridge } from './diagnostics.js';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const skillPath = '.opencode/skills/install-opencode-in-chrome/SKILL.md';

export function parseInstallOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help') options.help = true;
    else if (arg === '--global') options.global = true;
    else if (arg === '--project') {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error('--project requires a target directory.');
      options.project = path.resolve(value);
    } else if (arg === '--port') {
      const value = args[++index];
      if (!/^\d+$/.test(value || '') || Number(value) < 1024 || Number(value) > 65535)
        throw new Error('--port requires an integer between 1024 and 65535.');
      options.port = Number(value);
    } else throw new Error(`Unknown installer option: ${arg}`);
  }
  if (options.global && options.project) throw new Error('Choose --global or --project, not both.');
  if (!options.help && !options.global && !options.project)
    throw new Error('Specify --project <target-project-directory>.');
  return options;
}

export function runCommand(executable, args, cwd, { capture = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
  });
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error?.code === 'ENOENT')
    throw new Error(
      `${path.basename(executable)} was not found. Install OpenCode V2 and make sure opencode is on PATH.`,
    );
  if (result.error || result.status !== 0)
    throw new Error(`${path.basename(executable)} failed. Review its output above and retry.`);
  return result;
}

export async function install({
  project = process.cwd(),
  global = false,
  port,
  root = repositoryRoot,
  run = runCommand,
  checkPort = portAvailable,
  checkBridge = inspectBridge,
  npmCLI = process.env.npm_execpath,
  wait = setTimeout,
  startShared = ensureSharedDaemon,
}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required.');
  if (!(await stat(project)).isDirectory())
    throw new Error('The target project must be an existing directory.');
  const skill = await readFile(path.join(root, skillPath), 'utf8');
  const destination = global ? undefined : path.join(project, skillPath);
  const existing = global
    ? null
    : await readFile(destination, 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
  if (existing !== null && existing !== skill)
    throw new Error(
      'An installation skill already exists in the target project with different contents. Preserve or update it manually before installing.',
    );

  // Use OpenCode's CLI, not a JSON rewrite, to preserve JSONC and unrelated settings.
  run('opencode', ['--version'], project);
  const require = createRequire(path.join(root, 'package.json'));
  let dependenciesInstalled = true;
  try {
    for (const name of ['@modelcontextprotocol/sdk/server/mcp.js', 'ws', 'zod']) {
      if (!require.resolve(name).startsWith(path.join(root, 'node_modules') + path.sep)) {
        dependenciesInstalled = false;
        break;
      }
    }
  } catch {
    dependenciesInstalled = false;
  }
  if (!dependenciesInstalled) {
    if (!npmCLI)
      throw new Error('Run this installer through npm run install:opencode, or run npm ci first.');
    run(process.execPath, [npmCLI, 'ci', '--omit=dev', '--ignore-scripts'], root);
  }
  const config = await ensureConfig({ port }, pathToFileURL(path.join(root, '.local/config.json')));
  if (!(await checkPort(config.port))) {
    const checks = await checkBridge(config);
    if (!checks.some((check) => check.id === 'bridge' && check.status === 'pass')) {
      throw new Error(
        `Port ${config.port} is occupied by a different service or older bridge. Disconnect chrome in the previous project's /mcps interface, then retry. Alternatively add --port <free-port>.`,
      );
    }
  }
  if (global)
    await startShared(config, {
      configURL: pathToFileURL(path.join(root, '.local/config.json')),
      daemonURL: pathToFileURL(path.join(root, 'bridge/shared-daemon.js')),
    });
  run(
    'opencode',
    [
      'mcp',
      'add',
      'chrome',
      ...(global ? ['--global'] : []),
      '--',
      process.execPath,
      path.join(root, global ? 'bridge/shared-main.js' : 'bridge/main.js'),
    ],
    project,
  );
  if (destination) {
    await mkdir(path.dirname(destination), { recursive: true });
    if (existing === null) await writeFile(destination, skill, { flag: 'wx' });
  }
  let connected = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await wait(500);
    const listing = run('opencode', ['mcp', 'list'], project, { capture: true });
    const text = stripVTControlCharacters(listing?.stdout || '');
    if (/^\s*(?:[✓✔●]\s*)?chrome\s+connected\b/m.test(text)) {
      connected = true;
      break;
    }
  }
  if (!connected) {
    throw new Error(
      global
        ? 'Global Chrome MCP was registered but is not confirmed connected here. Project-local chrome entries override global configuration; remove only an old local entry and reconnect chrome in /mcps. Check npm run doctor for port conflicts.'
        : "Chrome MCP was registered but is not confirmed connected in the target project. Disconnect chrome in the previous project if it holds the port, then reconnect it in this project's /mcps and run opencode mcp list. The installation skill was copied successfully.",
    );
  }
  return {
    project,
    root,
    port: config.port,
    skillPath: destination,
    ...(global ? { global: true } : {}),
  };
}
