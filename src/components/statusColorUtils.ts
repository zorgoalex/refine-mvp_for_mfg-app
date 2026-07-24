const STATUS_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;

export const DEFAULT_STATUS_COLOR = '#1677FF';

export const normalizeStatusColor = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toUpperCase();
  return STATUS_COLOR_PATTERN.test(normalized) ? normalized : undefined;
};

