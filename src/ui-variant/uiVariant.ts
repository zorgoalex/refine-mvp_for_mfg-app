import type { FrontendUiRuntimeConfig } from '../config/runtimeConfig';

export type UiVariant = 'legacy' | 'evolution';

export const DEFAULT_UI_VARIANT: UiVariant = 'evolution';

export function isUiVariant(value: unknown): value is UiVariant {
  return value === 'legacy' || value === 'evolution';
}

export function isEvolutionAvailable(
  config: FrontendUiRuntimeConfig | null | undefined,
): boolean {
  return config?.evolutionEnabled === true && config.forceLegacy !== true;
}

/**
 * Runtime config is the availability/kill-switch boundary. Within that
 * boundary a validated user preference overrides the evolution default.
 */
export function resolveUiVariant(
  config: FrontendUiRuntimeConfig | null | undefined,
  preference?: unknown,
): UiVariant {
  if (!isEvolutionAvailable(config)) return 'legacy';
  return isUiVariant(preference) ? preference : DEFAULT_UI_VARIANT;
}

export function setDocumentUiVariant(
  variant: UiVariant,
  documentRef: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (!documentRef) return;
  documentRef.documentElement.dataset.uiVariant = variant;
}
