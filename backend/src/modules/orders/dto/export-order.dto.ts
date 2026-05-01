export interface ExportOrderRequestDto {
  format?: 'xlsx';
  fileName?: string | null;
}

export interface NormalizedExportOrderRequestDto {
  format: 'xlsx';
  fileName: string | null;
}

export interface ExportOrderResponseDto {
  success: boolean;
  fileName: string;
  folder?: string | null;
  xlsxUrl?: string | null;
  externalId?: string | null;
}
