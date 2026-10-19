import { redactBody, redactHeaders, redactText, redactURL } from './inspection-privacy.js';
import { InspectionProfiles } from './inspection-profiles.js';

const levels = { debug: 0, info: 1, warning: 2, error: 3 };
export class Inspections {
  states = new Map();

  constructor(chrome, browser) {
    this.chrome = chrome;
    this.browser = browser;
    this.profiles = new InspectionProfiles(chrome, this);
    chrome.debugger?.onEvent?.addListener((source, method, params) => {
      const state = this.states.get(source.tabId);
      if (!state || source.sessionId || state.closed || !state.ready) return;
      if (!this.live(state)) {
        void this.remove(state.tabID);
        return;
      }
      try {
        this.event(state, method, params);
      } catch {
        state.dropped++;
      }
    });
    chrome.debugger?.onDetach?.addListener((source) => {
      if (this.states.has(source.tabId)) void this.remove(source.tabId);
    });
  }

  live(state) {
    const binding = this.browser.bindings[state.sessionID];
    return (
      this.browser.enabled &&
      !state.closed &&
      !binding?.paused &&
      binding?.generation === state.generation &&
      this.browser.owner(state.tabID)?.[0] === state.sessionID &&
      this.browser.debuggers.valid(state.lease)
    );
  }

  assert(command, state) {
    this.browser.assert(command);
    if (!this.live(state) || state.sessionID !== command.sessionID)
      throw new Error('Inspection stopped, detached, or belongs to another session.');
  }

  get(command) {
    this.browser.assert(command);
    const state = this.states.get(command.args.tabID);
    if (!state) throw new Error('Start inspection on this session-owned tab first.');
    this.assert(command, state);
    return state;
  }

  async start(command) {
    const { tabID, captureBodies = false } = command.args;
    this.browser.assert(command);
    if (this.browser.owner(tabID)?.[0] !== command.sessionID)
      throw new Error('Inspection requires a session-owned tab.');
    if (this.states.has(tabID) || this.states.size >= 3)
      throw new Error('Inspection already exists or the three-tab capture limit was reached.');
    const state = {
      tabID,
      sessionID: command.sessionID,
      generation: command.generation,
      captureBodies,
      epoch: 0,
      requests: new Map(),
      current: new Map(),
      messages: [],
      dropped: 0,
      droppedMessages: 0,
    };
    this.states.set(tabID, state);
    try {
      const tab = await this.chrome.tabs.get(tabID);
      this.browser.assert(command);
      if (state.closed || this.states.get(tabID) !== state)
        throw new Error('Inspection stopped before attachment.');
      if (!/^https?:\/\//.test(tab.url || ''))
        throw new Error('Inspection requires an HTTP/HTTPS page.');
      state.acquiring = this.browser.debuggers.acquire(command, tabID);
      state.lease = await state.acquiring;
      this.assert(command, state);
      for (const [method, params] of [
        [
          'Network.enable',
          {
            maxTotalBufferSize: 2 * 1024 * 1024,
            maxResourceBufferSize: 128 * 1024,
            maxPostDataSize: captureBodies ? 20000 : 0,
          },
        ],
        ['Runtime.enable', {}],
        ['Log.enable', {}],
        ['Page.enable', {}],
      ]) {
        await this.chrome.debugger.sendCommand({ tabId: tabID }, method, params);
        this.assert(command, state);
      }
      const tree = await this.chrome.debugger.sendCommand({ tabId: tabID }, 'Page.getFrameTree');
      this.assert(command, state);
      state.frameID = tree?.frameTree?.frame?.id;
      state.ready = true;
      state.timer = setTimeout(() => {
        void this.remove(tabID);
      }, 300000);
      return {
        tabID,
        capturing: true,
        captureBodies,
        expiresInMs: 300000,
        note: 'Capture starts now; no historical traffic. Common secrets are redacted, not all private data.',
      };
    } catch (error) {
      await this.remove(tabID);
      throw error;
    }
  }

  clearNetwork(state) {
    state.epoch++;
    state.requests.clear();
    state.current.clear();
    state.messages = [];
    state.dropped = 0;
    state.droppedMessages = 0;
  }

  async navigated(tabID, loaderID) {
    const state = this.states.get(tabID);
    if (!state) return;
    const navigation = loaderID
      ? [...state.requests.values()].filter((row) => row.loaderID === loaderID)
      : [];
    this.clearNetwork(state);
    for (const row of navigation) {
      state.requests.set(row.id, row);
      state.current.set(row.cdpID, row);
    }
    await this.profiles.clear(state);
  }

  trim(state) {
    while (
      state.requests.size > 200 ||
      JSON.stringify([...state.requests.values()]).length > 2 * 1024 * 1024
    ) {
      const first = state.requests.keys().next().value;
      const row = state.requests.get(first);
      state.requests.delete(first);
      if (state.current.get(row.cdpID) === row) state.current.delete(row.cdpID);
      state.dropped++;
    }
  }

  log(state, level, text, timestamp, source) {
    state.messages.push({
      level,
      text: redactText(text, 2000),
      timestampMs: timestamp || Date.now(),
      truncated: String(text ?? '').length > 2000,
      source: source
        ? {
            url: redactURL(source.url),
            lineNumber: source.lineNumber,
            columnNumber: source.columnNumber,
          }
        : undefined,
    });
    if (state.messages.length > 300) {
      state.messages.shift();
      state.droppedMessages++;
    }
  }

  event(state, method, params) {
    if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      state.frameID = params.frame.id;
      void this.navigated(state.tabID, params.frame.loaderId);
      return;
    }
    if (method === 'Page.navigatedWithinDocument' && params.frameId === state.frameID) {
      void this.navigated(state.tabID);
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      if (!/^https?:\/\//.test(params.request.url)) return;
      const previous = state.current.get(params.requestId);
      if (previous && params.redirectResponse) {
        previous.statusCode = params.redirectResponse.status;
        previous.state = 'completed';
        previous.redirect = true;
        previous.durationMs = Math.max(0, (params.timestamp - previous.started) * 1000);
        previous.responseHeaders = redactHeaders(params.redirectResponse.headers);
      }
      const row = {
        id: crypto.randomUUID(),
        cdpID: params.requestId,
        loaderID: params.loaderId,
        url: redactURL(params.request.url),
        method: params.request.method.slice(0, 20),
        resourceType: params.type,
        timestampMs: params.wallTime * 1000,
        started: params.timestamp,
        state: 'pending',
        requestHeaders: redactHeaders(params.request.headers),
        responseHeaders: [],
        requestBody: state.captureBodies
          ? params.request.postData
            ? redactBody(params.request.postData)
            : {
                state: params.request.hasPostData ? 'unavailable' : 'empty',
                reason: params.request.hasPostData ? 'notCaptured' : undefined,
              }
          : { state: 'notCaptured' },
      };
      state.requests.set(row.id, row);
      state.current.set(params.requestId, row);
      this.trim(state);
      return;
    }
    const row = state.current.get(params.requestId);
    if (row && method === 'Network.requestWillBeSentExtraInfo')
      row.requestHeaders = redactHeaders(params.headers);
    if (row && method === 'Network.responseReceived') {
      row.statusCode = params.response.status;
      row.mimeType = params.response.mimeType;
      row.responseHeaders = redactHeaders(params.response.headers);
      row.timing = params.response.timing
        ? {
            dnsMs: Math.max(0, params.response.timing.dnsEnd - params.response.timing.dnsStart),
            connectMs: Math.max(
              0,
              params.response.timing.connectEnd - params.response.timing.connectStart,
            ),
            waitMs: Math.max(
              0,
              params.response.timing.receiveHeadersEnd - params.response.timing.sendEnd,
            ),
          }
        : undefined;
    }
    if (row && method === 'Network.responseReceivedExtraInfo')
      row.responseHeaders = redactHeaders(params.headers);
    if (row && ['Network.loadingFinished', 'Network.loadingFailed'].includes(method)) {
      row.state = method === 'Network.loadingFinished' ? 'completed' : 'failed';
      row.durationMs = Math.max(0, (params.timestamp - row.started) * 1000);
      row.encodedDataLength = params.encodedDataLength;
      if (row.state === 'failed') row.failure = redactText(params.errorText, 500);
    }
    if (row) this.trim(state);
    if (method === 'Runtime.consoleAPICalled')
      this.log(
        state,
        ['error', 'assert'].includes(params.type)
          ? 'error'
          : params.type === 'warning'
            ? 'warning'
            : ['debug', 'trace'].includes(params.type)
              ? 'debug'
              : 'info',
        params.args
          .slice(0, 20)
          .map((arg) =>
            arg.type === 'object'
              ? arg.subtype === 'error'
                ? redactText(arg.description, 2000)
                : `[${arg.subtype || 'object'}]`
              : String(arg.value ?? arg.unserializableValue ?? arg.type).slice(0, 2000),
          )
          .join(' '),
        params.timestamp,
        params.stackTrace?.callFrames?.[0],
      );
    if (method === 'Runtime.exceptionThrown')
      this.log(
        state,
        'error',
        params.exceptionDetails.exception?.description || params.exceptionDetails.text,
        params.timestamp,
        params.exceptionDetails,
      );
    if (method === 'Log.entryAdded')
      this.log(
        state,
        params.entry.level === 'verbose' ? 'debug' : params.entry.level,
        params.entry.text,
        params.entry.timestamp,
        params.entry.url ? params.entry : undefined,
      );
  }

  list(command) {
    const state = this.get(command);
    const rows = [...state.requests.values()].filter(
      (row) => !command.args.urlContains || row.url.includes(command.args.urlContains),
    );
    const limit = command.args.limit ?? 50;
    return {
      requests: rows
        .slice(-limit)
        .map(
          ({
            id,
            url,
            method,
            resourceType,
            timestampMs,
            state,
            statusCode,
            durationMs,
            failure,
            timing,
          }) => ({
            id,
            url,
            method,
            resourceType,
            timestampMs,
            state,
            statusCode,
            durationMs,
            failure,
            timing,
          }),
        ),
      dropped: state.dropped,
      truncated: rows.length > limit,
    };
  }

  async request(command) {
    const state = this.get(command),
      epoch = state.epoch;
    const row = state.requests.get(command.args.requestID);
    if (!row) throw new Error('Request expired, was evicted, or belongs to a different tab.');
    let responseBody = { state: 'notRequested' },
      requestBody = { state: 'notRequested' };
    if (command.args.includeBody) {
      requestBody = state.captureBodies
        ? row.requestBody
        : { state: 'unavailable', reason: 'captureBodiesDisabled' };
      if (!state.captureBodies)
        responseBody = { state: 'unavailable', reason: 'captureBodiesDisabled' };
      else if (row.state === 'pending') responseBody = { state: 'pending' };
      else if (row.redirect || row.state === 'failed' || state.current.get(row.cdpID) !== row)
        responseBody = { state: 'unavailable', reason: 'notCaptured' };
      else if (row.encodedDataLength > 128 * 1024)
        responseBody = { state: 'unavailable', reason: 'sizeLimit' };
      else if (
        !/^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml))/.test(row.mimeType || '')
      )
        responseBody = { state: 'unavailable', reason: 'binary' };
      else
        try {
          const result = await this.chrome.debugger.sendCommand(
            { tabId: state.tabID },
            'Network.getResponseBody',
            { requestId: row.cdpID },
          );
          responseBody = result.base64Encoded
            ? { state: 'unavailable', reason: 'binary' }
            : redactBody(result.body, command.args.maxBodyChars ?? 20000);
        } catch {
          responseBody = { state: 'unavailable', reason: 'notCaptured' };
        }
    }
    this.assert(command, state);
    if (
      epoch !== state.epoch ||
      state.requests.get(row.id) !== row ||
      (responseBody.state === 'text' && state.current.get(row.cdpID) !== row)
    )
      throw new Error('Request expired while reading its body.');
    if (requestBody.state === 'text')
      requestBody = {
        ...requestBody,
        text: requestBody.text.slice(0, command.args.maxBodyChars ?? 20000),
        truncated:
          requestBody.truncated || requestBody.text.length > (command.args.maxBodyChars ?? 20000),
      };
    return {
      id: row.id,
      url: row.url,
      requestHeaders: row.requestHeaders,
      responseHeaders: row.responseHeaders,
      requestBody,
      responseBody,
    };
  }

  logs(command) {
    const state = this.get(command),
      limit = command.args.limit ?? 50;
    const messages = state.messages.filter(
      (message) => (levels[message.level] ?? 1) >= levels[command.args.level ?? 'debug'],
    );
    return {
      messages: messages.slice(-limit),
      dropped: state.droppedMessages,
      truncated: messages.length > limit,
    };
  }

  async run(command) {
    if (command.tool === 'start_inspection') return this.start(command);
    if (command.tool === 'stop_inspection') {
      this.browser.assert(command);
      const state = this.states.get(command.args.tabID);
      if (
        !state ||
        state.sessionID !== command.sessionID ||
        this.browser.owner(state.tabID)?.[0] !== command.sessionID
      )
        throw new Error('Inspection stopped or belongs to another session.');
      await this.remove(state.tabID);
      return { stopped: true };
    }
    const state = this.get(command);
    if (command.tool === 'network_requests') return this.list(command);
    if (command.tool === 'network_request') return this.request(command);
    if (command.tool === 'console_logs') return this.logs(command);
    if (command.tool === 'start_cpu_profile') return this.profiles.start(command, state, 'cpu');
    if (command.tool === 'stop_cpu_profile') return this.profiles.stop(command, state, 'cpu');
    if (command.tool === 'start_performance_trace')
      return this.profiles.start(command, state, 'performance');
    if (command.tool === 'stop_performance_trace')
      return this.profiles.stop(command, state, 'performance');
    throw new Error('Unknown inspection tool.');
  }

  async remove(tabID) {
    const state = this.states.get(tabID);
    if (!state) return;
    if (state.removing) return state.removing;
    state.closed = true;
    state.ready = false;
    clearTimeout(state.timer);
    state.removing = this.cleanup(state);
    return state.removing;
  }

  async cleanup(state) {
    await state.acquiring?.catch(() => {});
    await this.profiles.clear(state);
    if (this.browser.debuggers.valid(state.lease))
      for (const method of ['Network.disable', 'Runtime.disable', 'Log.disable'])
        await this.chrome.debugger.sendCommand({ tabId: state.tabID }, method).catch(() => {});
    this.clearNetwork(state);
    await this.browser.debuggers.release(state.lease);
    if (this.states.get(state.tabID) === state) this.states.delete(state.tabID);
  }

  async suspend() {
    await Promise.all([...this.states.keys()].map((id) => this.remove(id)));
  }
}
