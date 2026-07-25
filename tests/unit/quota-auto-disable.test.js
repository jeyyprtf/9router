import { describe, it, expect } from "vitest";
import {
  checkFallbackError,
  isQuotaExhaustedError,
  normalizeErrorText,
} from "../../open-sse/services/accountFallback.js";
import {
  QUOTA_EXHAUSTED_MARKERS,
  isQuotaExhaustedText,
} from "../../open-sse/config/errorConfig.js";

const GROK_EXHAUSTED =
  '{"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage for model grok-4.5-build-free for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 1110635/1000000."}';

describe("quota auto-disable detection", () => {
  it("normalizes object errors", () => {
    expect(normalizeErrorText({ code: "subscription:free-usage-exhausted" })).toContain(
      "free-usage-exhausted",
    );
  });

  it("detects grok free-usage-exhausted body", () => {
    expect(isQuotaExhaustedError(429, GROK_EXHAUSTED)).toBe(true);
  });

  it("does not treat soft rate-limit 429 as hard quota", () => {
    expect(isQuotaExhaustedError(429, "Rate limit exceeded. Try again later.")).toBe(false);
  });

  it("checkFallbackError disables connection on free-usage-exhausted", () => {
    const result = checkFallbackError(429, GROK_EXHAUSTED, 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.disableConnection).toBe(true);
  });

  it("checkFallbackError keeps soft 429 as backoff only", () => {
    const result = checkFallbackError(429, "too many requests", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.disableConnection).toBeFalsy();
    expect(result.newBackoffLevel).toBeGreaterThan(0);
  });

  it("detects insufficient_quota marker", () => {
    const result = checkFallbackError(403, "error: insufficient_quota", 0);
    expect(result.disableConnection).toBe(true);
  });
});

describe("quota markers are a single source of truth", () => {
  // The dashboard, the providers API and the routing engine all classify through
  // isQuotaExhaustedText. If a marker stops producing disableConnection, the UI
  // and the backend disagree and accounts ping-pong between enabled and disabled.
  it.each(QUOTA_EXHAUSTED_MARKERS)("marker %s disables the connection", (marker) => {
    expect(isQuotaExhaustedText(`upstream said: ${marker.toUpperCase()} — retry later`)).toBe(true);
    expect(checkFallbackError(429, `upstream said: ${marker}`, 0).disableConnection).toBe(true);
  });

  it("matches both Grok phrasings of the free-usage message", () => {
    expect(isQuotaExhaustedText("You've used all the included free usage for model grok-4.5")).toBe(true);
    expect(isQuotaExhaustedText("used all the included free usage for now")).toBe(true);
  });

  it("ignores soft rate-limit wording", () => {
    for (const soft of ["rate limit", "too many requests", "quota exceeded", "overloaded", ""]) {
      expect(isQuotaExhaustedText(soft)).toBe(false);
    }
  });

  it("handles non-string payloads without throwing", () => {
    expect(isQuotaExhaustedText(null)).toBe(false);
    expect(isQuotaExhaustedText(undefined)).toBe(false);
    expect(isQuotaExhaustedText({ code: "insufficient_quota" })).toBe(true);
    const circular = {}; circular.self = circular;
    expect(() => isQuotaExhaustedText(circular)).not.toThrow();
  });
});
