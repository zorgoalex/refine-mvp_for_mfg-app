import type { CurrentUser } from '../../../permissions/current-user';

export interface SupplierTextTemplateDto {
  templateId: number;
  name: string;
  body: string;
  lineTemplate: string;
  isDefault: boolean;
  version: number;
  updatedAt: string;
}

export interface SupplierTextTemplatesListDto {
  templates: SupplierTextTemplateDto[];
  /** Право править шаблоны (procurement.manage). */
  canManage: boolean;
}

interface CommandBase {
  currentUser: CurrentUser;
  /** Ключ повтора (uuid) — повтор с тем же телом возвращает сохранённый результат. */
  commandKey: string;
  /** requestId HTTP-запроса — в аудит. */
  requestId: string;
}

export interface CreateSupplierTextTemplateCommand extends CommandBase {
  name: string;
  body: string;
  lineTemplate: string;
}

export interface UpdateSupplierTextTemplateCommand extends CommandBase {
  templateId: number;
  expectedVersion: number;
  name?: string;
  body?: string;
  lineTemplate?: string;
}

export interface TemplateVersionCommand extends CommandBase {
  templateId: number;
  expectedVersion: number;
}

export interface SupplierTextTemplateCommandResultDto {
  changed: boolean;
  template: SupplierTextTemplateDto | null;
  templates: SupplierTextTemplateDto[];
}
