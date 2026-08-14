import { getSettings, getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { buildClearModelLocksUpdate } from "open-sse/services/accountFallback.js";
import { AUTO_ENABLE_CONFIG, getAutoEnableConfig } from "@/shared/constants/autoEnable.js";

// Keep one scheduler across Next.js hot reloads and duplicate module imports.
const g = (global.__quotaAutoEnable ??= {
  interval: null,
  running: false,
});

function parseTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getScheduledAutoEnableAt(connection, delayMinutes) {
  const storedAt = parseTimestamp(connection.autoEnableAt);
  if (storedAt !== null) return storedAt;

  const disabledAt = parseTimestamp(connection.disabledAt || connection.lastErrorAt);
  return disabledAt === null ? null : disabledAt + delayMinutes * 60 * 1000;
}

function isQuotaAutoDisabled(connection) {
  return connection?.isActive === false
    && connection.autoDisabled === true
    && connection.disabledReason === "quota_exhausted";
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    getProviderConnectionById,
    updateProviderConnection,
  };
}

/**
 * Re-enable connections whose hard-quota cooldown has elapsed.
 * The scheduler never touches manually disabled or unrelated-error connections.
 */
export async function runQuotaAutoEnableTick(deps = createDefaultDeps(), state = g, nowMs = Date.now()) {
  if (state.running) return 0;
  state.running = true;

  let enabledCount = 0;
  try {
    const settings = await deps.getSettings();
    const connections = await deps.getProviderConnections();

    for (const connection of connections || []) {
      if (!isQuotaAutoDisabled(connection)) continue;

      const config = getAutoEnableConfig(settings, connection.provider);
      if (!config.enabled) continue;

      const scheduledAt = getScheduledAutoEnableAt(connection, config.delayMinutes);
      if (scheduledAt === null || scheduledAt > nowMs) continue;

      // Re-read before mutating so a manual change made during the scan wins.
      const latest = deps.getProviderConnectionById
        ? await deps.getProviderConnectionById(connection.id)
        : connection;
      if (!isQuotaAutoDisabled(latest)) continue;

      await deps.updateProviderConnection(latest.id, {
        ...buildClearModelLocksUpdate(latest),
        isActive: true,
        autoDisabled: false,
        disabledReason: null,
        disabledAt: null,
        autoEnableAt: null,
        testStatus: "active",
        lastError: null,
        lastErrorAt: null,
        errorCode: null,
        backoffLevel: 0,
      });
      enabledCount += 1;
      console.log(`[AutoEnable] ${latest.provider}:${latest.id} re-enabled after quota cooldown`);
    }
  } catch (error) {
    console.warn("[AutoEnable] tick error:", error.message);
  } finally {
    state.running = false;
  }

  return enabledCount;
}

export function hasQuotaAutoEnableEnabled(settings) {
  if (settings?.autoEnableOnQuotaExhausted === true) return true;
  return Object.values(settings?.providerStrategies || {}).some(
    (strategy) => strategy?.autoEnableOnQuotaExhausted === true,
  );
}

export function startQuotaAutoEnable() {
  if (g.interval) return;
  console.log("[AutoEnable] scheduler started");
  runQuotaAutoEnableTick().catch(() => {});
  g.interval = setInterval(() => {
    runQuotaAutoEnableTick().catch(() => {});
  }, AUTO_ENABLE_CONFIG.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaAutoEnable() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[AutoEnable] scheduler stopped");
}

export function configureQuotaAutoEnable(settings) {
  if (hasQuotaAutoEnableEnabled(settings)) startQuotaAutoEnable();
  else stopQuotaAutoEnable();
}

