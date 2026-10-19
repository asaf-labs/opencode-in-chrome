export class RecordingCapture {
  active = null;

  constructor(chrome, browser) {
    this.chrome = chrome;
    this.browser = browser;
    this.onFrame = (source, method, params) => {
      const capture = this.active;
      if (
        !capture ||
        source.sessionId ||
        source.tabId !== capture.tabID ||
        method !== 'Page.screencastFrame'
      )
        return;
      const pending = this.frame(capture, params)
        .catch((error) => {
          capture.error = error;
        })
        .finally(() => capture.pending.delete(pending));
      capture.pending.add(pending);
    };
    this.onDetach = (source) => {
      if (!source.sessionId && this.active?.tabID === source.tabId)
        this.active.error = new Error(
          'Recording debugger detached; this attempt will be discarded.',
        );
    };
  }

  owns(command, tabID) {
    return (
      (this.active?.command === command || this.active?.command === command.recordingParent) &&
      this.active?.tabID === tabID &&
      !this.active.error
    );
  }

  assert(capture) {
    if (capture.closed || this.active !== capture) throw new Error('Recording capture stopped.');
    if (!this.browser.debuggers.valid(capture.lease))
      throw new Error('Recording debugger attachment stopped.');
    this.browser.assert(capture.command);
    if (this.browser.owner(capture.tabID)?.[0] !== capture.command.sessionID)
      throw new Error('Recording tab ownership changed.');
    if (capture.error) throw capture.error;
    if (Date.now() - capture.started > 15000) throw new Error('Recorded step exceeded 15 seconds.');
  }

  add(capture, data, force = false) {
    this.assert(capture);
    const timestamp = Date.now() - capture.started;
    if (!force && timestamp - (capture.frames.at(-1)?.timestamp ?? -1000) < 200) return;
    if (
      typeof data !== 'string' ||
      data.length > 512 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    )
      throw new Error('Invalid recording frame.');
    capture.bytes += data.length;
    if (capture.bytes > 8 * 1024 * 1024 || capture.frames.length >= 100)
      throw new Error('Recorded step exceeded its frame budget.');
    capture.frames.push({ data, timestamp });
  }

  async frame(capture, params) {
    try {
      this.add(capture, params.data);
    } finally {
      await this.chrome.debugger.sendCommand({ tabId: capture.tabID }, 'Page.screencastFrameAck', {
        sessionId: params.sessionId,
      });
    }
  }

  async snapshot(capture) {
    this.assert(capture);
    const shot = await this.chrome.debugger.sendCommand(
      { tabId: capture.tabID },
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 55 },
    );
    this.add(capture, shot.data, true);
  }

  async start(command, tabID) {
    if (this.active)
      throw new Error('Another recorded step is capturing. Retry after it finishes.');
    if (!this.chrome.debugger?.onEvent)
      throw new Error('Reload the extension with debugger permission to record.');
    const capture = {
      command,
      tabID,
      started: Date.now(),
      frames: [],
      bytes: 0,
      pending: new Set(),
    };
    this.active = capture;
    try {
      capture.attachPromise = this.browser.debuggers.acquire(command, tabID).then((lease) => {
        capture.lease = lease;
      });
      await capture.attachPromise;
      this.assert(capture);
      this.chrome.debugger.onEvent.addListener(this.onFrame);
      this.chrome.debugger.onDetach.addListener(this.onDetach);
      await this.snapshot(capture);
      await this.chrome.debugger.sendCommand({ tabId: tabID }, 'Page.startScreencast', {
        format: 'jpeg',
        quality: 55,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 1,
      });
      this.assert(capture);
      return capture;
    } catch (error) {
      await this.stop(capture);
      throw error;
    }
  }

  async stop(capture = this.active) {
    if (!capture) return;
    if (capture.stopping) return capture.stopping;
    capture.closed = true;
    if (this.active === capture) {
      this.chrome.debugger.onEvent?.removeListener(this.onFrame);
      this.chrome.debugger.onDetach?.removeListener(this.onDetach);
    }
    capture.stopping = this.cleanup(capture);
    return capture.stopping;
  }

  async cleanup(capture) {
    await capture.attachPromise?.catch(() => {});
    await Promise.allSettled(capture.pending);
    if (this.browser.debuggers.valid(capture.lease)) {
      await this.chrome.debugger
        .sendCommand({ tabId: capture.tabID }, 'Page.stopScreencast')
        .catch(() => {});
    }
    await this.browser.debuggers.release(capture.lease);
    if (this.active === capture) this.active = null;
    return capture;
  }
}
