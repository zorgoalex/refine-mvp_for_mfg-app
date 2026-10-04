export interface SupplierTextTemplateDto {
  templateId: number;
  name: string;
  body: string;
  lineTemplate: string;
  isDefault: boolean;
  version: number;
  updatedAt: string;
  /** `shared` — общий шаблон (только чтение), `own` — личный шаблон текущего пользователя; нет поля — старый backend (общий). */
  scope?: 'shared' | 'own';
}

/** Прежний маршрут: только общие шаблоны (для чтения при старом backend). */
export interface SupplierTextTemplatesListDto {
  templates: SupplierTextTemplateDto[];
  canManage: boolean;
}

/** Маршрут личных шаблонов: общие и свои. */
export interface MySupplierTextTemplatesListDto {
  templates: SupplierTextTemplateDto[];
  canEditOwn: boolean;
  /** Ревизия личного выбора по умолчанию (0 — выбора ещё не было). */
  defaultRevision: number;
}

/** Что видит пользователь: `editable=false` — backend без личных шаблонов (после отката), только чтение общих. */
export interface VisibleSupplierTextTemplates {
  templates: SupplierTextTemplateDto[];
  editable: boolean;
  /** Для команды «по умолчанию»: какую ревизию личного выбора видел пользователь. */
  defaultRevision: number;
}

export interface SupplierTextTemplateCommandResultDto {
  changed: boolean;
  template: SupplierTextTemplateDto | null;
  templates: SupplierTextTemplateDto[];
}

export interface CreateSupplierTextTemplateBody { commandKey: string; name: string; body: string; lineTemplate: string }
export interface UpdateSupplierTextTemplateBody { commandKey: string; expectedVersion: number; name?: string; body?: string; lineTemplate?: string }
export interface SupplierTextTemplateVersionBody { commandKey: string; expectedVersion: number }
export interface SupplierTextTemplateDefaultBody extends SupplierTextTemplateVersionBody { expectedDefaultRevision: number }
