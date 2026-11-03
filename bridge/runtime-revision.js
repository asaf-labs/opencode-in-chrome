import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { digestFiles, extensionRevision } from '../extension/update-revision.js';

export const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));

export async function runtimeRevision(root = runtimeRoot) {
  root = await realpath(root);
  const files = ['package.json', 'package-lock.json'];
  for (const directory of ['bridge', 'scripts', 'extension']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (!/\.(?:js|json|html|css)$/.test(entry.name)) continue;
      if (!entry.isFile()) throw new Error('Runtime updates require regular installation files.');
      files.push(`${directory}/${entry.name}`);
    }
  }
  const read = async (name) => {
    const filename = path.join(root, name);
    if (!(await lstat(filename)).isFile())
      throw new Error('Runtime updates require regular installation files.');
    return readFile(filename, 'utf8');
  };
  return {
    installation: createHash('sha256').update(path.resolve(root)).digest('hex'),
    revision: await digestFiles(files, read),
    extensionRevision: await extensionRevision((name) => read(`extension/${name}`)),
  };
}
