import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configURL } from '../bridge/config.js';
import { readProfileState, profileIDPattern } from '../bridge/profile-store.js';
import { mapLauncher } from '../bridge/profile-launchers.js';

export function parseMappingOptions(args) {
  const options = {};
  const keys = {
    '--profile-id': 'profileID',
    '--chrome': 'executable',
    '--profile-path': 'profilePath',
    '--config': 'config',
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--help') {
      options.help = true;
      continue;
    }
    const key = Object.hasOwn(keys, name) ? keys[name] : undefined;
    if (!key || options[key] !== undefined)
      throw new Error(
        'Use --profile-id, --chrome and --profile-path once each; --config is optional.',
      );
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    options[key] = value;
  }
  if (options.help) return options;
  if (!profileIDPattern.test(options.profileID || '') || options.profileID === 'legacy')
    throw new Error('Use --profile-id with a named profile ID from list_profiles.');
  options.profileID = options.profileID.toLowerCase();
  if (!options.executable || !options.profilePath)
    throw new Error(
      'Explicit --chrome and --profile-path values are required. Nothing is guessed or launched.',
    );
  return options;
}

export async function saveProfileMapping(options) {
  const local = options.config ? pathToFileURL(path.resolve(options.config)) : configURL;
  const state = await readProfileState(new URL('./profile-routing.json', local));
  if (
    !state.profiles.some((profile) => profile.id === options.profileID && profile.id !== 'legacy')
  )
    throw new Error(
      'This profile has not registered with this bridge. Pair it first, then use its ID from list_profiles.',
    );
  await mapLauncher(new URL('./profile-launchers.json', local), options.profileID, {
    executable: options.executable,
    profilePath: options.profilePath,
  });
}
