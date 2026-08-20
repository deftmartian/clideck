const enabled = new URLSearchParams(location.search).get('clideckPerf') === '1';
const startedAt = performance.now();
const counters = Object.create(null);
const timings = Object.create(null);
const events = [];

function addCounter(name, amount = 1) {
  counters[name] = (counters[name] || 0) + amount;
}

export function notePerf(name, detail = {}) {
  if (!enabled) return;
  addCounter(name);
  const event = { name, at: performance.now(), ...detail };
  events.push(event);
  if (events.length > 200) events.shift();
}

export function countPerf(name, amount = 1) {
  if (!enabled) return;
  addCounter(name, amount);
}

export function maxPerf(name, value) {
  if (!enabled || !Number.isFinite(Number(value))) return;
  counters[name] = Math.max(counters[name] || 0, Number(value));
}

export function timePerf(name, started) {
  if (!enabled) return;
  timings[name] = Math.max(0, performance.now() - Number(started || 0));
}

export function perfEnabled() {
  return enabled;
}

if (enabled) {
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        addCounter('longTasks');
        addCounter('longTaskDurationMs', entry.duration);
        maxPerf('maximumLongTaskMs', entry.duration);
        notePerf('browserLongTask', { startedAt: entry.startTime, durationMs: entry.duration });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {}

  Object.defineProperty(window, '__clideckPerfSnapshot', {
    configurable: true,
    value() {
      const measuredAt = performance.now();
      const resources = performance.getEntriesByType('resource');
      const terminalUsableAt = events.find(item => item.name === 'terminalCurrentPainted')?.at;
      const criticalResources = Number.isFinite(terminalUsableAt)
        ? resources.filter(item => item.responseEnd <= terminalUsableAt)
        : [];
      const criticalNetworkResources = criticalResources.filter(item => item.transferSize > 0);
      return {
        enabled: true,
        measuredAt,
        elapsedMs: measuredAt - startedAt,
        counters: { ...counters },
        renderers: {
          current: document.querySelectorAll('.term-wrap').length,
          webgl: document.querySelectorAll('.term-wrap[data-renderer="webgl"]').length,
          evictions: counters.rendererEvictions || 0,
          snapshotRehydrations: counters.snapshotRehydrations || 0,
        },
        timings: { ...timings },
        resources: {
          count: resources.length,
          transferBytes: resources.reduce((total, item) => total + (item.transferSize || 0), 0),
          encodedBytes: resources.reduce((total, item) => total + (item.encodedBodySize || 0), 0),
          decodedBytes: resources.reduce((total, item) => total + (item.decodedBodySize || 0), 0),
        },
        criticalResources: {
          count: criticalResources.length,
          networkCount: criticalNetworkResources.length,
          transferBytes: criticalResources.reduce((total, item) => total + (item.transferSize || 0), 0),
          encodedBytes: criticalResources.reduce((total, item) => total + (item.encodedBodySize || 0), 0),
          networkEncodedBytes: criticalNetworkResources.reduce(
            (total, item) => total + (item.encodedBodySize || 0), 0,
          ),
          decodedBytes: criticalResources.reduce((total, item) => total + (item.decodedBodySize || 0), 0),
          terminalUsableAt,
          items: criticalResources.map(item => ({
            name: item.name,
            encodedBytes: item.encodedBodySize || 0,
            transferBytes: item.transferSize || 0,
            responseEnd: item.responseEnd,
          })),
        },
        events: events.map(item => ({ ...item })),
      };
    },
  });
}
