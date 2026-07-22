// TypeScript types for Clients and related entities

// ============================================================================
// CLIENT
// ============================================================================

export interface Client {
  client_id?: number;
  client_name: string;
  person_type: ClientPersonType;
  notes?: string | null;
  is_active: boolean;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;

  // Related data
  client_phones?: ClientPhone[];
}

export type ClientPersonType = 'individual' | 'legal';

export const CLIENT_PERSON_TYPE_LABELS: Record<ClientPersonType, string> = {
  individual: 'Физическое лицо',
  legal: 'Юридическое лицо',
};

// ============================================================================
// CLIENT PHONE
// ============================================================================

export type PhoneType = 'mobile' | 'work' | 'home' | 'fax';

export interface ClientPhone {
  phone_id?: number;
  client_id?: number;
  phone_number: string;
  phone_type: PhoneType;
  is_primary: boolean;
  ref_key_1c?: string | null;
  created_by?: number;
  edited_by?: number | null;
  created_at?: Date | string;
  updated_at?: Date | string;

  // Client-side only (for new records)
  temp_id?: number;
}

export const PHONE_TYPE_LABELS: Record<PhoneType, string> = {
  mobile: 'Мобильный',
  work: 'Рабочий',
  home: 'Домашний',
  fax: 'Факс',
};

// ============================================================================
// CLIENT FORM VALUES
// ============================================================================

export interface ClientFormValues {
  client: Client;
  phones: ClientPhone[];
  deletedPhones?: number[];
  isDirty?: boolean;
}
