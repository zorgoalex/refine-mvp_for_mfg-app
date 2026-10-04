/**
 * "Интеграция 1С" section config: route/menu identity for the 1C agent
 * administration screens (agents, configuration, alerts/incidents).
 *
 * Mirrors src/config/bitrix24.ts: a small, static config object consumed by
 * routing/menu wiring (App.tsx, navigationPermissions.ts, navigationMenuConfig.ts).
 * Visibility itself is NOT decided here — it is
 * featureFlags.useBackendOnec && (can('onec.view') || can('onec.manage') || can('onec.commands.send')),
 * enforced both at the resource-registration level (App.tsx) and inside the
 * page itself (defense in depth for direct URL navigation).
 */
export const ONEC_RESOURCE_NAME = 'onec';
export const ONEC_ROUTE = '/onec';

export interface OnecMenuConfig {
  /** Resource name used across Refine resources / sider menu / permission map. */
  resourceName: string;
  /** Top-level route. */
  route: string;
  /** Russian label shown in the sider/top menu. */
  label: string;
}

export const onecMenuConfig: OnecMenuConfig = {
  resourceName: ONEC_RESOURCE_NAME,
  route: ONEC_ROUTE,
  label: 'Интеграция 1С',
};
