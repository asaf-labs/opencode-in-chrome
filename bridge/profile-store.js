import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const profileIDPattern =
  /^(?:legacy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function validateProfile(profile) {
  if (
    !profile ||
    typeof profile.id !== 'string' ||
    !profileIDPattern.test(profile.id) ||
    profile.id.toLowerCase() === 'legacy' ||
    typeof profile.name !== 'string' ||
    !profile.name.trim() ||
    profile.name.length > 80 ||
    [...profile.name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(
      'Invalid browser profile identity. Reload the extension and set a profile name.',
    );
  }
  return { id: profile.id.toLowerCase(), name: profile.name.trim() };
}

export async function readProfileState(url) {
  if (!url) return { version: 1, profiles: [], selections: {} };
  let contents;
  try {
    contents = await readFile(url, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, profiles: [], selections: {} };
    throw error;
  }
  try {
    const state = JSON.parse(contents);
    if (
      state.version !== 1 ||
      !Array.isArray(state.profiles) ||
      !state.selections ||
      typeof state.selections !== 'object' ||
      Array.isArray(state.selections)
    )
      throw new Error();
    for (const profile of state.profiles) {
      if (profile.id === 'legacy') {
        if (profile.name !== 'Legacy Chrome profile') throw new Error();
      } else if (validateProfile(profile).id !== profile.id) throw new Error();
    }
    const ids = new Set(state.profiles.map((profile) => profile.id));
    if (ids.size !== state.profiles.length) throw new Error();
    for (const [sessionID, profileID] of Object.entries(state.selections)) {
      if (!/^ses[\w-]+$/.test(sessionID) || !ids.has(profileID)) throw new Error();
    }
    return state;
  } catch {
    throw new Error(
      'Invalid saved profile routing. Restore .local/profile-routing.json privately; browser routing was not reset.',
    );
  }
}

export async function writeProfileState(url, state) {
  if (!url) return;
  await mkdir(new URL('./', url), { recursive: true, mode: 0o700 });
  const temporary = new URL(`.profile-routing-${randomUUID()}.tmp`, url);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, url);
  } finally {
    await rm(temporary, { force: true });
  }
}
