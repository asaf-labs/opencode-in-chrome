export function fakeChrome() {
  let nextID = 100,
    activeID = 1;
  const tabState = new Map([
    [
      1,
      {
        id: 1,
        windowId: 1,
        url: 'https://personal.example',
        title: 'Personal tab',
        status: 'complete',
      },
    ],
  ]);
  const scriptCalls = [],
    messages = [],
    saved = {};
  const groupState = new Map();
  const debuggerCalls = [];
  const debuggerTabs = new Set();
  const debuggerEvents = new Set(),
    debuggerDetach = new Set();
  let nextGroupID = 10;
  const get = async (id) => {
    if (!tabState.has(id)) throw new Error('No tab');
    return { ...tabState.get(id) };
  };
  return {
    tabState,
    groupState,
    scriptCalls,
    messages,
    saved,
    debuggerCalls,
    debuggerTabs,
    emitDebugger: (tabID, method, params, sessionId) => {
      for (const listener of debuggerEvents) listener({ tabId: tabID, sessionId }, method, params);
    },
    detachDebugger: (tabID) => {
      debuggerTabs.delete(tabID);
      for (const listener of debuggerDetach) listener({ tabId: tabID }, 'target_closed');
    },
    debugger: {
      onEvent: {
        addListener: (listener) => debuggerEvents.add(listener),
        removeListener: (listener) => debuggerEvents.delete(listener),
      },
      onDetach: {
        addListener: (listener) => debuggerDetach.add(listener),
        removeListener: (listener) => debuggerDetach.delete(listener),
      },
      attach: async (target, version) => {
        debuggerCalls.push({ action: 'attach', target, version });
        if (debuggerTabs.has(target.tabId)) throw new Error('Already attached');
        debuggerTabs.add(target.tabId);
      },
      sendCommand: async (target, method, params) => {
        if (!debuggerTabs.has(target.tabId)) throw new Error('Not attached');
        debuggerCalls.push({ action: 'send', target, method, params });
        if (method === 'Page.captureScreenshot') return { data: 'aW1hZ2U=' };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        if (method === 'Profiler.stop')
          return {
            profile: {
              nodes: [
                {
                  id: 1,
                  callFrame: {
                    functionName: 'work',
                    scriptId: '1',
                    url: 'https://example.com/?token=private',
                    lineNumber: 1,
                    columnNumber: 0,
                  },
                  children: [],
                },
              ],
              startTime: 0,
              endTime: 1000000,
              samples: [1],
              timeDeltas: [1000],
            },
          };
      },
      detach: async (target) => {
        debuggerCalls.push({ action: 'detach', target });
        debuggerTabs.delete(target.tabId);
      },
    },
    tabs: {
      get,
      create: async ({ url }) => {
        const tab = { id: nextID++, windowId: 1, url, title: 'Agent page', status: 'complete' };
        tabState.set(tab.id, tab);
        activeID = tab.id;
        return { ...tab };
      },
      update: async (id, changes) => {
        const tab = await get(id);
        Object.assign(tab, changes);
        tabState.set(id, tab);
        if (changes.active) activeID = id;
        return tab;
      },
      remove: async (id) => {
        await get(id);
        tabState.delete(id);
      },
      group: async ({ tabIds, groupId }) => {
        const tabs = await Promise.all(tabIds.map(get));
        const id = groupId ?? nextGroupID++;
        groupState.set(id, { ...(groupState.get(id) || {}), id, windowId: tabs[0].windowId });
        for (const tab of tabs) tabState.get(tab.id).groupId = id;
        return id;
      },
      query: async (query = {}) => {
        if (query.groupId !== undefined)
          return [...tabState.values()]
            .filter((tab) => tab.groupId === query.groupId)
            .map((tab) => ({ ...tab, active: tab.id === activeID }));
        return [await get(activeID)];
      },
      captureVisibleTab: async () => 'data:image/png;base64,aW1hZ2U=',
      sendMessage: async (tabID, message) => {
        messages.push({ tabID, message });
        return { ok: true };
      },
    },
    windows: { update: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabGroups: {
      get: async (id) => {
        if (!groupState.has(id)) throw new Error('No group');
        return { ...groupState.get(id) };
      },
      update: async (id, changes) => {
        Object.assign(groupState.get(id), changes);
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: structuredClone(saved[key]) }),
        set: async (value) => {
          Object.assign(saved, structuredClone(value));
        },
      },
      session: {
        set: async (value) => {
          Object.assign(saved, structuredClone(value));
        },
      },
    },
    offscreen: { createDocument: async () => {} },
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: async ({ segments = [] }) => ({
        video: 'GkXfow==',
        timeline: segments.map((_segment, index) => ({
          startMs: index * 1000,
          endMs: (index + 1) * 1000,
        })),
      }),
    },
    scripting: {
      executeScript: async (request) => {
        scriptCalls.push(request);
        if (request.files) return [];
        const tab = await get(request.target.tabId);
        if (request.args?.[0] === 'resolve_target')
          return [{ result: { ref: 'e1', documentID: `doc-${tab.id}` } }];
        if (request.args?.[0] === 'start') return [{ result: { supported: ['mark', 'measure'] } }];
        if (request.args?.[0] === 'stop')
          return [
            {
              result: {
                events: [{ type: 'mark', name: 'ready', startTime: 10, duration: 0 }],
                dropped: 0,
                timeOrigin: 100000,
                supported: ['mark'],
              },
            },
          ];
        if (request.args?.[0]?.checks) return [{ result: { passed: true } }];
        if (request.args?.[0]?.selector)
          return [{ result: { ref: 'e1', documentID: `doc-${tab.id}` } }];
        if (request.args?.[0] === 'click')
          return [
            {
              result: {
                clickTarget: {
                  x: 50,
                  y: 10,
                  documentID: `doc-${tab.id}`,
                  snapshotRevision: 1,
                  controlRevision: 0,
                },
              },
            },
          ];
        if (request.args?.[0]?.snapshotRevision !== undefined) return [{ result: { valid: true } }];
        return [{ result: { title: tab.title, documentID: `doc-${tab.id}`, ok: true } }];
      },
    },
  };
}
