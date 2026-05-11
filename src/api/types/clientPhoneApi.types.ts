export type ClientPhoneType = 'mobile' | 'work' | 'home' | 'fax';

export interface ClientPhoneDto {
  phoneId: number;
  clientId: number;
  phoneNumber: string;
  phoneType: ClientPhoneType;
  isPrimary: boolean;
  refKey1c: string | null;
  createdBy: number | null;
  editedBy: number | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateClientPhoneRequest {
  clientId: number;
  phoneNumber: string;
  phoneType?: ClientPhoneType;
  isPrimary?: boolean;
  refKey1c?: string | null;
  idempotencyKey?: string;
}

export interface UpdateClientPhoneRequest {
  clientId?: number;
  phoneNumber?: string;
  phoneType?: ClientPhoneType;
  isPrimary?: boolean;
  refKey1c?: string | null;
  idempotencyKey?: string;
}

export interface ClientPhoneResponse {
  phone: ClientPhoneDto;
  demotedPhoneIds?: number[];
  auditId?: string;
  requestId: string;
}

export interface DeleteClientPhoneResponse {
  phoneId: number;
  clientId: number;
  deleted: true;
  auditId?: string;
  requestId: string;
}
