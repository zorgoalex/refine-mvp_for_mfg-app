export type ClientPhoneTypeDto = 'mobile' | 'work' | 'home' | 'fax';

export interface ClientPhoneDto {
  phoneId: number;
  clientId: number;
  phoneNumber: string;
  phoneType: ClientPhoneTypeDto;
  isPrimary: boolean;
  refKey1c: string | null;
  createdBy: number | null;
  editedBy: number | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface ClientPhoneResponseDto {
  phone: ClientPhoneDto;
  demotedPhoneIds?: number[];
  auditId?: string;
  requestId: string;
}

export interface DeleteClientPhoneResponseDto {
  phoneId: number;
  clientId: number;
  deleted: true;
  auditId?: string;
  requestId: string;
}

export interface CreateClientPhoneRequestDto {
  clientId: number;
  phoneNumber: string;
  phoneType: ClientPhoneTypeDto;
  isPrimary: boolean;
  refKey1c: string | null;
  idempotencyKey: string;
}

export interface UpdateClientPhoneRequestDto {
  clientId?: number;
  phoneNumber?: string;
  phoneType?: ClientPhoneTypeDto;
  isPrimary?: boolean;
  refKey1c?: string | null;
  idempotencyKey: string;
}

export interface DeleteClientPhoneRequestDto {
  idempotencyKey: string;
}
