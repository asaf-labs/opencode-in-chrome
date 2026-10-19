import { Recordings } from './recordings.js';
import { DebuggerSessions } from './debugger-sessions.js';
import { Inspections } from './inspections.js';
import { parseFrameRef, scopeSnapshot, combineSnapshots } from './frame-refs.js';

function pageResult(result) {
  if (typeof result?.opencodeError === 'string') throw new Error(result.opencodeError);
  return result;
}

export class SessionBrowser {
  bindings = {};
  documents = new Map();
  frameDocuments = new Map();
  enabled = false;
  clickingTabs = new Set();
  groupWork = new Map();
  sessionWork = new Map();

  serial(map, key, work) {
    const next = (map.get(key) || Promise.resolve()).catch(() => {}).then(work);
    map.set(key, next);
    void next
      .finally(() => {
        if (map.get(key) === next) map.delete(key);
      })
      .catch(() => {});
    return next;
  }

  constructor(chrome, publish = () => {}) {
    this.chrome = chrome;
    this.publish = publish;
    this.debuggers = new DebuggerSessions(chrome, this);
    this.inspections = new Inspections(chrome, this);
    this.recordings = new Recordings(chrome, this);
  }

  async restore(saved) {
    // Only v2 ownership records are restored. Manually connected v1 tabs are never adopted.
    for (const [sessionID, binding] of Object.entries(saved || {})) {
      if (!/^ses[\w-]+$/.test(sessionID) || !Array.isArray(binding.tabs) || !binding.generation)
        continue;
      const tabs = [];
      for (const owned of binding.tabs) {
        try {
          tabs.push({ ...owned, ...this.info(await this.chrome.tabs.get(owned.id)) });
        } catch {}
      }
      this.bindings[sessionID] = {
        ...binding,
        lastActivity: binding.lastActivity || Date.now(),
        tabs,
        currentTabID: tabs.some((t) => t.id === binding.currentTabID)
          ? binding.currentTabID
          : tabs.at(-1)?.id,
      };
    }
  }

  info(tab) {
    return {
      id: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      loading: tab.status === 'loading',
    };
  }

  owner(tabID) {
    return Object.entries(this.bindings).find(([, binding]) =>
      binding.tabs.some((tab) => tab.id === tabID),
    );
  }

  async overlay(tabID) {
    if (!this.owner(tabID)) return;
    try {
      const tab = await this.chrome.tabs.get(tabID);
      if (!/^https?:/.test(tab.url || '') || tab.status === 'loading') return;
      if (this.enabled)
        await this.chrome.scripting.executeScript({
          target: { tabId: tabID, allFrames: true },
          files: ['content.js'],
        });
      await this.chrome.scripting.executeScript({
        target: { tabId: tabID, allFrames: true },
        func: (enabled, hidden) => {
          globalThis.__opencodeChrome?.setEnabled(enabled);
          globalThis.__opencodeChrome?.setIndicatorHidden(hidden);
        },
        args: [
          this.enabled,
          !!this.owner(tabID)?.[1].tabs.find((tab) => tab.id === tabID)?.indicatorHidden,
        ],
      });
    } catch {
      /* A navigating or protected page can’t display an overlay yet. */
    }
  }

  async mark(sessionID, tab) {
    return this.serial(this.groupWork, sessionID, () => this.markGroup(sessionID, tab));
  }

  async markGroup(sessionID, tab) {
    const binding = this.bindings[sessionID];
    if (!binding?.tabs.some((owned) => owned.id === tab.id)) return;
    tab = await this.chrome.tabs.get(tab.id).catch(() => null);
    if (!tab) return;
    await this.chrome.action.setBadgeText({ text: this.enabled ? 'AI' : '', tabId: tab.id });
    await this.chrome.action.setBadgeBackgroundColor({ color: '#f97316', tabId: tab.id });
    // Groups are per window; a session can have tabs in several windows.
    const groups = (binding.groups ||= {});
    try {
      let groupID = groups[tab.windowId];
      if (groupID !== undefined) {
        const group = await this.chrome.tabGroups.get(groupID).catch(() => null);
        if (group?.windowId !== tab.windowId) groupID = undefined;
      }
      groupID = await this.chrome.tabs.group({
        tabIds: [tab.id],
        ...(groupID === undefined ? {} : { groupId: groupID }),
      });
      groups[tab.windowId] = groupID;
      // Consolidate earlier races, but move only verified owned tabs, never personal tabs.
      for (const owned of binding.tabs) {
        const other = await this.chrome.tabs.get(owned.id).catch(() => null);
        if (other?.windowId === tab.windowId && other.groupId !== groupID)
          await this.chrome.tabs.group({ tabIds: [other.id], groupId: groupID });
      }
      await this.chrome.tabGroups.update(groupID, {
        title: `OpenCode · ${sessionID.slice(-6)}${this.enabled ? '' : ' · disabled'}`,
        color: this.enabled ? 'orange' : 'grey',
      });
      await this.save(sessionID);
    } catch {
      /* Visual grouping does not determine tab ownership. */
    }
    await this.overlay(tab.id);
  }

  async refreshIndicators() {
    for (const [sessionID, binding] of Object.entries(this.bindings)) {
      for (const owned of binding.tabs) {
        try {
          await this.mark(sessionID, await this.chrome.tabs.get(owned.id));
        } catch {}
      }
    }
  }

  async setIndicatorHidden(tabID, hidden) {
    const entry = this.owner(tabID);
    if (!entry) throw new Error('Tab is not agent-owned.');
    entry[1].tabs.find((tab) => tab.id === tabID).indicatorHidden = !!hidden;
    await this.save(entry[0]);
    await this.overlay(tabID);
  }

  async updated(tabID, changeInfo, tab) {
    const entry = this.owner(tabID);
    if (!entry) return;
    const [sessionID, binding] = entry;
    Object.assign(
      binding.tabs.find((t) => t.id === tabID),
      this.info(tab),
    );
    if (changeInfo.url) {
      binding.lastActivity = Date.now();
      this.documents.delete(tabID);
      this.frameDocuments.delete(tabID);
      if (!/^https?:\/\//.test(changeInfo.url))
        await Promise.all([
          this.recordings.removed(tabID),
          this.inspections.remove(tabID),
          this.debuggers.clear(tabID),
        ]);
    }
    if (changeInfo.status === 'complete') await this.overlay(tabID);
    await this.save(sessionID);
  }

  async save(sessionID) {
    await this.chrome.storage.session.set({ ownedSessionsV2: this.bindings });
    if (sessionID) this.publish({ type: 'bind', sessionID, binding: this.bindings[sessionID] });
  }

  assert(command) {
    if (command.cancelled || command.recordingParent?.cancelled)
      throw new Error('Browser action cancelled');
    if (command.recordingParent) {
      const capture = this.recordings.capture.active;
      if (
        !capture ||
        capture.closed ||
        capture.command !== command.recordingParent ||
        capture.error
      )
        throw new Error('Recorded step capture stopped or failed.');
      if (Date.now() - capture.started > 15000)
        throw new Error('Recorded step exceeded 15 seconds.');
    }
    if (!this.enabled) throw new Error('Enable browser access in Bridge settings first.');
    if (!/^ses[\w-]+$/.test(command.sessionID || '') || !command.generation)
      throw new Error('Invalid browser session');
    if (!Number.isFinite(command.expiresAt) || Date.now() >= command.expiresAt)
      throw new Error('Browser action expired before execution.');
    let binding = this.bindings[command.sessionID];
    if (!binding) {
      binding = { generation: command.generation, tabs: [], paused: false };
      this.bindings[command.sessionID] = binding;
    }
    if (binding.paused || binding.generation !== command.generation)
      throw new Error(
        'Browser session stopped or changed. Retry after enabling browser access in the extension popup.',
      );
    return binding;
  }

  async pause(sessionID, paused = true) {
    const binding = (this.bindings[sessionID] ||= { tabs: [] });
    binding.paused = paused;
    binding.generation = crypto.randomUUID();
    await Promise.all(
      binding.tabs.flatMap((tab) => [
        this.inspections.remove(tab.id),
        this.recordings.removed(tab.id),
        this.debuggers.clear(tab.id),
      ]),
    );
    await this.save(sessionID);
    if (paused) this.publish({ type: 'pause', sessionID });
  }

  async remove(tabID) {
    this.documents.delete(tabID);
    await Promise.all([this.recordings.removed(tabID), this.inspections.remove(tabID)]);
    await this.debuggers.clear(tabID);
    this.frameDocuments.delete(tabID);
    for (const [sessionID, binding] of Object.entries(this.bindings)) {
      if (!binding.tabs.some((tab) => tab.id === tabID)) continue;
      binding.tabs = binding.tabs.filter((tab) => tab.id !== tabID);
      if (binding.currentTabID === tabID) binding.currentTabID = binding.tabs.at(-1)?.id;
      await this.save(sessionID);
    }
  }

  async created(tab) {
    const entry = Object.entries(this.bindings).find(([, binding]) =>
      binding.tabs.some((owned) => owned.id === tab.openerTabId),
    );
    if (!entry) return;
    const [sessionID, binding] = entry;
    if (binding.tabs.some((owned) => owned.id === tab.id)) return;
    binding.lastActivity = Date.now();
    binding.tabs.push(this.info(tab));
    binding.currentTabID = tab.id;
    await this.save(sessionID);
    await this.mark(sessionID, tab);
  }

  async invalidate() {
    for (const binding of Object.values(this.bindings)) binding.generation = crypto.randomUUID();
    await this.save();
    this.documents.clear();
    this.frameDocuments.clear();
  }

  async suspend() {
    this.enabled = false;
    const clearingDebuggers = this.debuggers.clear();
    const invalidated = this.invalidate();
    // Notify in-flight content scripts immediately, ahead of slower UI/storage work.
    const notifications = Object.values(this.bindings).flatMap((binding) =>
      binding.tabs.map((tab) =>
        this.chrome.tabs.sendMessage(tab.id, { type: 'opencode-disable' }).catch(() => {}),
      ),
    );
    await Promise.all([
      invalidated,
      ...notifications,
      this.recordings.suspend(),
      this.inspections.suspend(),
      clearingDebuggers,
    ]);
    await this.refreshIndicators();
  }

  async cancel(command) {
    command.cancelled = true;
    if (command.tool === 'finish_recording')
      await this.recordings.abortExport(command.args.recordingID);
    if (
      command.executingTabID !== undefined &&
      this.owner(command.executingTabID)?.[0] === command.sessionID
    ) {
      await this.chrome.tabs
        .sendMessage(command.executingTabID, { type: 'opencode-cancel', id: command.id })
        .catch(() => {});
    }
  }

  async run(command) {
    // Stop controls must be able to interrupt pending attachment/capture rather than queue behind it.
    if (['cancel_recording', 'stop_inspection'].includes(command.tool))
      return this.execute(command);
    // Register arriving work immediately, even if it must wait behind maintenance.
    if (this.bindings[command.sessionID])
      this.bindings[command.sessionID].lastActivity = Date.now();
    const tabID = command.args?.tabID ?? this.bindings[command.sessionID]?.currentTabID;
    if (command.tool === 'click' && this.clickingTabs.has(tabID))
      throw new Error('A click is already in progress for this tab.');
    return this.serial(this.sessionWork, command.sessionID, async () => {
      const binding = this.assert(command);
      binding.lastActivity = Date.now();
      await this.save(command.sessionID);
      try {
        return await this.execute(command);
      } finally {
        binding.lastActivity = Date.now();
        await this.save(command.sessionID);
      }
    });
  }

  async execute(command) {
    const binding = this.assert(command),
      args = command.args || {};
    if (command.tool === 'start_recording') return this.recordings.start(command);
    if (command.tool === 'run_recording_step') return this.recordings.step(command);
    if (command.tool === 'finish_recording') return this.recordings.finish(command);
    if (command.tool === 'cancel_recording') return this.recordings.cancel(command);
    if (
      [
        'start_inspection',
        'stop_inspection',
        'network_requests',
        'network_request',
        'console_logs',
        'start_cpu_profile',
        'stop_cpu_profile',
        'start_performance_trace',
        'stop_performance_trace',
      ].includes(command.tool)
    )
      return this.inspections.run(command);
    if (command.tool === 'open_tab') {
      const url = args.url || 'about:blank';
      if (url !== 'about:blank' && !/^https?:\/\//.test(url))
        throw new Error('Only HTTP/HTTPS URLs are supported.');
      const tab = await this.chrome.tabs.create({ url, active: true });
      // Record ownership even if Stop arrived while Chrome was creating the tab.
      binding.tabs.push(this.info(tab));
      binding.currentTabID = tab.id;
      await this.save(command.sessionID);
      await this.mark(command.sessionID, tab);
      this.assert(command);
      return { tabID: tab.id, ...this.info(tab) };
    }
    if (command.tool === 'list_tabs') {
      for (const tab of [...binding.tabs]) {
        try {
          Object.assign(tab, this.info(await this.chrome.tabs.get(tab.id)));
        } catch {
          await this.remove(tab.id);
        }
      }
      this.assert(command);
      await this.save(command.sessionID);
      return { tabs: binding.tabs, currentTabID: binding.currentTabID };
    }
    const tabID = args.tabID ?? binding.currentTabID;
    if (!binding.tabs.some((tab) => tab.id === tabID))
      throw new Error(
        'This session does not own that tab. Use open_tab to create one or list_tabs to find your tabs.',
      );
    command.executingTabID = tabID;
    const tab = await this.chrome.tabs.get(tabID);
    this.assert(command);
    if (command.tool === 'close_tab') {
      await this.chrome.tabs.remove(tabID);
      await this.remove(tabID);
      return { closed: tabID, currentTabID: binding.currentTabID };
    }
    if (command.tool === 'focus_tab' || command.tool === 'screenshot') {
      await this.#focus(command, binding, tab);
      if (command.tool === 'focus_tab') return { tabID, ...this.info(tab) };
      return this.#capture(command, tab);
    }
    if (command.tool === 'navigate') {
      const url = new URL(args.url);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('Only HTTP/HTTPS navigation is supported.');
      this.documents.delete(tabID);
      this.frameDocuments.delete(tabID);
      const navigated = await this.chrome.tabs.update(tabID, { url: url.href });
      Object.assign(
        binding.tabs.find((t) => t.id === tabID),
        this.info(navigated),
      );
      await this.save(command.sessionID);
      return { tabID, url: url.href, loading: true };
    }
    if (!['read_page', 'click', 'type', 'select', 'check', 'scroll'].includes(command.tool))
      throw new Error('Unsupported tool');
    return this.#pageAction(command, tab);
  }

  async #focus(command, binding, tab) {
    await this.chrome.tabs.update(tab.id, { active: true });
    this.assert(command);
    await this.chrome.windows.update(tab.windowId, { focused: true });
    this.assert(command);
    binding.currentTabID = tab.id;
    await this.save(command.sessionID);
  }

  async #capture(command, tab) {
    const [active] = await this.chrome.tabs.query({ active: true, windowId: tab.windowId });
    this.assert(command);
    if (active?.id !== tab.id) throw new Error('Active tab changed; retry screenshot.');
    const dataUrl = await this.chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const [after] = await this.chrome.tabs.query({ active: true, windowId: tab.windowId });
    this.assert(command);
    if (after?.id !== tab.id)
      throw new Error('Active tab changed during capture; retry screenshot.');
    return { data: dataUrl.split(',')[1] };
  }

  async #pageAction(command, tab) {
    const tabID = tab.id;
    const args = command.args || {};
    const deadline = Date.now() + 10000;
    while (tab.status === 'loading' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      this.assert(command);
      tab = await this.chrome.tabs.get(tabID);
    }
    if (tab.status === 'loading')
      throw new Error('Page is still loading; retry read_page shortly.');
    if (!/^https?:/.test(tab.url || ''))
      throw new Error('Navigate this tab to a website before reading or interacting with it.');
    const scoped = args.ref ? parseFrameRef(args.ref) : { frameID: args.frameID ?? 0 };
    const frameID = scoped.frameID;
    if (!Number.isSafeInteger(frameID) || frameID < 0) throw new Error('Invalid frame ID.');
    if (frameID !== 0 && !this.frameDocuments.get(tabID)?.has(frameID))
      throw new Error('Frame is not in the latest snapshot. Call read_page again.');
    const target =
      command.tool === 'read_page' && args.frameID === undefined
        ? { tabId: tabID, allFrames: true }
        : { tabId: tabID, frameIds: [frameID] };
    await this.chrome.scripting.executeScript({ target, files: ['content.js'] });
    this.assert(command);
    if (command.tool === 'read_page') {
      const results = await this.chrome.scripting.executeScript({
        target,
        func: (indicatorHidden) => {
          try {
            return globalThis.__opencodeChrome.run('read_page', { indicatorHidden });
          } catch (error) {
            return { error: error.message };
          }
        },
        args: [!!this.owner(tabID)?.[1].tabs.find((tab) => tab.id === tabID)?.indicatorHidden],
      });
      this.assert(command);
      const frames =
        args.frameID === undefined ? new Map() : this.frameDocuments.get(tabID) || new Map();
      for (const entry of results) {
        const id = entry.frameId ?? frameID;
        if (entry.result?.documentID && !entry.result.error) {
          frames.set(id, entry.result.documentID);
          if (id === 0) this.documents.set(tabID, entry.result.documentID);
        } else frames.delete(id);
      }
      this.frameDocuments.set(tabID, frames);
      const result =
        args.frameID === undefined
          ? combineSnapshots(results)
          : scopeSnapshot(results[0]?.result || {}, frameID);
      if (result.error || !result.documentID)
        throw new Error(result.error || 'Frame returned no snapshot.');
      return { tabID, ...result };
    }
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: tabID, frameIds: [frameID] },
      func: async (tool, input) => {
        try {
          return await globalThis.__opencodeChrome.run(tool, input);
        } catch (error) {
          return { opencodeError: error.message };
        }
      },
      args: [
        command.tool,
        {
          ...args,
          indicatorHidden: !!this.owner(tabID)?.[1].tabs.find((tab) => tab.id === tabID)
            ?.indicatorHidden,
          ...(scoped.ref ? { ref: scoped.ref } : {}),
          documentID:
            frameID === 0
              ? this.documents.get(tabID)
              : this.frameDocuments.get(tabID)?.get(frameID),
          commandID: command.id,
        },
      ],
    });
    this.assert(command);
    const result = pageResult(results[0]?.result);
    if (!result) throw new Error('Page returned no result.');
    if (command.tool === 'click')
      return this.#click(command, tabID, { ...result.clickTarget, frameID, ref: scoped.ref });
    return { tabID, ...(frameID ? { frameID } : {}), ...result };
  }

  #assertClick(command, tabID, target) {
    this.assert(command);
    if (this.owner(tabID)?.[0] !== command.sessionID)
      throw new Error('This session no longer owns the click target.');
    const documentID = target.frameID
      ? this.frameDocuments.get(tabID)?.get(target.frameID)
      : this.documents.get(tabID);
    if (documentID !== target.documentID)
      throw new Error('Page changed before the click. Call read_page again.');
  }

  async #validateClick(command, tabID, target) {
    this.#assertClick(command, tabID, target);
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: tabID, frameIds: [target.frameID || 0] },
      func: async (input) => {
        try {
          return await globalThis.__opencodeChrome?.validateClick(input);
        } catch (error) {
          return { opencodeError: error.message };
        }
      },
      args: [{ ...command.args, ...target, commandID: command.id }],
    });
    this.#assertClick(command, tabID, target);
    if (pageResult(results[0]?.result)?.valid !== true)
      throw new Error('Click target could not be validated. Call read_page again.');
  }

  async #inputPoint(command, tabID, target) {
    if (!target.frameID) return { x: target.x, y: target.y };
    this.#assertClick(command, tabID, target);
    const contexts = await this.chrome.scripting.executeScript({
      target: { tabId: tabID, allFrames: true },
      func: async () => {
        try {
          return await globalThis.__opencodeChrome?.frameContext();
        } catch (error) {
          return { opencodeError: error.message };
        }
      },
    });
    this.#assertClick(command, tabID, target);
    const child = pageResult(contexts.find((entry) => entry.frameId === target.frameID)?.result);
    if (
      !child ||
      child.documentID !== target.documentID ||
      JSON.stringify(child.framePath) !== JSON.stringify(target.framePath)
    )
      throw new Error('Click frame changed. Call read_page again.');
    let point = { x: target.x, y: target.y, ...child };
    for (let depth = child.framePath.length - 1; depth >= 0; depth--) {
      const framePath = child.framePath.slice(0, depth);
      const parent = contexts.find(
        (entry) => JSON.stringify(entry.result?.framePath) === JSON.stringify(framePath),
      );
      if (
        !parent?.result ||
        this.frameDocuments.get(tabID)?.get(parent.frameId) !== parent.result.documentID
      )
        throw new Error('Containing frame changed or is inaccessible. Call read_page again.');
      const projected = await this.chrome.scripting.executeScript({
        target: { tabId: tabID, frameIds: [parent.frameId] },
        func: async (input) => {
          try {
            return await globalThis.__opencodeChrome.projectFramePoint(input);
          } catch (error) {
            return { opencodeError: error.message };
          }
        },
        args: [
          {
            ...point,
            framePath,
            documentID: parent.result.documentID,
            childIndex: child.framePath[depth],
            commandID: command.id,
          },
        ],
      });
      this.#assertClick(command, tabID, target);
      point = pageResult(projected[0]?.result);
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        throw new Error('Containing frame could not validate the click point.');
    }
    return { x: point.x, y: point.y };
  }

  async #click(command, tabID, target) {
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y))
      throw new Error('No browser click target. Reload the extension and call read_page again.');
    if (!this.chrome.debugger)
      throw new Error(
        'Browser-level clicks require the debugger permission. Reload the extension.',
      );
    if (this.clickingTabs.has(tabID)) throw new Error('Another click is in progress on this tab.');
    this.clickingTabs.add(tabID);
    const debuggee = { tabId: tabID };
    let lease;
    let pressAttempted = false;
    let completed = false;
    try {
      await this.#validateClick(command, tabID, target);
      const point = await this.#inputPoint(command, tabID, target);
      try {
        lease = await this.debuggers.acquire(command, tabID);
      } catch {
        this.assert(command);
        throw new Error(
          'Could not attach browser input. Close DevTools on this tab and check the extension debugger permission. No click was dispatched.',
        );
      }
      this.#assertClick(command, tabID, target);
      await this.chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...point,
        buttons: 0,
      });
      await this.#validateClick(command, tabID, target);
      const afterHover = await this.#inputPoint(command, tabID, target);
      if (afterHover.x !== point.x || afterHover.y !== point.y)
        throw new Error('Containing iframe moved before the click. Call read_page again.');
      pressAttempted = true;
      await this.chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      this.assert(command);
      await this.chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
      this.assert(command);
      completed = true;
      return {
        tabID,
        ...(target.frameID ? { frameID: target.frameID } : {}),
        dispatched: true,
        applicationAccepted: null,
      };
    } catch (error) {
      if (pressAttempted)
        throw new Error(
          `${error.message} Mouse input may already have affected the page; inspect it before retrying.`,
          { cause: error },
        );
      throw error;
    } finally {
      await this.debuggers.release(lease, { debounce: completed });
      this.clickingTabs.delete(tabID);
    }
  }

  async recordingInspect(command, tabID, checks) {
    this.assert(command);
    if (this.owner(tabID)?.[0] !== command.sessionID)
      throw new Error('Recording requires an owned tab.');
    const tab = await this.chrome.tabs.get(tabID);
    if (!/^https?:\/\//.test(tab.url || ''))
      throw new Error('Recording requires an HTTP/HTTPS page.');
    if (tab.status === 'loading') return { passed: false };
    await this.chrome.scripting.executeScript({ target: { tabId: tabID }, files: ['content.js'] });
    this.assert(command);
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: tabID },
      func: async (input) => {
        try {
          return await globalThis.__opencodeChrome.run('inspect_conditions', input);
        } catch (error) {
          return { opencodeError: error.message };
        }
      },
      args: [{ checks }],
    });
    this.assert(command);
    return { passed: pageResult(results[0]?.result)?.passed === true };
  }

  async recordingAction(command, tabID, action) {
    command.executingTabID = tabID;
    const { selector, ...args } = action;
    const nested = {
      ...command,
      recordingParent: command,
      tool: action.tool,
      args: { ...args, tabID },
    };
    delete nested.args.tool;
    if (selector) {
      const target = await this.#pageAction(
        { ...nested, tool: 'resolve_target', args: { selector, rejectPassword: true } },
        await this.chrome.tabs.get(tabID),
      );
      this.assert(command);
      if (!target?.ref || !target.documentID) throw new Error('Recorded selector did not resolve.');
      this.documents.set(tabID, target.documentID);
      nested.args.ref = target.ref;
    }
    // The parent recorded step already holds this session's execution lock.
    return this.execute(nested);
  }
}
