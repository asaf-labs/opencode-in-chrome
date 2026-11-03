import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { configURL as defaultConfigURL } from './config.js';
import { portAvailable } from '../scripts/diagnostics.js';
import { runtimeRevision } from './runtime-revision.js';

export async function sharedStatus(config) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
  } catch {
    return null;
  }
  if (response.status !== 200)
    throw new Error(
      `Port ${config.port} is occupied by another bridge or service. Disconnect it or choose a different port; nothing was stopped.`,
    );
  const status = await response.json();
  if (status.mode !== 'shared' || typeof status.bridgeID !== 'string')
    throw new Error(
      `Port ${config.port} is not a shared Chrome bridge. Disconnect the project-local bridge before enabling global mode.`,
    );
  return status;
}

export async function ensureSharedDaemon(
  config,
  {
    configURL = defaultConfigURL,
    daemonURL = new URL('./shared-daemon.js', import.meta.url),
    autoActivate = true,
    readRevision = runtimeRevision,
  } = {},
) {
  const running = await sharedStatus(config);
  if (running) {
    if (!autoActivate || running.updateProtocol !== 1) return running;
    const target = await readRevision();
    if (target.installation !== running.runtime?.installation) return running;
    const stale =
      running.runtime.revision !== target.revision ||
      running.profiles?.some(
        (profile) => profile.connected && profile.extensionRevision !== target.extensionRevision,
      );
    if (!stale && !running.updating) return running;
    let activation;
    if (!running.updating) {
      const response = await fetch(`http://127.0.0.1:${config.port}/activate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bridgeID: running.bridgeID,
          installation: target.installation,
          revision: target.revision,
        }),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      activation = await response.json();
      if (!response.ok) throw new Error(activation.error || 'Automatic browser activation failed.');
      if (!activation.activated && !activation.updating)
        return { ...running, updateDeferred: activation.reason || 'Browser work is active.' };
    }
    for (let attempt = 0; attempt < 150; attempt++) {
      await setTimeout(100);
      const current = await sharedStatus(config);
      if (!current) {
        await ensureSharedDaemon(config, { configURL, daemonURL, autoActivate: false });
        continue;
      }
      if (
        current.bridgeID !== running.bridgeID &&
        current.runtime?.revision === target.revision &&
        (
          activation?.profiles ||
          running.profiles
            ?.filter((profile) => profile.connected)
            .map((profile) => profile.profileID) ||
          []
        ).every((id) =>
          current.profiles?.some(
            (profile) =>
              profile.profileID === id &&
              profile.connected &&
              profile.extensionRevision === target.extensionRevision,
          ),
        )
      )
        return current;
      if (current.bridgeID === running.bridgeID && !current.updating && !activation?.activated)
        return current;
    }
    throw new Error(
      'Browser update is waiting for profile reconnection. No action was dispatched; check the extension popup.',
    );
  }
  if (!(await portAvailable(config.port))) {
    const raced = await sharedStatus(config);
    if (raced) return raced;
    throw new Error(
      `Port ${config.port} is occupied but the shared bridge is unreachable. No process was stopped.`,
    );
  }
  const child = spawn(
    process.execPath,
    [fileURLToPath(daemonURL), '--config', fileURLToPath(configURL)],
    {
      cwd: fileURLToPath(new URL('../', daemonURL)),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    await setTimeout(100);
    const ready = await sharedStatus(config);
    if (ready) return ready;
  }
  throw new Error(
    'Shared Chrome bridge did not start. Run npm run doctor from its installation directory.',
  );
}
