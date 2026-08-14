export const AUTO_ENABLE_CONFIG = {
  defaultDelayMinutes: 24 * 60,
  minDelayMinutes: 1,
  tickIntervalMs: 60 * 1000,
};

export function normalizeAutoEnableDelayMinutes(value, fallback = AUTO_ENABLE_CONFIG.defaultDelayMinutes) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(AUTO_ENABLE_CONFIG.minDelayMinutes, Math.round(parsed));
}

export function getAutoEnableConfig(settings, providerId) {
  const override = providerId
    ? (settings?.providerStrategies || {})[providerId] || {}
    : {};
  const enabled = override.autoEnableOnQuotaExhausted === true
    ? true
    : override.autoEnableOnQuotaExhausted === false
      ? false
      : settings?.autoEnableOnQuotaExhausted === true;
  const delayMinutes = normalizeAutoEnableDelayMinutes(
    override.autoEnableAfterMinutes ?? settings?.autoEnableAfterMinutes,
  );

  return { enabled, delayMinutes };
}

