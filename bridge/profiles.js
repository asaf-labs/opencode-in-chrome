import { BrowserHub } from './hub.js';
import { validateProfile, readProfileState, writeProfileState } from './profile-store.js';

function scopedResult(result, profileID) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    profileID,
    ...(Array.isArray(result.tabs)
      ? { tabs: result.tabs.map((tab) => ({ ...tab, profileID })) }
      : {}),
    ...(Array.isArray(result.frames)
      ? { frames: result.frames.map((frame) => ({ ...frame, profileID })) }
      : {}),
    ...(Array.isArray(result.elements)
      ? {
          elements: result.elements.map((element) => ({
            ...element,
            ref: profileID === 'legacy' ? element.ref : `p${profileID}:${element.ref}`,
          })),
        }
      : {}),
  };
}

export class ProfileHub {
  profiles = new Map();
  selections = new Map();
  inFlight = new Map();
  writing = Promise.resolve();
  persistenceError = null;

  constructor({ state = { profiles: [], selections: {} }, save = async () => {} } = {}) {
    this.save = save;
    for (const profile of state.profiles)
      this.profiles.set(profile.id, { ...profile, hub: new BrowserHub() });
    this.selections = new Map(Object.entries(state.selections));
  }

  get socket() {
    return (
      [...this.profiles.values()].find((profile) => profile.hub.socket?.readyState === 1)?.hub
        .socket || null
    );
  }
  get browserEnabled() {
    return [...this.profiles.values()].some(
      (profile) => profile.hub.socket?.readyState === 1 && profile.hub.browserEnabled,
    );
  }
  get extensionProtocol() {
    return (
      Math.max(
        0,
        ...[...this.profiles.values()]
          .filter((profile) => profile.hub.socket?.readyState === 1)
          .map((profile) => profile.hub.extensionProtocol || 0),
      ) || null
    );
  }
  get bindings() {
    return this.profiles.size === 1 ? this.profiles.values().next().value.hub.bindings : new Map();
  }
  get pending() {
    return new Map([...this.profiles.values()].flatMap((profile) => [...profile.hub.pending]));
  }
  get activity() {
    return [...this.profiles.values()]
      .flatMap((profile) =>
        profile.hub.activity.map((entry) => ({ ...entry, profileID: profile.id })),
      )
      .sort((a, b) => a.time - b.time)
      .slice(-100);
  }

  state() {
    return {
      version: 1,
      profiles: [...this.profiles.values()].map(({ id, name }) => ({ id, name })),
      selections: Object.fromEntries(this.selections),
    };
  }
  persist() {
    const state = this.state();
    this.writing = this.writing
      .then(() => this.save(state))
      .then(
        () => {
          this.persistenceError = null;
        },
        (error) => {
          this.persistenceError = error;
        },
      );
    return this.flush();
  }
  async flush() {
    await this.writing;
    if (this.persistenceError)
      throw new Error(
        'Could not persist browser profile routing. No browser action was sent. Check access to .local/profile-routing.json.',
      );
  }

  attach(socket, enabled = false, protocol = 1, identity) {
    const profile =
      protocol === 3 ? validateProfile(identity) : { id: 'legacy', name: 'Legacy Chrome profile' };
    let entry = this.profiles.get(profile.id);
    if (entry?.hub.socket?.readyState === 1) {
      const error = new Error(
        'This profile identity is already connected. Do not use a cloned extension identity in two Chrome profiles.',
      );
      error.code = 'PROFILE_CONNECTED';
      throw error;
    }
    if (!entry) {
      entry = { ...profile, hub: new BrowserHub() };
      this.profiles.set(profile.id, entry);
    }
    entry.name = profile.name;
    entry.hub.attach(socket, enabled, protocol);
    // Calls wait for durable routing. An attach must not create an unhandled rejection.
    void this.persist().catch(() => {});
    return entry.hub;
  }

  profilesSnapshot() {
    return [...this.profiles.values()].map((profile) => ({
      profileID: profile.id,
      name: profile.name,
      connected: profile.hub.socket?.readyState === 1,
      enabled: profile.hub.socket?.readyState === 1 && profile.hub.browserEnabled,
      protocol: profile.hub.extensionProtocol,
      legacy: profile.id === 'legacy',
    }));
  }

  reset(reason) {
    for (const profile of this.profiles.values()) profile.hub.reset(reason);
  }

  async call(sessionID, tool, args = {}, signal) {
    if (!/^ses[\w-]+$/.test(sessionID || ''))
      throw new Error('This tool requires OpenCode session metadata.');
    if (signal?.aborted) throw new Error('Browser action cancelled');
    if (tool === 'list_profiles')
      return {
        profiles: this.profilesSnapshot(),
        selectedProfileID: this.selections.get(sessionID) ?? null,
        routingHealthy: !this.persistenceError,
      };
    const active = this.inFlight.get(sessionID) || 0;
    let id = this.selections.get(sessionID);
    const requested = args.profileID;
    if (requested && !this.profiles.has(requested))
      throw new Error('Unknown browser profile. Call list_profiles and use its profileID.');
    if (requested && requested !== id) {
      if (tool !== 'select_profile' && tool !== 'open_tab' && id)
        throw new Error(
          'The supplied profileID differs from this conversation selection. Use select_profile explicitly.',
        );
      if (active)
        throw new Error(
          "Wait for or cancel this conversation's browser actions before switching profiles.",
        );
      id = requested;
    }
    if (!id) {
      let candidates = [...this.profiles.keys()];
      if (candidates.length > 1 && this.profiles.get('legacy')?.hub.socket === null)
        candidates = candidates.filter((candidate) => candidate !== 'legacy');
      if (!candidates.length)
        throw new Error(
          'Chrome is disconnected. Install and opt in from the extension popup in the desired profile.',
        );
      if (candidates.length !== 1)
        throw new Error(
          'Multiple browser profiles are registered. Call list_profiles, ask the user which account/profile to use, and call select_profile.',
        );
      if (candidates[0] !== 'legacy')
        throw new Error(
          'Select a browser profile for this conversation before acting. Call list_profiles and select_profile, or pass profileID explicitly.',
        );
      id = candidates[0];
    }
    if (!this.profiles.has(id))
      throw new Error(
        'Selected profile is unavailable. Choose a profile explicitly with select_profile.',
      );
    if (tool === 'select_profile' && !requested)
      throw new Error('select_profile requires profileID.');
    this.inFlight.set(sessionID, active + 1);
    try {
      if (this.selections.get(sessionID) !== id || this.persistenceError) {
        this.selections.set(sessionID, id);
        await this.persist();
      }
      await this.flush();
      if (signal?.aborted) throw new Error('Browser action cancelled');
      const profile = this.profiles.get(id);
      if (tool === 'select_profile')
        return {
          ...this.profilesSnapshot().find((candidate) => candidate.profileID === id),
          selected: true,
        };
      if (!profile.hub.socket || profile.hub.socket.readyState !== 1)
        throw new Error(
          `Selected profile "${profile.name}" is disconnected. Reopen/reconnect that profile or select another explicitly; no fallback was used.`,
        );
      if ([2, 3].includes(profile.hub.extensionProtocol) && !profile.hub.browserEnabled)
        throw new Error(
          `Selected profile "${profile.name}" has browser access disabled. Enable it in that profile's popup; no fallback was used.`,
        );
      if (
        (args.tabID !== undefined || args.frameID !== undefined) &&
        this.profiles.size > 1 &&
        requested !== id
      )
        throw new Error(
          'With multiple profiles, include the selected profileID alongside explicit tabID/frameID targets to avoid numeric-ID ambiguity.',
        );
      const input = { ...args };
      delete input.profileID;
      if (input.ref) {
        const match = /^p([^:]+):(.+)$/.exec(input.ref);
        if (match) {
          if (match[1] !== id)
            throw new Error(
              'Element ref belongs to a different profile. Select that profile or take a fresh snapshot.',
            );
          input.ref = match[2];
        } else if (id !== 'legacy')
          throw new Error('Use the complete profile-scoped ref returned by read_page.');
      }
      return scopedResult(await profile.hub.call(sessionID, tool, input, signal), id);
    } finally {
      const count = (this.inFlight.get(sessionID) || 1) - 1;
      if (count) this.inFlight.set(sessionID, count);
      else this.inFlight.delete(sessionID);
    }
  }
}

export async function createProfileHub(url) {
  return new ProfileHub({
    state: await readProfileState(url),
    save: (state) => writeProfileState(url, state),
  });
}
