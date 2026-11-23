import { parseMappingOptions, saveProfileMapping } from './profile-mapping.js';

try {
  const options = parseMappingOptions(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: npm run profile:map -- --profile-id <UUID> --chrome <absolute-Chrome-executable> --profile-path <absolute-Profile-Path> [--config <local-config-file>]',
    );
    console.log(
      'Copy Profile Path from chrome://version in the intended profile. Saves local launch approval only; it does not open Chrome, change pairing, select an account or enable access.',
    );
  } else {
    await saveProfileMapping(options);
    console.log(`Local Chrome launch mapping saved for profile ${options.profileID}.`);
    console.log(
      'Use connect_profile with this ID to open it and wait for its extension. Profile selection remains explicit.',
    );
  }
} catch (error) {
  console.error(`Profile mapping failed: ${error.message}`);
  process.exitCode = 1;
}
