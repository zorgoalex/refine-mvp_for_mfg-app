export interface FrontendFeatureFlags {
  useBackendAuth: boolean;
  useBackendPermissions: boolean;
  useBackendOrdersRead: boolean;
  useBackendOrdersWrite: boolean;
  useBackendPayments: boolean;
  useBackendClientPhones: boolean;
  useBackendProductionActions: boolean;
  useBackendDeadlines: boolean;
  useBackendOrderExport: boolean;
  useBackendGroups: boolean;
  useBackendUsers: boolean;
  useBackendVlm: boolean;
  useBackendReferences: boolean;
  useBackendCut: boolean;
  bazisCut: boolean;
  projects: boolean;
  useBackendBazis: boolean;
  labels: boolean;
  statusAutomation: boolean;
  orderStatusBoard: boolean;
  cncTelegram: boolean;
  pdfImportLayoutPatterns: boolean;
  // Variant B: gates reads that depend on migration 034 Hasura schema
  // (sheet_material_type_id as the sole order-material reference; order_details_view
  // now returns sheet name only). Default MUST stay false — a FRESH env (no 034 applied)
  // boots on the legacy (pre-034) path; flip to true ONLY inside the atomic cutover
  // window after migration 034 + Hasura metadata reload + backend rebuild are all live.
  // NOTE: reverting an already-applied 034 is an EMERGENCY-only path (see
  // 034_rollback.sql) — the reverse script is structural and may leave legacy UX
  // degraded; a real revert restores from a DB backup, not the reverse script.
  // Flag is removed in a follow-up cleanup release.
  sheetMaterialsReads: boolean;
  enableLegacyHasura: boolean;
  /** Hybrid SSO login via WorkOS AuthKit; requires useBackendAuth. */
  workosAuth: boolean;
}

type EnvSource = Record<string, string | boolean | undefined>;
export type RuntimeFeatureFlagSource = Partial<{
  backendAuth: string | boolean;
  backendPermissions: string | boolean;
  backendOrders: string | boolean;
  backendOrdersRead: string | boolean;
  backendOrdersWrite: string | boolean;
  backendPayments: string | boolean;
  backendClientPhones: string | boolean;
  backendProductionActions: string | boolean;
  backendDeadlines: string | boolean;
  backendOrderExport: string | boolean;
  backendGroups: string | boolean;
  backendUsers: string | boolean;
  backendVlm: string | boolean;
  backendReferences: string | boolean;
  backendCut: string | boolean;
  bazisCut: string | boolean;
  projects: string | boolean;
  bazisImport: string | boolean;
  labels: string | boolean;
  statusAutomation: string | boolean;
  orderStatusBoard: string | boolean;
  cncTelegram: string | boolean;
  pdfImportLayoutPatterns: string | boolean;
  sheetMaterialsReads: string | boolean;
  sheetMaterials: string | boolean;
  enableLegacyHasura: string | boolean;
  legacyHasura: string | boolean;
  workosAuth: string | boolean;
}>;

export function getFeatureFlags(
  env: EnvSource = (import.meta as { env?: EnvSource }).env ?? {},
  runtimeFeatures: RuntimeFeatureFlagSource = {},
): FrontendFeatureFlags {
  const legacyOrdersFlag = readBooleanFlag(env.VITE_USE_BACKEND_ORDERS, false);
  const backendGroupsFlag = readBooleanFlag(env.VITE_USE_BACKEND_GROUPS, false);
  const envFlags: FrontendFeatureFlags = {
    useBackendAuth: readBooleanFlag(env.VITE_USE_BACKEND_AUTH, false),
    useBackendPermissions: readBooleanFlag(env.VITE_USE_BACKEND_PERMISSIONS, false),
    useBackendOrdersRead: readBooleanFlag(
      env.VITE_USE_BACKEND_ORDERS_READ,
      legacyOrdersFlag,
    ),
    useBackendOrdersWrite: readBooleanFlag(
      env.VITE_USE_BACKEND_ORDERS_WRITE,
      legacyOrdersFlag,
    ),
    useBackendPayments: readBooleanFlag(env.VITE_USE_BACKEND_PAYMENTS, false),
    useBackendClientPhones: readBooleanFlag(env.VITE_USE_BACKEND_CLIENT_PHONES, false),
    useBackendProductionActions: readBooleanFlag(
      env.VITE_USE_BACKEND_PRODUCTION_ACTIONS,
      false,
    ),
    useBackendDeadlines: readBooleanFlag(env.VITE_USE_BACKEND_DEADLINES, false),
    useBackendOrderExport: readBooleanFlag(env.VITE_USE_BACKEND_ORDER_EXPORT, false),
    useBackendGroups: backendGroupsFlag,
    useBackendUsers: readBooleanFlag(env.VITE_USE_BACKEND_USERS, false),
    useBackendVlm: readBooleanFlag(env.VITE_USE_BACKEND_VLM, false),
    useBackendReferences: readBooleanFlag(env.VITE_USE_BACKEND_REFERENCES, false),
    useBackendCut: readBooleanFlag(env.VITE_USE_BACKEND_CUT, false),
    bazisCut: readBooleanFlag(env.VITE_USE_BACKEND_BAZIS_CUT, false),
    projects: readBooleanFlag(env.VITE_USE_PROJECTS, false),
    useBackendBazis: readBooleanFlag(env.VITE_USE_BACKEND_BAZIS, false),
    labels: readBooleanFlag(env.VITE_USE_BACKEND_LABELS, false),
    statusAutomation: readBooleanFlag(env.VITE_STATUS_AUTOMATION, false),
    orderStatusBoard: readBooleanFlag(env.VITE_ORDER_STATUS_BOARD, false),
    cncTelegram: readBooleanFlag(env.VITE_USE_BACKEND_CNC_TELEGRAM, false),
    pdfImportLayoutPatterns: readBooleanFlag(env.VITE_PDF_IMPORT_LAYOUT_PATTERNS, false),
    sheetMaterialsReads: readBooleanFlag(env.VITE_SHEET_MATERIALS_READS, false),
    enableLegacyHasura: readBooleanFlag(env.VITE_ENABLE_LEGACY_HASURA, true),
    workosAuth: readBooleanFlag(env.VITE_WORKOS_AUTH, false),
  };

  return mergeRuntimeFeatureFlags(envFlags, runtimeFeatures);
}

export function mergeRuntimeFeatureFlags(
  fallback: FrontendFeatureFlags,
  runtimeFeatures: RuntimeFeatureFlagSource = {},
): FrontendFeatureFlags {
  const runtimeOrdersFlag = readOptionalBooleanFlag(runtimeFeatures.backendOrders);
  const runtimeGroupsFlag = readOptionalBooleanFlag(runtimeFeatures.backendGroups);
  const useBackendGroups = runtimeGroupsFlag ?? fallback.useBackendGroups;

  return enforceFrontendFeatureDependencies({
    useBackendAuth: readOptionalBooleanFlag(runtimeFeatures.backendAuth) ?? fallback.useBackendAuth,
    useBackendPermissions:
      readOptionalBooleanFlag(runtimeFeatures.backendPermissions) ?? fallback.useBackendPermissions,
    useBackendOrdersRead:
      readOptionalBooleanFlag(runtimeFeatures.backendOrdersRead) ??
      runtimeOrdersFlag ??
      fallback.useBackendOrdersRead,
    useBackendOrdersWrite:
      readOptionalBooleanFlag(runtimeFeatures.backendOrdersWrite) ??
      runtimeOrdersFlag ??
      fallback.useBackendOrdersWrite,
    useBackendPayments:
      readOptionalBooleanFlag(runtimeFeatures.backendPayments) ?? fallback.useBackendPayments,
    useBackendClientPhones:
      readOptionalBooleanFlag(runtimeFeatures.backendClientPhones) ??
      fallback.useBackendClientPhones,
    useBackendProductionActions:
      readOptionalBooleanFlag(runtimeFeatures.backendProductionActions) ??
      fallback.useBackendProductionActions,
    useBackendDeadlines:
      readOptionalBooleanFlag(runtimeFeatures.backendDeadlines) ??
      fallback.useBackendDeadlines,
    useBackendOrderExport:
      readOptionalBooleanFlag(runtimeFeatures.backendOrderExport) ?? fallback.useBackendOrderExport,
    useBackendGroups,
    useBackendUsers: readOptionalBooleanFlag(runtimeFeatures.backendUsers) ?? fallback.useBackendUsers,
    useBackendVlm: readOptionalBooleanFlag(runtimeFeatures.backendVlm) ?? fallback.useBackendVlm,
    useBackendReferences:
      readOptionalBooleanFlag(runtimeFeatures.backendReferences) ?? fallback.useBackendReferences,
    useBackendCut: readOptionalBooleanFlag(runtimeFeatures.backendCut) ?? fallback.useBackendCut,
    bazisCut: readOptionalBooleanFlag(runtimeFeatures.bazisCut) ?? fallback.bazisCut,
    projects: readOptionalBooleanFlag(runtimeFeatures.projects) ?? fallback.projects,
    useBackendBazis:
      readOptionalBooleanFlag(runtimeFeatures.bazisImport) ?? fallback.useBackendBazis,
    labels: readOptionalBooleanFlag(runtimeFeatures.labels) ?? fallback.labels,
    statusAutomation:
      readOptionalBooleanFlag(runtimeFeatures.statusAutomation) ?? fallback.statusAutomation,
    orderStatusBoard:
      readOptionalBooleanFlag(runtimeFeatures.orderStatusBoard) ?? fallback.orderStatusBoard,
    cncTelegram:
      readOptionalBooleanFlag(runtimeFeatures.cncTelegram) ?? fallback.cncTelegram,
    pdfImportLayoutPatterns:
      readOptionalBooleanFlag(runtimeFeatures.pdfImportLayoutPatterns) ??
      fallback.pdfImportLayoutPatterns,
    sheetMaterialsReads:
      readOptionalBooleanFlag(runtimeFeatures.sheetMaterialsReads) ??
      readOptionalBooleanFlag(runtimeFeatures.sheetMaterials) ??
      fallback.sheetMaterialsReads,
    enableLegacyHasura:
      readOptionalBooleanFlag(runtimeFeatures.enableLegacyHasura) ??
      readOptionalBooleanFlag(runtimeFeatures.legacyHasura) ??
      fallback.enableLegacyHasura,
    workosAuth: readOptionalBooleanFlag(runtimeFeatures.workosAuth) ?? fallback.workosAuth,
  });
}

function enforceFrontendFeatureDependencies(flags: FrontendFeatureFlags): FrontendFeatureFlags {
  // SSO login exchanges the provider code for a backend session; without
  // backend-auth mode the app cannot consume that session (POC gotcha #7).
  // The coercion must stay VISIBLE to ops — a silently vanished SSO button
  // reads as a frontend bug instead of a runtime-config mistake.
  if (flags.workosAuth && !flags.useBackendAuth) {
    // eslint-disable-next-line no-console
    console.warn('[featureFlags] workosAuth requires backendAuth; SSO login is disabled');
  }

  return {
    ...flags,
    useBackendClientPhones:
      flags.useBackendClientPhones && flags.useBackendProductionActions,
    useBackendDeadlines:
      flags.useBackendDeadlines && flags.useBackendAuth && flags.useBackendOrdersRead,
    bazisCut: flags.bazisCut && flags.useBackendCut,
    orderStatusBoard: flags.orderStatusBoard && flags.useBackendOrdersRead,
    cncTelegram:
      flags.cncTelegram && flags.orderStatusBoard && flags.useBackendOrdersRead,
    workosAuth: flags.workosAuth && flags.useBackendAuth,
  };
}

export function readBooleanFlag(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

export function readOptionalBooleanFlag(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === '') return undefined;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return undefined;
}

export const featureFlags = getFeatureFlags();

export function applyFeatureFlags(nextFlags: FrontendFeatureFlags): FrontendFeatureFlags {
  Object.assign(featureFlags, nextFlags);
  return featureFlags;
}
