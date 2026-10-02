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
  canManage: boolean;
}

export interface SupplierTextTemplateCommandResultDto {
  changed: boolean;
  template: SupplierTextTemplateDto | null;
  templates: SupplierTextTemplateDto[];
}

export interface CreateSupplierTextTemplateBody { commandKey: string; name: string; body: string; lineTemplate: string }
export interface UpdateSupplierTextTemplateBody { commandKey: string; expectedVersion: number; name?: string; body?: string; lineTemplate?: string }
export interface SupplierTextTemplateVersionBody { commandKey: string; expectedVersion: number }
