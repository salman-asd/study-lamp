import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createDriveTiming } from "./timing";

const originalTiming = process.env.DRIVE_TIMING;

after(() => {
  if (originalTiming === undefined) delete process.env.DRIVE_TIMING;
  else process.env.DRIVE_TIMING = originalTiming;
});

describe("createDriveTiming", () => {
  it("does not log timings unless DRIVE_TIMING=1", async () => {
    process.env.DRIVE_TIMING = "0";
    const originalInfo = console.info;
    let logCount = 0;
    console.info = () => { logCount++; };
    try {
      const timing = createDriveTiming("stream");
      assert.equal(await timing.measure("auth_ms", async () => "uid"), "uid");
      timing.log();
      assert.equal(logCount, 0);
    } finally {
      console.info = originalInfo;
    }
  });

  it("logs the route and measured stage durations when enabled", async () => {
    process.env.DRIVE_TIMING = "1";
    const originalInfo = console.info;
    let message = "";
    console.info = (value?: unknown) => { message = String(value); };
    try {
      const timing = createDriveTiming("stream");
      await timing.measure("auth_ms", async () => "uid");
      timing.log();
      assert.match(message, /^\[drive-timing\] stream \{"auth_ms":/);
    } finally {
      console.info = originalInfo;
    }
  });
});