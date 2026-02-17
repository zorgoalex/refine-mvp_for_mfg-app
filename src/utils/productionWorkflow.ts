import { PRODUCTION_STATUS_CODE_LETTERS } from '../types/orders';
import {
  ProductionStatusRef,
  ProductionWorkflowConfig,
  buildDefaultProductionWorkflowConfig,
  normalizeProductionWorkflowConfig,
} from '../types/productionWorkflow';

export interface ProductionStagesDisplayConfig {
  displayOrderCodes: string[];
  codeToLetter: Record<string, string>;
  codeToName: Record<string, string>;
}

const getFallbackLetter = (code: string, name?: string) => {
  const mapped = PRODUCTION_STATUS_CODE_LETTERS[code];
  if (mapped) return mapped;
  const first = (name || '').trim().slice(0, 1);
  return first ? first.toUpperCase() : '?';
};

export const buildProductionStagesDisplayConfig = (params: {
  workflow: ProductionWorkflowConfig | null;
  statuses: ProductionStatusRef[];
  workflowKey: string;
}): { workflow: ProductionWorkflowConfig; display: ProductionStagesDisplayConfig } => {
  const { workflow, statuses, workflowKey } = params;

  const normalized = normalizeProductionWorkflowConfig(workflow, statuses, workflowKey);
  const byCode = new Map<string, ProductionStatusRef>();
  statuses.forEach((s) => byCode.set(s.production_status_code, s));

  const codeToName: Record<string, string> = {};
  statuses.forEach((s) => {
    codeToName[s.production_status_code] = s.production_status_name;
  });

  const codeToLetter: Record<string, string> = {};
  const lettersByCode = normalized.letters_by_code || {};

  normalized.status_codes_order.forEach((code) => {
    const status = byCode.get(code);
    const configured = lettersByCode[code];
    const letter = (configured || '').trim().slice(0, 1);
    codeToLetter[code] = letter ? letter.toUpperCase() : getFallbackLetter(code, status?.production_status_name);
  });

  // Also provide letters for statuses not in status_codes_order (useful for unknown passed codes)
  statuses.forEach((s) => {
    if (codeToLetter[s.production_status_code]) return;
    const configured = lettersByCode[s.production_status_code];
    const letter = (configured || '').trim().slice(0, 1);
    codeToLetter[s.production_status_code] = letter
      ? letter.toUpperCase()
      : getFallbackLetter(s.production_status_code, s.production_status_name);
  });

  return {
    workflow: normalized,
    display: {
      displayOrderCodes: normalized.status_codes_order,
      codeToLetter,
      codeToName,
    },
  };
};

export const getProductionWorkflowOrDefault = (params: {
  workflow: ProductionWorkflowConfig | null;
  statuses: ProductionStatusRef[];
  workflowKey: string;
}) => {
  const { workflow, statuses, workflowKey } = params;
  if (!workflow) return buildDefaultProductionWorkflowConfig(statuses, workflowKey);
  return normalizeProductionWorkflowConfig(workflow, statuses, workflowKey);
};

