import { describe, expect, test } from "vitest";
import {
  canonicalStringify,
  compareScalar,
  normalizeIndexSlots,
  normalizeNumber,
  requestHash,
  secureRequestHash,
  type Scalar,
} from "./normalization.js";

describe("normalization", () => {
  test("missing and null collapse to the same index slot", () => {
    expect(normalizeIndexSlots(["field"], {})).toEqual([null, null, null]);
    expect(normalizeIndexSlots(["field"], { field: null })).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("canonicalizes negative zero and rejects non-finite numbers", () => {
    expect(Object.is(normalizeNumber(-0), 0)).toBe(true);
    expect(() => normalizeNumber(Number.NaN)).toThrow("finite");
    expect(() => normalizeNumber(Number.POSITIVE_INFINITY)).toThrow("finite");
  });

  test("uses the observed Convex scalar ordering", () => {
    const values: Scalar[] = [null, -10, 0, 10, false, true, "", "A", "a"];
    for (let left = 0; left < values.length; left += 1) {
      for (let right = 0; right < values.length; right += 1) {
        expect(Math.sign(compareScalar(values[left]!, values[right]!))).toBe(
          Math.sign(left - right),
        );
      }
    }
  });

  test("hashes equivalent objects independently of key insertion order", () => {
    const first = { b: [2, 3], a: { y: true, x: -0 } };
    const second = { a: { x: 0, y: true }, b: [2, 3] };
    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
    expect(requestHash(first)).toBe(requestHash(second));
  });

  test("uses SHA-256 for idempotency request hashes", async () => {
    const digest = await secureRequestHash({ value: "stable" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await secureRequestHash({ value: "stable" }));
  });
});
