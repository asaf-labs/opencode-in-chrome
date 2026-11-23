import { setTimeout } from 'node:timers/promises';
import { readLaunchers, resolveLauncher, launchChrome } from './profile-launchers.js';

export class ProfileConnector {
  attempts = new Map();
  launchedAt = new Map();

  constructor(
    hub,
    {
      mappingURL,
      load = readLaunchers,
      resolve = resolveLauncher,
      launch = launchChrome,
      delay = setTimeout,
      now = () => performance.now(),
      timeout = 20000,
      grace = 3000,
    } = {},
  ) {
    this.hub = hub;
    this.mappingURL = mappingURL;
    this.load = load;
    this.resolve = resolve;
    this.launch = launch;
    this.delay = delay;
    this.now = now;
    this.timeout = timeout;
    this.grace = grace;
  }

  check(profileID) {
    const profile = this.hub.profiles.get(profileID);
    if (!profile || profileID === 'legacy')
      throw new Error('Use a named registered profile ID from list_profiles.');
    if (profile.hub.socket?.readyState === 1) {
      if (!profile.hub.browserEnabled)
        throw new Error(
          'This profile has browser access disabled. Enable it manually in its extension popup; connect_profile never enables it.',
        );
      return { profile, connected: true };
    }
    if (profile.enabled !== true)
      throw new Error(
        'This profile is disabled or its enabled state is unknown. Open it manually and enable the extension once before using connect_profile.',
      );
    return { profile, connected: false };
  }

  async connect(profileID, signal) {
    if (signal?.aborted) throw new Error('Profile connection cancelled.');
    await this.hub.flush();
    if (signal?.aborted) throw new Error('Profile connection cancelled.');
    if (this.check(profileID).connected) return { connected: true, launched: false };
    let attempt = this.attempts.get(profileID);
    if (!attempt) {
      attempt = { controller: new AbortController(), waiters: new Set() };
      this.attempts.set(profileID, attempt);
      attempt.promise = this.run(profileID, attempt.controller.signal).finally(() => {
        if (this.attempts.get(profileID) === attempt) this.attempts.delete(profileID);
      });
    }
    const waiter = {};
    attempt.waiters.add(waiter);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () =>
        reject(
          new Error(
            'Profile connection cancelled. Chrome may already have opened; it was not closed or retried.',
          ),
        );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      return await Promise.race([attempt.promise, aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      attempt.waiters.delete(waiter);
      if (!attempt.waiters.size) attempt.controller.abort();
    }
  }

  async run(profileID, signal) {
    const started = this.now();
    await this.delay(this.grace, undefined, { signal });
    if (signal.aborted) throw new Error('Profile connection cancelled.');
    if (this.check(profileID).connected) return { connected: true, launched: false };
    let config;
    try {
      config = await this.load(this.mappingURL);
    } catch {
      throw new Error(
        'Cannot read valid local Chrome launch mappings. Check .local/profile-launchers.json privately; no browser was launched.',
      );
    }
    const mapping = config.profiles[profileID];
    if (!mapping)
      throw new Error(
        'No local Chrome launch mapping for this profile. Run npm run profile:map with its profile ID, Chrome executable and profile folder first.',
      );
    let resolved;
    try {
      resolved = await this.resolve(mapping);
    } catch {
      throw new Error(
        'The local Chrome executable or initialized profile folder is unavailable. Check the approved mapping with npm run profile:map; no browser was launched.',
      );
    }
    try {
      const current = (await this.load(this.mappingURL)).profiles[profileID];
      if (
        !current ||
        current.executable !== mapping.executable ||
        current.profilePath !== mapping.profilePath
      )
        throw new Error();
    } catch {
      throw new Error(
        'Local Chrome launch approval changed during validation. No browser was launched; check the mapping before trying again.',
      );
    }
    if (signal.aborted) throw new Error('Profile connection cancelled.');
    if (this.check(profileID).connected) return { connected: true, launched: false };
    if (this.now() - started >= this.timeout)
      throw new Error(
        'Profile connection timed out before Chrome launch. No browser was launched.',
      );
    if (this.now() - (this.launchedAt.get(profileID) ?? -Infinity) < 30000)
      throw new Error(
        'Chrome was already launched for this profile recently. Check its extension popup before trying again; no additional window was opened.',
      );
    this.launchedAt.set(profileID, this.now());
    await this.launch(resolved);
    while (this.now() - started < this.timeout) {
      if (signal.aborted) throw new Error('Profile connection cancelled.');
      if (this.check(profileID).connected) {
        await this.hub.flush();
        if (signal.aborted) throw new Error('Profile connection cancelled.');
        if (this.check(profileID).connected) return { connected: true, launched: true };
      }
      await this.delay(200, undefined, { signal });
    }
    throw new Error(
      'Chrome was opened, but the requested profile did not reconnect in time. Check that profile’s extension, pairing URL and website permission. No account fallback, bridge restart or browser-action replay was performed.',
    );
  }
}
