export const MANAGED_PARAM_KEYS = [
  "feeMultiplier",
  "tpReservePct",
  "trailingTpPct",
  "gridSizeMultiplier",
  "initialSharePct",
] as const;

export type ManagedParamKey = (typeof MANAGED_PARAM_KEYS)[number];

export const MANAGED_PARAM_BOUNDS: Record<ManagedParamKey, [number, number]> = {
  feeMultiplier: [1.0, 8.0],
  tpReservePct: [0.0, 0.5],
  trailingTpPct: [0.001, 0.03],
  gridSizeMultiplier: [0.5, 1.5],
  initialSharePct: [0.1, 0.5],
};

export const MANAGED_PARAM_PRESETS: Record<ManagedParamKey, number> = {
  feeMultiplier: 3.5,
  tpReservePct: 0.1,
  trailingTpPct: 0.005,
  gridSizeMultiplier: 1,
  initialSharePct: 0.25,
};

export const MANAGED_PARAM_DESCRIPTIONS: Record<ManagedParamKey, string> = {
  feeMultiplier: "Grid gap above round-trip fees; higher values reduce fill frequency but improve per-fill margin.",
  tpReservePct: "Position percentage reserved for trailing or recovery coverage instead of ordinary take-profit orders.",
  trailingTpPct: "Pullback percentage used by the reserve trailing take-profit.",
  gridSizeMultiplier: "Multiplier applied to child grid order size; affects exposure pacing, not allocated capital.",
  initialSharePct: "Percentage of grid budget used for the initial entry before remaining margin is distributed across levels.",
};

export function clampManaged<T = number>(key: string, value: T): T {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const bounds = (MANAGED_PARAM_BOUNDS as Record<string, [number, number]>)[key];
  if (!bounds) return value;
  return (Math.min(bounds[1], Math.max(bounds[0], value))) as unknown as T;
}

/** Read a tunable strategy param. Priority: config.managed[key] > config[key] > fallback. Always clamped to hard bounds. */
export function managedParam<T = number>(config: Record<string, any> | undefined, key: string, fallback: T): T {
  if (!config) return fallback;
  const raw = config.managed?.[key] ?? config[key] ?? fallback;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (typeof num === "number" && Number.isFinite(num)) {
    return clampManaged<T>(key, num as unknown as T);
  }
  return fallback;
}
