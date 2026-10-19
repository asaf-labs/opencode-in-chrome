import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { diagnose } from './diagnostics.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--json')) {
  console.error('Usage: npm run doctor -- [--json]');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const result = await diagnose({
  resolveDependency: (name) => require.resolve(name),
  expectedVersion: version,
});
if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log('OpenCode in Chrome diagnostics (pairing token is never displayed)');
  for (const check of result.checks)
    console.log(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
  console.log(
    result.ready
      ? '\nReady for browser actions.'
      : '\nNot fully ready. Follow the messages above, then rerun doctor.',
  );
}
process.exitCode = result.ready ? 0 : 1;
