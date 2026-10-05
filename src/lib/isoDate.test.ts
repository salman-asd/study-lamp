import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addDaysToIsoDate, isValidIsoDate, isoDatePart } from "./isoDate";

describe("isoDate helpers", () => {
  it("validates real dates and rejects impossible calendar dates", () => {
    assert.equal(isValidIsoDate("2026-02-28"), true);
    assert.equal(isValidIsoDate("2026-02-30"), false);
    assert.equal(isValidIsoDate("2027-12-31"), true);
    assert.equal(isValidIsoDate("2027-13-01"), false);
  });

  it("adds whole days in UTC without shifting the calendar date", () => {
    assert.equal(addDaysToIsoDate("2026-02-28", 1), "2026-03-01");
    assert.equal(addDaysToIsoDate("2026-12-31", 1), "2027-01-01");
  });

  it("extracts the ISO date portion from RFC3339 values and ignores invalid strings", () => {
    assert.equal(isoDatePart("2026-02-28T18:00:00Z"), "2026-02-28");
    assert.equal(isoDatePart("not-a-date"), null);
    assert.equal(isoDatePart("2026-99-99T00:00:00Z"), null);
  });
});
