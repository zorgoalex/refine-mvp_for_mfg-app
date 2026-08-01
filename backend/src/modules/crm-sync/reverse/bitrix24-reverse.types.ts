export type Bitrix24ReverseObjectType = 'contact' | 'company' | 'deal';
export type Bitrix24ReverseOperation = 'upsert' | 'delete';

export interface Bitrix24InstallationPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  domain: string;
  memberId: string;
  applicationStatus: string;
  applicationToken: string;
}

export interface Bitrix24InboundEventPayload {
  eventName: string;
  objectType: Bitrix24ReverseObjectType;
  operation: Bitrix24ReverseOperation;
  bitrixId: string;
  eventTimestamp: Date;
  memberId: string;
  domain: string;
  applicationToken: string;
  fingerprint: string;
  storedPayload: Record<string, unknown>;
}

export interface Bitrix24InboundEventRow {
  inboundEventId: string;
  memberId: string;
  eventName: string;
  objectType: Bitrix24ReverseObjectType;
  operation: Bitrix24ReverseOperation;
  bitrixId: string;
  attempts: number;
  lockToken: string;
}

export interface Bitrix24InstallationRow {
  memberId: string;
  domain: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  accessTokenExpiresAt: Date;
  applicationTokenHash: string;
  status: 'active' | 'refresh_failed' | 'revoked';
}

export interface Bitrix24RefreshLease {
  memberId: string;
  domain: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  lockToken: string;
}
