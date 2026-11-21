// Virtual clock for offline watcher CLI tests. Preloaded via `node --import`
// so production watcher scripts need no test-only flags or seams while still
// enforcing the real 30-second minimum polling interval.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

let offset = 0;
const origPerfNow = performance.now.bind(performance);
const origDateNow = Date.now.bind(Date);
const logPath = process.env.WATCH_PR_SLEEP_LOG;

performance.now = () => origPerfNow() + offset;
Date.now = () => origDateNow() + offset;

globalThis.__watchPrVirtualSleep = (ms) => {
  const delta = Math.max(0, Number(ms) || 0);
  offset += delta;
  if (logPath) appendFileSync(logPath, `${delta}\n`);
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:timers/promises") {
      return {
        url: "data:text/javascript,export async function setTimeout(ms, value) { globalThis.__watchPrVirtualSleep(ms); return value; }",
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
