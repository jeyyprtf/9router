import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDb = path.resolve(
  __dirname,
  "../../../sandbox-data/db/data.sqlite",
);

// Point DATA_DIR before importing app modules
process.env.DATA_DIR = path.resolve(__dirname, "../../../sandbox-data");

const GROK_EXHAUSTED =
  '{"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage for model grok-4.5-build-free for now."}';

// Integration test against a real sqlite file with real grok-cli connections.
// Only meaningful in the patch sandbox (DATA_DIR outside the repo), so skip
// entirely on a plain checkout instead of failing.
describe.skipIf(!fs.existsSync(sandboxDb))("markAccountUnavailable auto-disable (sandbox db)", () => {
  let markAccountUnavailable;
  let getProviderConnectionById;
  let updateProviderConnection;
  let targetId;
  let original;

  beforeAll(async () => {
    ({ markAccountUnavailable } = await import("../../src/sse/services/auth.js"));
    const db = await import("../../src/lib/localDb.js");
    ({ getProviderConnectionById, updateProviderConnection } = db);

    // Pick any grok-cli connection instead of a hardcoded id — the sandbox db is
    // re-copied from live by scripts/refresh-sandbox-db.sh and ids change.
    const all = await db.getProviderConnections();
    const target = (all || []).find((c) => c.provider === "grok-cli");
    if (!target) throw new Error("no grok-cli connection in sandbox db to test against");
    targetId = target.id;
    original = target;

    // Ensure target starts active for this test
    await updateProviderConnection(targetId, {
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      disabledAt: null,
      lastError: null,
      testStatus: "active",
    });
  });

  // The sandbox db is shared state — put the connection back as we found it
  afterAll(async () => {
    if (!targetId || !original) return;
    await updateProviderConnection(targetId, {
      isActive: original.isActive,
      autoDisabled: original.autoDisabled ?? false,
      disabledReason: original.disabledReason ?? null,
      disabledAt: original.disabledAt ?? null,
      lastError: original.lastError ?? null,
      testStatus: original.testStatus ?? null,
      backoffLevel: original.backoffLevel ?? 0,
    });
  });

  it("sets isActive=false and autoDisabled on free-usage-exhausted", async () => {
    const result = await markAccountUnavailable(
      targetId,
      429,
      GROK_EXHAUSTED,
      "grok-cli",
      "grok-4.5",
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.disabled).toBe(true);

    const after = await getProviderConnectionById(targetId);
    expect(after.isActive).toBe(false);
    expect(after.autoDisabled).toBe(true);
    expect(after.disabledReason).toBe("quota_exhausted");
    expect(String(after.lastError || "")).toMatch(/free-usage-exhausted|included free usage/i);
  });

  it("soft 429 does not disable connection permanently", async () => {
    // re-enable first
    await updateProviderConnection(targetId, {
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      disabledAt: null,
      lastError: null,
      testStatus: "active",
      backoffLevel: 0,
    });

    const result = await markAccountUnavailable(
      targetId,
      429,
      "too many requests, please slow down",
      "grok-cli",
      "grok-4.5",
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.disabled).toBeFalsy();

    const after = await getProviderConnectionById(targetId);
    expect(after.isActive).toBe(true);
    expect(after.autoDisabled).toBeFalsy();
    expect(after.testStatus).toBe("unavailable");
  });

  it("respects per-provider autoDisableOnQuotaExhausted=false", async () => {
    const { updateSettings, getSettings } = await import("../../src/lib/localDb.js");
    const before = await getSettings();
    const strategies = { ...(before.providerStrategies || {}) };
    strategies["grok-cli"] = {
      ...(strategies["grok-cli"] || {}),
      autoDisableOnQuotaExhausted: false,
    };
    await updateSettings({ providerStrategies: strategies });

    await updateProviderConnection(targetId, {
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      disabledAt: null,
      lastError: null,
      testStatus: "active",
      backoffLevel: 0,
    });

    const result = await markAccountUnavailable(
      targetId,
      429,
      GROK_EXHAUSTED,
      "grok-cli",
      "grok-4.5",
    );
    expect(result.shouldFallback).toBe(true);
    expect(result.disabled).toBe(false);

    const after = await getProviderConnectionById(targetId);
    expect(after.isActive).toBe(true);
    expect(after.autoDisabled).toBeFalsy();

    // restore ON for other tests / sandbox UX
    strategies["grok-cli"] = {
      ...(strategies["grok-cli"] || {}),
      autoDisableOnQuotaExhausted: true,
    };
    await updateSettings({ providerStrategies: strategies });
  });

  it("routing never selects an auto-disabled connection", async () => {
    // The whole point of the feature: kept in the DB, skipped by the router.
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const db = await import("../../src/lib/localDb.js");

    // Guarantee one healthy peer exists, so a null result can't make this vacuous
    const all = await db.getProviderConnections();
    const peer = (all || []).find((c) => c.provider === "grok-cli" && c.id !== targetId);
    if (!peer) throw new Error("need a second grok-cli connection to prove routing skips the disabled one");
    const clearedLocks = Object.fromEntries(
      Object.keys(peer).filter((k) => k.startsWith("modelLock_")).map((k) => [k, null]),
    );
    await updateProviderConnection(peer.id, {
      ...clearedLocks,
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      lastError: null,
      testStatus: "active",
      backoffLevel: 0,
    });

    await updateProviderConnection(targetId, {
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      disabledAt: null,
      lastError: null,
      testStatus: "active",
      backoffLevel: 0,
    });
    await markAccountUnavailable(targetId, 429, GROK_EXHAUSTED, "grok-cli", "grok-4.5");

    // Ask for credentials many times — the disabled account must never come back
    let served = 0;
    for (let i = 0; i < 25; i += 1) {
      const cred = await getProviderCredentials("grok-cli", null, "grok-4.5");
      const id = cred?.connectionId || cred?.id;
      if (id) {
        served += 1;
        expect(id).not.toBe(targetId);
      }
    }
    expect(served).toBeGreaterThan(0);

    // ...but it is still stored, not deleted
    expect(await getProviderConnectionById(targetId)).toBeTruthy();

    await updateProviderConnection(peer.id, {
      isActive: peer.isActive,
      testStatus: peer.testStatus ?? null,
      lastError: peer.lastError ?? null,
    });
  });

  it("manual enable clears lastError so UI force-sync will not re-disable", async () => {
    // Same regex the provider page uses for shouldForceAutoDisable
    const QUOTA_RE =
      /free-usage-exhausted|usage-exhausted|quota exhausted|included free usage|insufficient_quota/i;

    await updateProviderConnection(targetId, {
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      disabledAt: null,
      lastError: null,
      testStatus: "active",
      backoffLevel: 0,
    });

    await markAccountUnavailable(targetId, 429, GROK_EXHAUSTED, "grok-cli", "grok-4.5");
    const disabled = await getProviderConnectionById(targetId);
    expect(disabled.isActive).toBe(false);
    expect(QUOTA_RE.test(disabled.lastError || "")).toBe(true);

    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    const res = await PUT(
      new Request(`http://localhost/api/providers/${targetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      }),
      { params: Promise.resolve({ id: targetId }) },
    );
    expect(res.status).toBe(200);

    const after = await getProviderConnectionById(targetId);
    expect(after.isActive).toBe(true);
    expect(after.autoDisabled).toBe(false);
    expect(after.disabledReason).toBeNull();
    // The actual regression guard: force-sync must no longer match this connection
    expect(QUOTA_RE.test(after.lastError || "")).toBe(false);
  });

  it("manual enable does not wipe lastError for a normally-disabled connection", async () => {
    await updateProviderConnection(targetId, {
      isActive: false,
      autoDisabled: false,
      disabledReason: null,
      disabledAt: null,
      lastError: "upstream 500 boom",
      testStatus: "unavailable",
    });

    const { PUT } = await import("../../src/app/api/providers/[id]/route.js");
    await PUT(
      new Request(`http://localhost/api/providers/${targetId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      }),
      { params: Promise.resolve({ id: targetId }) },
    );

    const after = await getProviderConnectionById(targetId);
    expect(after.isActive).toBe(true);
    // Diagnostics for non-quota failures stay put
    expect(after.lastError).toBe("upstream 500 boom");
  });
});
