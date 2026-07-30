import type { FrontendUiRuntimeConfig } from '../config/runtimeConfig';

export const UI_VARIANTS = ['legacy', 'evolution', 'line', 'air'] as const;
export type UiVariant = (typeof UI_VARIANTS)[number];

export const MODERN_UI_VARIANTS = ['evolution', 'line', 'air'] as const;
export type ModernUiVariant = (typeof MODERN_UI_VARIANTS)[number];

export const DEFAULT_UI_VARIANT: UiVariant = 'evolution';

const uiVariantSet = new Set<unknown>(UI_VARIANTS);
const modernUiVariantSet = new Set<unknown>(MODERN_UI_VARIANTS);

export function isUiVariant(value: unknown): value is UiVariant {
  return uiVariantSet.has(value);
}

export function isModernUiVariant(value: unknown): value is ModernUiVariant {
  return modernUiVariantSet.has(value);
}

export function isModernUiAvailable(
  config: FrontendUiRuntimeConfig | null | undefined,
): boolean {
  return config?.evolutionEnabled === true && config.forceLegacy !== true;
}

export function isEvolutionAvailable(
  config: FrontendUiRuntimeConfig | null | undefined,
): boolean {
  return isModernUiAvailable(config);
}

/**
 * Runtime config is the availability/kill-switch boundary. Within that
 * boundary a validated user preference overrides the modern UI default.
 */
export function resolveUiVariant(
  config: FrontendUiRuntimeConfig | null | undefined,
  preference?: unknown,
): UiVariant {
  if (!isModernUiAvailable(config)) return 'legacy';
  return isUiVariant(preference) ? preference : DEFAULT_UI_VARIANT;
}

export function setDocumentUiVariant(
  variant: UiVariant,
  documentRef: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (!documentRef) return;
  documentRef.documentElement.dataset.uiVariant = variant;
}
