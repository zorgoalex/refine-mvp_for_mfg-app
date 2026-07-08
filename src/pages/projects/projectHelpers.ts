import type { ProjectDto } from '../../api/projectsApi';
import { formatNumber } from '../../utils/numberFormat';

interface ProjectIdentity {
  projectId: number;
  clientId: number;
}

export interface ProjectRow {
  key: number;
  projectId: number;
  code: string;
  name: string;
  clientLabel: string;
  ordersCount: number;
  ordersCountLabel: string;
  totalFinalAmountLabel: string;
  totalPaidAmountLabel: string;
}

export function formatProjectRow(dto: ProjectDto): ProjectRow {
  const ordersCount = dto.ordersCount ?? 0;

  return {
    key: dto.projectId,
    projectId: dto.projectId,
    code: dto.code,
    name: dto.name,
    clientLabel: dto.clientName?.trim() || `Клиент #${dto.clientId}`,
    ordersCount,
    ordersCountLabel: normalizeSpacing(formatNumber(ordersCount, 0)),
    totalFinalAmountLabel: normalizeSpacing(formatNumber(parseAmount(dto.totalFinalAmount), 2)),
    totalPaidAmountLabel: normalizeSpacing(formatNumber(parseAmount(dto.totalPaidAmount), 2)),
  };
}

export function canMergeInto(target: ProjectIdentity, source: ProjectIdentity): boolean {
  if (target.projectId === source.projectId) {
    return false;
  }

  return target.clientId === source.clientId;
}

function parseAmount(value: string | null | undefined): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeSpacing(value: string): string {
  return value.replace(/[  ]/g, ' ');
}
