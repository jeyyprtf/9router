// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
/**
 * Hard quota / free-usage exhaustion markers.
 * These should disable the connection (isActive=false), not only short cooldown.
 * Matched case-insensitively against error body/message.
 *
 * SINGLE SOURCE OF TRUTH. The routing engine, the providers API and the dashboard
 * all classify "quota exhausted" through isQuotaExhaustedText() below. Do not
 * re-inline this list or a regex copy of it anywhere — a client-side definition
 * that drifts from this one makes the UI disable accounts the API just enabled.
 */
export const QUOTA_EXHAUSTED_MARKERS = [
  "free-usage-exhausted",
  "usage-exhausted",
  "quota exhausted",
  "quota_exhausted",
  "insufficient_quota",
  "included free usage",
  "usage resets over a rolling",
];

/**
 * Normalize an error payload (string, object, or nullish) to a lowercase string.
 * @param {unknown} errorText
 * @returns {string}
 */
export function normalizeErrorText(errorText) {
  if (!errorText) return "";
  if (typeof errorText === "string") return errorText.toLowerCase();
  try {
    return JSON.stringify(errorText).toLowerCase();
  } catch {
    return String(errorText).toLowerCase();
  }
}

/**
 * True when the error body indicates hard quota / free-usage exhaustion.
 * Soft 429 rate limits must NOT match — they only get a short cooldown.
 * @param {unknown} errorText
 * @returns {boolean}
 */
export function isQuotaExhaustedText(errorText) {
  const lower = normalizeErrorText(errorText);
  if (!lower) return false;
  return QUOTA_EXHAUSTED_MARKERS.some((m) => lower.includes(m));
}

export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  // Hard quota before generic rate-limit backoff. Derived from the marker list so
  // the rules and isQuotaExhaustedText() can never disagree.
  ...QUOTA_EXHAUSTED_MARKERS.map((text) => ({
    text,
    disableConnection: true,
    cooldownMs: COOLDOWN.long,
  })),
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
