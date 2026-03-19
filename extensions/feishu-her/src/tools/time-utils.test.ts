import { describe, expect, test } from "vitest";
import {
  parseTime,
  toUnixSeconds,
  toUnixSecondsStr,
  toUnixMsStr,
  toRfc3339,
} from "./time-utils.js";

describe("parseTime", () => {
  test("ISO 8601 with timezone", () => {
    // 2026-03-19T00:00:00+08:00 = 2026-03-18T16:00:00Z
    const ms = parseTime("2026-03-19T00:00:00+08:00");
    expect(ms).toBe(Date.parse("2026-03-18T16:00:00Z"));
  });

  test("ISO 8601 UTC", () => {
    const ms = parseTime("2026-03-19T00:00:00Z");
    expect(ms).toBe(Date.parse("2026-03-19T00:00:00Z"));
  });

  test("ISO 8601 date only", () => {
    const ms = parseTime("2026-03-19");
    expect(ms).toBe(Date.parse("2026-03-19"));
  });

  test("Unix seconds as number", () => {
    // 1773849600 = 2026-03-16T16:00:00Z
    const ms = parseTime(1773849600);
    expect(ms).toBe(1773849600 * 1000);
  });

  test("Unix milliseconds as number", () => {
    const ms = parseTime(1773849600000);
    expect(ms).toBe(1773849600000);
  });

  test("Unix seconds as string", () => {
    const ms = parseTime("1773849600");
    expect(ms).toBe(1773849600 * 1000);
  });

  test("Unix milliseconds as string", () => {
    const ms = parseTime("1773849600000");
    expect(ms).toBe(1773849600000);
  });

  test("undefined returns fallback", () => {
    const ms = parseTime(undefined, 12345);
    expect(ms).toBe(12345);
  });

  test("undefined without fallback returns Date.now()", () => {
    const before = Date.now();
    const ms = parseTime(undefined);
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  test("garbage string returns fallback", () => {
    const ms = parseTime("not-a-date", 99999);
    expect(ms).toBe(99999);
  });

  test("very small number returns fallback", () => {
    const ms = parseTime(123, 99999);
    expect(ms).toBe(99999);
  });
});

describe("toUnixSeconds", () => {
  test("ISO 8601 to seconds", () => {
    const s = toUnixSeconds("2026-03-19T00:00:00+08:00");
    expect(s).toBe(Math.floor(Date.parse("2026-03-18T16:00:00Z") / 1000));
  });

  test("number passthrough", () => {
    expect(toUnixSeconds(1773849600)).toBe(1773849600);
  });
});

describe("toUnixSecondsStr", () => {
  test("returns string", () => {
    const s = toUnixSecondsStr("2026-03-19T00:00:00+08:00");
    expect(typeof s).toBe("string");
    expect(Number(s)).toBe(Math.floor(Date.parse("2026-03-18T16:00:00Z") / 1000));
  });
});

describe("toUnixMsStr", () => {
  test("ISO to ms string", () => {
    const s = toUnixMsStr("2026-03-19T00:00:00+08:00");
    expect(typeof s).toBe("string");
    expect(Number(s)).toBe(Date.parse("2026-03-18T16:00:00Z"));
  });
});

describe("toRfc3339", () => {
  test("ISO 8601 to RFC 3339", () => {
    const s = toRfc3339("2026-03-19T00:00:00+08:00");
    expect(s).toBe("2026-03-18T16:00:00.000Z");
  });

  test("Unix seconds to RFC 3339", () => {
    const s = toRfc3339(1773849600);
    expect(s).toBe(new Date(1773849600 * 1000).toISOString());
  });
});
