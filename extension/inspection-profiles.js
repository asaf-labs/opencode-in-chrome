import { redactText, redactURL, safeCPUProfile } from './inspection-privacy.js';

export class InspectionProfiles {
  constructor(chrome, inspections) {
    this.chrome = chrome;
    this.inspections = inspections;
  }

  async performance(tabID, method, args = []) {
    await this.chrome.scripting.executeScript({
      target: { tabId: tabID },
      files: ['performance-capture.js'],
    });
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: tabID },
      func: async (name, input) => {
        try {
          return await globalThis.__opencodePerformance[name](...input);
        } catch (error) {
          return { opencodeError: error.message };
        }
      },
      args: [method, args],
    });
    const result = results[0]?.result;
    if (typeof result?.opencodeError === 'string') throw new Error(result.opencodeError);
    return result;
  }

  async start(command, state, kind) {
    await state.profileClearing;
    this.inspections.assert(command, state);
    if (state[kind]?.read) delete state[kind];
    if (state[kind])
      throw new Error('Export or discard the previous profile before starting another.');
    const durationMs = command.args.durationMs ?? 10000;
    if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000)
      throw new Error('Profile duration must be between 1 and 30 seconds.');
    const profile = { id: crypto.randomUUID(), epoch: state.epoch, kind, started: Date.now() };
    state[kind] = profile;
    try {
      if (kind === 'cpu') {
        await this.chrome.debugger.sendCommand({ tabId: state.tabID }, 'Profiler.enable');
        this.inspections.assert(command, state);
        await this.chrome.debugger.sendCommand(
          { tabId: state.tabID },
          'Profiler.setSamplingInterval',
          { interval: 1000 },
        );
        this.inspections.assert(command, state);
        profile.starting = this.chrome.debugger.sendCommand(
          { tabId: state.tabID },
          'Profiler.start',
        );
        await profile.starting;
      } else {
        profile.starting = this.performance(state.tabID, 'start', [profile.id, durationMs]);
        profile.supported = (await profile.starting)?.supported;
      }
      this.inspections.assert(command, state);
      if (state[kind] !== profile || state.epoch !== profile.epoch)
        throw new Error('Page changed while profiling started.');
      profile.timer = setTimeout(() => {
        void this.complete(state, profile).catch(() => {});
      }, durationMs);
      return { tabID: state.tabID, started: true, durationMs, supported: profile.supported };
    } catch (error) {
      if (state[kind] === profile) delete state[kind];
      await this.complete(state, profile, true).catch(() => {});
      throw error;
    }
  }

  async complete(state, profile, discard = false) {
    clearTimeout(profile.timer);
    if (profile.completion) return profile.completion;
    profile.completion = this.collect(state, profile, discard);
    return profile.completion;
  }

  async collect(state, profile, discard) {
    try {
      await profile.starting?.catch(() => {});
      if (profile.kind === 'cpu') {
        const result = await this.chrome.debugger.sendCommand(
          { tabId: state.tabID },
          'Profiler.stop',
        );
        if (!discard && !state.closed && profile.epoch === state.epoch)
          profile.result = safeCPUProfile(result.profile);
      } else {
        const result = await this.performance(state.tabID, 'stop', [profile.id, discard]);
        if (!discard && !state.closed && profile.epoch === state.epoch) profile.result = result;
      }
      if (profile.result && JSON.stringify(profile.result).length > 5 * 1024 * 1024)
        throw new Error('Profile exceeded its export budget.');
    } catch (error) {
      profile.error = new Error(
        'Profile unavailable: capture stopped, page changed, or its budget was exceeded.',
        { cause: error },
      );
    } finally {
      if (profile.kind === 'cpu')
        await this.chrome.debugger
          .sendCommand({ tabId: state.tabID }, 'Profiler.disable')
          .catch(() => {});
    }
    if (discard) delete profile.result;
  }

  async stop(command, state, kind) {
    const profile = state[kind];
    if (!profile) throw new Error('No profile is available; start one on this document first.');
    await this.complete(state, profile);
    this.inspections.assert(command, state);
    if (state[kind] !== profile || state.epoch !== profile.epoch)
      throw new Error('Page changed during profiling.');
    if (profile.error) throw profile.error;
    if (!profile.result) throw new Error('Profile returned no data.');
    profile.read = true;
    if (kind === 'cpu')
      return {
        kind: 'cpu-profile',
        data: profile.result,
        summary: {
          nodes: profile.result.nodes.length,
          samples: profile.result.samples.length,
          durationMs: (profile.result.endTime - profile.result.startTime) / 1000,
        },
      };
    const traceEvents = profile.result.events.map((event) => ({
      name:
        event.type === 'resource' || event.type === 'navigation'
          ? redactURL(event.name)
          : redactText(event.name, 1000),
      cat: 'browser.performance.' + event.type,
      ph: 'X',
      ts: Math.round(event.startTime * 1000),
      dur: Math.round(event.duration * 1000),
      pid: 1,
      tid: 1,
      args: {
        type: event.type,
        value: event.value,
        hadRecentInput: event.hadRecentInput,
        transferSize: event.transferSize,
      },
    }));
    return {
      kind: 'performance-timeline',
      data: {
        traceEvents,
        displayTimeUnit: 'ms',
        metadata: {
          source: 'main-frame-performance-observer',
          timeOrigin: profile.result.timeOrigin,
          supported: profile.result.supported,
          dropped: profile.result.dropped,
        },
      },
      summary: {
        events: traceEvents.length,
        dropped: profile.result.dropped,
        source: 'main-frame-performance-observer',
      },
    };
  }

  async clear(state) {
    const profiles = [state.cpu, state.performance].filter(Boolean);
    delete state.cpu;
    delete state.performance;
    state.profileClearing = Promise.all([
      state.profileClearing,
      ...profiles.map((profile) => this.complete(state, profile, true)),
    ]);
    await state.profileClearing;
    for (const profile of profiles) delete profile.result;
  }
}
