import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const artifactSchema = z
  .object({
    kind: z.enum(['cpu-profile', 'performance-timeline']),
    data: z.record(z.string(), z.unknown()),
    summary: z.record(z.string(), z.unknown()),
  })
  .strict();

export async function saveInspectionArtifact(
  result,
  { root = fileURLToPath(new URL('../.local/inspections/', import.meta.url)) } = {},
) {
  const output = artifactSchema.parse(result);
  const data = JSON.stringify(output.data);
  if (Buffer.byteLength(data) > 5 * 1024 * 1024)
    throw new Error('Inspection artifact exceeds 5 MiB.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const artifactPath = path.join(
    directory,
    output.kind === 'cpu-profile' ? 'profile.cpuprofile' : 'timeline.json',
  );
  try {
    await writeFile(artifactPath, data + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    artifactPath,
    kind: output.kind,
    summary: output.summary,
    note: 'Private local artifact. Redaction is best effort; review before sharing.',
  };
}
