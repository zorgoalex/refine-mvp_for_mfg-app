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
  /** The client the form showed the phone at: another owner under the locks (a merge moved it) is a conflict. */
  clientId?: number;
}

/** A phone of the client as the contacts screen saw it (the set command compares the whole set). */
export interface ClientPhoneSetExpectedDto {
  phoneId: number;
  phoneNumber: string;
  phoneType: ClientPhoneTypeDto;
  isPrimary: boolean;
}

/** A phone of the wanted set: an existing one keeps its id, a new one has none. */
export interface ClientPhoneSetLineDto {
  phoneId: number | null;
  phoneNumber: string;
  phoneType: ClientPhoneTypeDto;
  isPrimary: boolean;
}

export interface ReplaceClientPhoneSetRequestDto {
  idempotencyKey: string;
  expected: ClientPhoneSetExpectedDto[];
  phones: ClientPhoneSetLineDto[];
}

export interface ReplaceClientPhoneSetResponseDto {
  clientId: number;
  phones: ClientPhoneDto[];
  created: number;
  updated: number;
  deleted: number;
  requestId: string;
}
