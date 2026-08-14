import { describe, expect, it, vi } from "vitest";
import {
  getAutoEnableConfig,
  normalizeAutoEnableDelayMinutes,
} from "../../src/shared/constants/autoEnable.js";
import { runQuotaAutoEnableTick } from "../../src/shared/services/quotaAutoEnable.js";

function makeConnection(overrides = {}) {
  return {
    id: "conn-1",
    provider: "grok-cli",
    isActive: false,
    autoDisabled: true,
    disabledReason: "quota_exhausted",
    disabledAt: "2026-08-04T00:00:00.000Z",
    autoEnableAt: "2026-08-04T01:00:00.000Z",
    testStatus: "unavailable",
    lastError: "subscription:free-usage-exhausted",
    lastErrorAt: "2026-08-04T00:00:00.000Z",
    errorCode: 429,
    backoffLevel: 4,
    modelLock_grok: "2026-08-04T00:02:00.000Z",
    ...overrides,
  };
}

function makeDeps(connection, latest = connection) {
  return {
    getSettings: async () => ({
      autoEnableOnQuotaExhausted: false,
      autoEnableAfterMinutes: 60,
      providerStrategies: {
        "grok-cli": { autoEnableOnQuotaExhausted: true },
      },
    }),
    getProviderConnections: async () => [connection],
    getProviderConnectionById: async () => latest,
    updateProviderConnection: vi.fn(async (...args) => args),
  };
}

describe("quota auto-enable config", () => {
  it("defaults to 24 hours and remains off unless explicitly enabled", () => {
    expect(normalizeAutoEnableDelayMinutes(undefined)).toBe(1440);
    expect(getAutoEnableConfig({}).enabled).toBe(false);
    expect(getAutoEnableConfig({ autoEnableOnQuotaExhausted: true }).enabled).toBe(true);
  });

  it("lets a provider override the global setting and delay", () => {
    const config = getAutoEnableConfig({
      autoEnableOnQuotaExhausted: false,
      autoEnableAfterMinutes: 1440,
      providerStrategies: {
        grok: {
          autoEnableOnQuotaExhausted: true,
          autoEnableAfterMinutes: 90,
        },
      },
    }, "grok");
    expect(config).toEqual({ enabled: true, delayMinutes: 90 });
  });
});

describe("quota auto-enable scheduler", () => {
  it("re-enables a due quota-disabled connection and clears its error state", async () => {
    const deps = makeDeps(makeConnection());
    const count = await runQuotaAutoEnableTick(
      deps,
      { running: false },
      Date.parse("2026-08-04T01:00:00.000Z"),
    );

    expect(count).toBe(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      isActive: true,
      autoDisabled: false,
      disabledReason: null,
      autoEnableAt: null,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      backoffLevel: 0,
      modelLock_grok: null,
    }));
  });

  it("does not enable before the stored deadline", async () => {
    const deps = makeDeps(makeConnection());
    const count = await runQuotaAutoEnableTick(
      deps,
      { running: false },
      Date.parse("2026-08-04T00:59:59.000Z"),
    );

    expect(count).toBe(0);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("uses disabledAt for older connections without autoEnableAt", async () => {
    const deps = makeDeps(makeConnection({ autoEnableAt: undefined }));
    const count = await runQuotaAutoEnableTick(
      deps,
      { running: false },
      Date.parse("2026-08-04T01:00:00.000Z"),
    );

    expect(count).toBe(1);
  });

  it("does not touch manually disabled or non-quota connections", async () => {
    const manual = makeConnection({ autoDisabled: false, disabledReason: null });
    const deps = makeDeps(manual);
    expect(await runQuotaAutoEnableTick(deps, { running: false }, Date.now())).toBe(0);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();

    const unrelated = makeConnection({ disabledReason: "token_invalid" });
    const unrelatedDeps = makeDeps(unrelated);
    expect(await runQuotaAutoEnableTick(unrelatedDeps, { running: false }, Date.now())).toBe(0);
    expect(unrelatedDeps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("honors the setting being turned off", async () => {
    const connection = makeConnection();
    const deps = {
      ...makeDeps(connection),
      getSettings: async () => ({ autoEnableOnQuotaExhausted: false, providerStrategies: {} }),
    };
    expect(await runQuotaAutoEnableTick(deps, { running: false }, Date.now() + 3600000)).toBe(0);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("rechecks the connection before enabling it", async () => {
    const stale = makeConnection();
    const latest = makeConnection({ isActive: true, autoDisabled: false, disabledReason: null });
    const deps = makeDeps(stale, latest);
    expect(await runQuotaAutoEnableTick(deps, { running: false }, Date.now() + 3600000)).toBe(0);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });
});
