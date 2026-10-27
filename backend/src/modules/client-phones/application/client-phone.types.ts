import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ClientPhoneResponseDto,
  CreateClientPhoneRequestDto,
  DeleteClientPhoneRequestDto,
  DeleteClientPhoneResponseDto,
  ReplaceClientPhoneSetRequestDto,
  ReplaceClientPhoneSetResponseDto,
  UpdateClientPhoneRequestDto,
} from '../dto/client-phone.dto';

export interface CreateClientPhoneCommand {
  currentUser: CurrentUser;
  dto: CreateClientPhoneRequestDto;
  requestId?: string;
}

export interface UpdateClientPhoneCommand {
  currentUser: CurrentUser;
  phoneId: number;
  dto: UpdateClientPhoneRequestDto;
  requestId?: string;
}

export interface DeleteClientPhoneCommand {
  currentUser: CurrentUser;
  phoneId: number;
  dto: DeleteClientPhoneRequestDto;
  requestId?: string;
}

/** The whole phone set of one client at once (the contacts screen): compared with what the screen saw, then applied. */
export interface ReplaceClientPhoneSetCommand {
  currentUser: CurrentUser;
  clientId: number;
  dto: ReplaceClientPhoneSetRequestDto;
  requestId?: string;
  /** Audit / outbox source of the caller. */
  source: string;
}

export type ClientPhoneMutationResult = ClientPhoneResponseDto;

export interface ClientPhoneRepositoryPort {
  createClientPhone(command: CreateClientPhoneCommand): Promise<ClientPhoneMutationResult>;
  updateClientPhone(command: UpdateClientPhoneCommand): Promise<ClientPhoneMutationResult>;
  deleteClientPhone(command: DeleteClientPhoneCommand): Promise<DeleteClientPhoneResponseDto>;
  replaceClientPhoneSet(command: ReplaceClientPhoneSetCommand): Promise<ReplaceClientPhoneSetResponseDto>;
}
