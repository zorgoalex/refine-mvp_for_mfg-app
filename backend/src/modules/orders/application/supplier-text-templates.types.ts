import type { CurrentUser } from '../../../permissions/current-user';

export interface SupplierTextTemplateDto {
  templateId: number;
  name: string;
  body: string;
  lineTemplate: string;
  /** Действует по умолчанию для текущего пользователя: его личный выбор, иначе общий шаблон по умолчанию. */
  isDefault: boolean;
  version: number;
  updatedAt: string;
  /** `shared` — общий шаблон компании (только чтение), `own` — личный шаблон текущего пользователя. */
  scope: SupplierTextTemplateScope;
}

export type SupplierTextTemplateScope = 'shared' | 'own';

/** Прежний маршрут (FE до личных шаблонов): только общие шаблоны; они больше не меняются через API — `canManage` всегда false. */
export interface SupplierTextTemplatesListDto {
  templates: SupplierTextTemplateDto[];
  canManage: boolean;
}

/** Маршрут личных шаблонов: общие и свои. */
export interface MySupplierTextTemplatesListDto {
  templates: SupplierTextTemplateDto[];
  /** Можно вести личные шаблоны (procurement.view). */
  canEditOwn: boolean;
  /** Ревизия личного выбора по умолчанию (0 — выбора ещё не было): `expectedDefaultRevision` команды default. */
  defaultRevision: number;
}

/** Что видит пользователь: шаблоны и ревизия его выбора по умолчанию. */
export interface VisibleSupplierTextTemplatesDto {
  templates: SupplierTextTemplateDto[];
  defaultRevision: number;
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

export interface SetDefaultTemplateCommand extends TemplateVersionCommand {
  /** Ревизия личного выбора, которую видел пользователь: устаревшее намерение отклоняется (plan review R4-1). */
  expectedDefaultRevision: number;
}

export interface SupplierTextTemplateCommandResultDto {
  changed: boolean;
  template: SupplierTextTemplateDto | null;
  templates: SupplierTextTemplateDto[];
  /** Ревизия личного выбора на момент команды (ответ повтора — исторический: актуальное состояние — в GET). */
  defaultRevision: number;
}
