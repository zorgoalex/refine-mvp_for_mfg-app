import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ClientPhoneResponseDto,
  CreateClientPhoneRequestDto,
  DeleteClientPhoneRequestDto,
  DeleteClientPhoneResponseDto,
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

export type ClientPhoneMutationResult = ClientPhoneResponseDto;

export interface ClientPhoneRepositoryPort {
  createClientPhone(command: CreateClientPhoneCommand): Promise<ClientPhoneMutationResult>;
  updateClientPhone(command: UpdateClientPhoneCommand): Promise<ClientPhoneMutationResult>;
  deleteClientPhone(command: DeleteClientPhoneCommand): Promise<DeleteClientPhoneResponseDto>;
}
