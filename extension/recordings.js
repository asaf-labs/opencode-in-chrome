import { RecordingCapture } from './recording-capture.js';

function validatePlan(plan) {
  if (
    !Number.isInteger(plan.tabID) ||
    typeof plan.task !== 'string' ||
    !plan.task ||
    plan.task.length > 1000 ||
    typeof plan.goal !== 'string' ||
    !plan.goal ||
    plan.goal.length > 1000 ||
    !Array.isArray(plan.steps) ||
    !plan.steps.length ||
    plan.steps.length > 10 ||
    !Array.isArray(plan.goalChecks) ||
    !plan.goalChecks.length
  )
    throw new Error('Declare a task, goal, and bounded plan before recording.');
  const ids = new Set();
  for (const step of plan.steps) {
    if (
      !/^[a-zA-Z0-9_-]{1,50}$/.test(step.id || '') ||
      ids.has(step.id) ||
      typeof step.description !== 'string' ||
      !step.description ||
      step.description.length > 500 ||
      !Array.isArray(step.actions) ||
      !step.actions.length ||
      step.actions.length > 5
    )
      throw new Error('Invalid recording step.');
    ids.add(step.id);
    for (const action of step.actions) {
      if (!['navigate', 'click', 'type', 'select', 'check', 'scroll'].includes(action.tool))
        throw new Error('Unsupported recorded action.');
      if (
        ['click', 'type', 'select', 'check'].includes(action.tool) &&
        (typeof action.selector !== 'string' || !action.selector || action.selector.length > 1000)
      )
        throw new Error('Recorded actions require bounded unique selectors, never refs.');
    }
  }
  for (const checks of [
    plan.goalChecks,
    ...plan.steps.flatMap((step) => [step.before, step.after]),
  ]) {
    if (
      !Array.isArray(checks) ||
      !checks.length ||
      checks.length > 10 ||
      checks.some(
        (check) =>
          !check ||
          (!check.url && !check.selector) ||
          !['url', 'text', 'value', 'checked', 'visible'].some((key) => check[key] !== undefined),
      )
    )
      throw new Error('Every step requires observable preconditions and postconditions.');
  }
}

export class Recordings {
  sessions = new Map();
  creatingOffscreen = null;

  constructor(chrome, browser) {
    this.chrome = chrome;
    this.browser = browser;
    this.capture = new RecordingCapture(chrome, browser);
  }

  get(command, requireTab = true) {
    this.browser.assert(command);
    const recording = this.sessions.get(command.sessionID);
    if (!recording || recording.id !== command.args.recordingID)
      throw new Error('Recording not found for this session.');
    if (requireTab && this.browser.owner(recording.plan.tabID)?.[0] !== command.sessionID)
      throw new Error('This session no longer owns the recording tab.');
    return recording;
  }

  async start(command) {
    this.browser.assert(command);
    validatePlan(command.args);
    if (this.sessions.has(command.sessionID))
      throw new Error('Finish or cancel the current recording first.');
    if (this.sessions.size >= 3)
      throw new Error('At most three recordings may be retained; finish or cancel one first.');
    if (this.browser.owner(command.args.tabID)?.[0] !== command.sessionID)
      throw new Error('Recording requires a session-owned tab.');
    const tab = await this.chrome.tabs.get(command.args.tabID);
    this.browser.assert(command);
    if (this.sessions.has(command.sessionID) || this.sessions.size >= 3)
      throw new Error('Recording slot unavailable; finish or cancel an existing plan.');
    if (this.browser.owner(command.args.tabID)?.[0] !== command.sessionID)
      throw new Error('Recording tab ownership changed.');
    if (!/^https?:\/\//.test(tab.url || ''))
      throw new Error('Open the task website before declaring a recording.');
    const recording = {
      id: crypto.randomUUID(),
      plan: structuredClone(command.args),
      initialURL: tab.url,
      accepted: [],
      omittedAttempts: 0,
      bytes: 0,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(command.sessionID, recording);
    return {
      recordingID: recording.id,
      nextStep: recording.plan.steps[0].id,
      note: 'Immutable plan declared; no capture outside recorded steps.',
    };
  }

  async checks(command, recording, checks, wait = false) {
    const deadline = Math.min(command.expiresAt - 500, Date.now() + (wait ? 3000 : 0));
    do {
      const result = await this.browser.recordingInspect(command, recording.plan.tabID, checks);
      if (result.passed) return;
      if (!wait || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.browser.assert(command);
    } while (wait && Date.now() < deadline);
    throw new Error(
      'Declared page conditions did not pass. Restore the step preconditions before retrying; side effects are not undone.',
    );
  }

  async step(command) {
    const recording = this.get(command);
    if (recording.busy) throw new Error('Recording is busy.');
    const step = recording.plan.steps[recording.accepted.length];
    if (!step || step.id !== command.args.stepID)
      throw new Error('Run only the next step from the declared plan.');
    recording.busy = true;
    let capture;
    try {
      await this.checks(command, recording, step.before);
      capture = await this.capture.start(command, recording.plan.tabID);
      for (const action of step.actions) {
        this.capture.assert(capture);
        await this.browser.recordingAction(command, recording.plan.tabID, action);
        this.capture.assert(capture);
      }
      await this.checks(command, recording, step.after, true);
      await this.capture.snapshot(capture);
      this.capture.assert(capture);
      if (recording.bytes + capture.bytes > 32 * 1024 * 1024)
        throw new Error('Recording exceeded its memory budget.');
      const duration = Math.ceil(Math.max(1000, Date.now() - capture.started + 500) / 100) * 100;
      if (recording.accepted.reduce((sum, segment) => sum + segment.duration, duration) > 90000)
        throw new Error('Walkthrough video is limited to 90 seconds.');
      await this.capture.stop(capture);
      this.browser.assert(command);
      if (capture.error) throw capture.error;
      if (this.sessions.get(command.sessionID) !== recording)
        throw new Error('Recording was cancelled.');
      recording.accepted.push({ step, frames: capture.frames, duration });
      recording.bytes += capture.bytes;
      return {
        verified: true,
        retained: true,
        stepID: step.id,
        completedSteps: recording.accepted.length,
        nextStep: recording.plan.steps[recording.accepted.length]?.id || null,
      };
    } catch (error) {
      recording.omittedAttempts++;
      if (this.capture.active?.command === command) await this.capture.stop();
      if (capture) capture.frames = [];
      throw new Error(
        `${error.message} This attempt was excluded from the video and action manifest.`,
        { cause: error },
      );
    } finally {
      recording.busy = false;
    }
  }

  async offscreen(command, recording, message) {
    const url = this.chrome.runtime.getURL('recording-offscreen.html');
    const contexts = await this.chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (!contexts.length) {
      this.creatingOffscreen ||= this.chrome.offscreen.createDocument({
        url: 'recording-offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Encode verified browser frames into a local WebM walkthrough.',
      });
      try {
        await this.creatingOffscreen;
      } finally {
        this.creatingOffscreen = null;
      }
    }
    this.browser.assert(command);
    if (this.sessions.get(command.sessionID) !== recording)
      throw new Error('Recording was cancelled.');
    const response = await this.chrome.runtime.sendMessage({
      target: 'recording-offscreen',
      ...message,
    });
    if (response?.error) throw new Error(response.error);
    if (!response?.video) throw new Error('The recording encoder returned no video.');
    return response;
  }

  async finish(command) {
    const recording = this.get(command);
    if (recording.busy) throw new Error('Recording is busy.');
    if (recording.accepted.length !== recording.plan.steps.length)
      throw new Error('Every planned step must be verified before export.');
    recording.busy = true;
    try {
      await this.checks(command, recording, recording.plan.goalChecks);
      const output = await this.offscreen(command, recording, {
        jobID: recording.id,
        segments: recording.accepted.map(({ step, frames, duration }) => ({
          id: step.id,
          description: step.description,
          frames,
          duration,
        })),
      });
      this.browser.assert(command);
      if (this.sessions.get(command.sessionID) !== recording)
        throw new Error('Recording was cancelled.');
      return {
        video: output.video,
        manifest: {
          schemaVersion: 1,
          kind: 'edited-verified-walkthrough',
          edited: true,
          goalVerified: true,
          task: recording.plan.task,
          goal: recording.plan.goal,
          initialURL: recording.initialURL,
          createdAt: recording.createdAt,
          omittedAttempts: recording.omittedAttempts,
          steps: recording.accepted.map(({ step }, index) => ({
            ...step,
            video: output.timeline[index],
          })),
          goalChecks: recording.plan.goalChecks,
          replayPlan: {
            task: recording.plan.task,
            goal: recording.plan.goal,
            steps: recording.plan.steps,
            goalChecks: recording.plan.goalChecks,
          },
          replay:
            'Open a new owned tab at initialURL. Pass replayPlan plus the new tabID to start_recording, then run each step in order. Selectors and conditions must match uniquely. Replay is explicit and may repeat side effects; it is never automatic.',
        },
      };
    } finally {
      recording.busy = false;
    }
  }

  async cancel(command) {
    const recording = this.get(command, false);
    this.sessions.delete(command.sessionID);
    const capture =
      this.capture.active?.command.sessionID === command.sessionID ? this.capture.active : null;
    await Promise.all([
      this.abortExport(recording.id),
      capture ? this.capture.stop(capture) : Promise.resolve(),
    ]);
    recording.accepted = [];
    return { cancelled: true };
  }

  async suspend() {
    const ids = [...this.sessions.values()].map((recording) => recording.id);
    this.sessions.clear();
    await Promise.all([this.capture.stop(), ...ids.map((id) => this.abortExport(id))]);
  }

  async removed(tabID) {
    const capture = this.capture.active?.tabID === tabID ? this.capture.active : null;
    if (capture) capture.error = new Error('Recording tab closed or became protected.');
    const stopped = capture ? this.capture.stop(capture) : Promise.resolve();
    for (const [sessionID, recording] of this.sessions) {
      if (recording.plan.tabID === tabID) {
        this.sessions.delete(sessionID);
        await this.abortExport(recording.id);
      }
    }
    await stopped;
  }

  async abortExport(jobID) {
    if (!this.chrome.runtime?.getContexts) return;
    const contexts = await this.chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [this.chrome.runtime.getURL('recording-offscreen.html')],
    });
    if (contexts.length)
      await this.chrome.runtime
        .sendMessage({ target: 'recording-offscreen', type: 'cancel', jobID })
        .catch(() => {});
  }
}
