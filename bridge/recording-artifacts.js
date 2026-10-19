import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const exportSchema = z
  .object({
    video: z
      .string()
      .max(7 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    manifest: z
      .object({
        schemaVersion: z.literal(1),
        kind: z.literal('edited-verified-walkthrough'),
        goalVerified: z.literal(true),
        edited: z.literal(true),
        task: z.string(),
        goal: z.string(),
        steps: z.array(z.object({ id: z.string() }).passthrough()).min(1),
      })
      .passthrough(),
  })
  .strict();

export async function saveRecordingArtifacts(
  result,
  { root = fileURLToPath(new URL('../.local/recordings/', import.meta.url)) } = {},
) {
  const output = exportSchema.parse(result);
  const video = Buffer.from(output.video, 'base64');
  if (
    video.length > 5 * 1024 * 1024 ||
    !video.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  )
    throw new Error('Recording did not return a valid bounded WebM video.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  try {
    await writeFile(path.join(directory, 'walkthrough.webm'), video, { mode: 0o600, flag: 'wx' });
    await writeFile(
      path.join(directory, 'actions.json'),
      JSON.stringify(output.manifest, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    videoPath: path.join(directory, 'walkthrough.webm'),
    actionsPath: path.join(directory, 'actions.json'),
    edited: true,
    goalVerified: true,
    steps: output.manifest.steps.length,
    note: 'Local edited walkthrough; failed attempts omitted, not undone. Review for sensitive data before sharing.',
  };
}
