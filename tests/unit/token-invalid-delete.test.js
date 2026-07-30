import { describe, it, expect } from "vitest";
import {
  TOKEN_INVALID_MARKERS,
  isTokenInvalidText,
  isQuotaExhaustedText,
} from "../../open-sse/config/errorConfig.js";

describe("token invalid detection (bulk delete candidates)", () => {
  it.each(TOKEN_INVALID_MARKERS)("marker %s matches", (marker) => {
    expect(isTokenInvalidText(`upstream: ${marker.toUpperCase()} — re-auth`)).toBe(true);
  });

  it("detects codex invalidated token body", () => {
    const body =
      '[401]: {\n  "error": {\n    "message": "Your authentication token has been invalidated. Please try signing in again."\n  }\n}';
    expect(isTokenInvalidText(body, 401)).toBe(true);
  });

  it("detects plain invalid token 401", () => {
    expect(
      isTokenInvalidText(
        '[401]: {"error":{"code":"","message":"invalid token [trace: abc]"}}',
        401,
      ),
    ).toBe(true);
  });

  it("detects key expired", () => {
    expect(isTokenInvalidText('[401]: {"error":"Key expired."}', 401)).toBe(true);
  });

  it("detects probe wording Token invalid or revoked", () => {
    expect(isTokenInvalidText("Token invalid or revoked")).toBe(true);
  });

  it("matches bare errorCode 401", () => {
    expect(isTokenInvalidText("", 401)).toBe(true);
    expect(isTokenInvalidText(null, 401)).toBe(true);
  });

  it("does not match soft / non-auth failures", () => {
    for (const soft of [
      "rate limit exceeded",
      "too many requests",
      "service temporarily unavailable",
      "model not found",
      "",
      null,
    ]) {
      expect(isTokenInvalidText(soft)).toBe(false);
      expect(isTokenInvalidText(soft, 429)).toBe(false);
      expect(isTokenInvalidText(soft, 503)).toBe(false);
    }
  });

  it("does not treat hard quota as token-invalid", () => {
    const quota =
      '{"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage"}';
    expect(isQuotaExhaustedText(quota)).toBe(true);
    expect(isTokenInvalidText(quota, 429)).toBe(false);
  });

  it("403 model-access denials are not token-invalid without markers", () => {
    expect(
      isTokenInvalidText(
        '[403]: {"error":{"message":"Claude Fable 5 is available on Elite and Enterprise only."}}',
        403,
      ),
    ).toBe(false);
  });

  it("handles non-string payloads", () => {
    expect(isTokenInvalidText({ message: "token invalid or revoked" })).toBe(true);
    expect(isTokenInvalidText({ code: "invalid_grant" })).toBe(true);
    const circular = {};
    circular.self = circular;
    expect(() => isTokenInvalidText(circular)).not.toThrow();
  });
});
