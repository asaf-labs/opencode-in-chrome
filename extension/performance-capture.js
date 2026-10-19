(() => {
  if (globalThis.__opencodePerformance) return;
  let active;
  const supported = [
    'mark',
    'measure',
    'longtask',
    'navigation',
    'paint',
    'layout-shift',
    'resource',
  ];
  function add(entry) {
    if (!active || active.events.length >= 1000) {
      if (active) active.dropped++;
      return;
    }
    if (entry.startTime < active.started) return;
    active.events.push({
      type: entry.entryType,
      name: entry.name.slice(0, 1000),
      startTime: entry.startTime,
      duration: entry.duration,
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
      transferSize: entry.transferSize,
    });
  }
  function stop(id, discard = false) {
    if (!active || active.id !== id)
      throw new Error('Performance capture is unavailable in this document.');
    for (const entry of active.observer.takeRecords()) add(entry);
    active.observer.disconnect();
    clearTimeout(active.timer);
    if (discard) {
      active = null;
      return;
    }
    active.stopped = true;
    return {
      events: active.events,
      dropped: active.dropped,
      timeOrigin: performance.timeOrigin,
      supported: active.supported,
    };
  }
  globalThis.__opencodePerformance = {
    start(id, durationMs) {
      if (active) {
        active.observer.disconnect();
        clearTimeout(active.timer);
      }
      const eventTypes = supported.filter((type) =>
        PerformanceObserver.supportedEntryTypes.includes(type),
      );
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) add(entry);
      });
      active = {
        id,
        started: performance.now(),
        events: [],
        dropped: 0,
        observer,
        supported: eventTypes,
      };
      if (eventTypes.length) observer.observe({ entryTypes: eventTypes });
      active.timer = setTimeout(() => stop(id), durationMs);
      return { supported: eventTypes };
    },
    stop,
    clear() {
      if (active) stop(active.id, true);
    },
  };
})();
