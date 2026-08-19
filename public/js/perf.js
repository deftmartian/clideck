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
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {}

  Object.defineProperty(window, '__clideckPerfSnapshot', {
    configurable: true,
    value() {
      const resources = performance.getEntriesByType('resource');
      return {
        enabled: true,
        elapsedMs: performance.now() - startedAt,
        counters: { ...counters },
        timings: { ...timings },
        resources: {
          count: resources.length,
          transferBytes: resources.reduce((total, item) => total + (item.transferSize || 0), 0),
          encodedBytes: resources.reduce((total, item) => total + (item.encodedBodySize || 0), 0),
          decodedBytes: resources.reduce((total, item) => total + (item.decodedBodySize || 0), 0),
        },
        events: events.map(item => ({ ...item })),
      };
    },
  });
}
