export interface PrePrSettings {
  reviewerCount: number;
  maxRounds: number;
  stageTimeoutMinutes: number;
}

export interface PrePrSettingDefinition {
  key: keyof PrePrSettings;
  envKey: string;
  defaultValue: number;
  min: number;
  max: number;
}

export const PRE_PR_SETTING_DEFINITIONS: readonly PrePrSettingDefinition[] = [
  { key: 'reviewerCount', envKey: 'PRE_PR_REVIEWER_COUNT', defaultValue: 2, min: 1, max: 2 },
  { key: 'maxRounds', envKey: 'PRE_PR_MAX_ROUNDS', defaultValue: 3, min: 1, max: 5 },
  { key: 'stageTimeoutMinutes', envKey: 'PRE_PR_STAGE_TIMEOUT_MINUTES', defaultValue: 45, min: 5, max: 180 },
];

export const PRE_PR_CONFIG_KEYS: readonly string[] = PRE_PR_SETTING_DEFINITIONS.map(({ envKey }) => envKey);

export const DEFAULT_PRE_PR_SETTINGS: Readonly<PrePrSettings> = Object.freeze({
  reviewerCount: 2,
  maxRounds: 3,
  stageTimeoutMinutes: 45,
});

export function parsePrePrSettingValue(value: unknown, definition: PrePrSettingDefinition): number | undefined {
  const trimmed: unknown = typeof value === 'string' ? value.trim() : value;
  if (typeof trimmed !== 'number' && (typeof trimmed !== 'string' || !/^\d+$/.test(trimmed))) return undefined;
  const parsed: number = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= definition.min && parsed <= definition.max ? parsed : undefined;
}

export function normalizePrePrSettings(value?: Partial<PrePrSettings> | null): PrePrSettings {
  const settings: PrePrSettings = { ...DEFAULT_PRE_PR_SETTINGS };
  for (const definition of PRE_PR_SETTING_DEFINITIONS) {
    settings[definition.key] = parsePrePrSettingValue(value?.[definition.key], definition) ?? definition.defaultValue;
  }
  return settings;
}
