import type { FrontendUiRuntimeConfig } from '../config/runtimeConfig';

export type UiVariant = 'legacy' | 'evolution';

export const DEFAULT_UI_VARIANT: UiVariant = 'legacy';

/**
 * UI rollout is runtime-only and fail-closed. Build-time VITE flags are
 * deliberately ignored: a missing, timed-out, or malformed runtime config
 * must never opt a user into the evolution shell.
 */
export function resolveUiVariant(config: FrontendUiRuntimeConfig | null | undefined): UiVariant {
  if (config?.forceLegacy === true) return 'legacy';
  return config?.evolutionEnabled === true ? 'evolution' : DEFAULT_UI_VARIANT;
}

export function setDocumentUiVariant(
  variant: UiVariant,
  documentRef: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (!documentRef) return;
  documentRef.documentElement.dataset.uiVariant = variant;
}
