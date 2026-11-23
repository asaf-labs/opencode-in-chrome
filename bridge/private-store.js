import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function writePrivateJSON(url, value) {
  if (!url) return;
  await mkdir(new URL('./', url), { recursive: true, mode: 0o700 });
  const temporary = new URL(`.private-${randomUUID()}.tmp`, url);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, url);
  } finally {
    await rm(temporary, { force: true });
  }
}
