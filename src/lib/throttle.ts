/**
 * Leading + trailing throttle that always delivers the LATEST value:
 * the first call runs immediately, calls inside the interval are collapsed
 * into one trailing call. `flush()` delivers a pending value right away.
 * Timer and clock are injectable for tests.
 */
export interface Throttled<T> {
  call: (value: T) => void;
  flush: () => void;
  cancel: () => void;
}

export function createThrottle<T>(
  fn: (value: T) => void,
  intervalMs: number,
  deps: {
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Throttled<T> {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let lastRun = -Infinity;
  let timer: unknown = null;
  let pending: { value: T } | null = null;

  function run(value: T) {
    lastRun = now();
    fn(value);
  }

  function runPending() {
    timer = null;
    if (pending) {
      const { value } = pending;
      pending = null;
      run(value);
    }
  }

  return {
    call(value) {
      const remaining = intervalMs - (now() - lastRun);
      if (remaining <= 0 && timer === null) {
        run(value);
        return;
      }
      pending = { value };
      if (timer === null) timer = setTimer(runPending, Math.max(0, remaining));
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      runPending();
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}
