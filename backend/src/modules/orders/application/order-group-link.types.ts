import type { CurrentUser } from '../../../permissions/current-user';
import type {
  OrderGroupsResponseDto,
  ReplaceOrderGroupsRequestDto,
  ReplaceOrderGroupsResponseDto,
} from '../dto/order-group-link.dto';

export interface GetOrderGroupsCommand {
  currentUser: CurrentUser;
  orderId: number;
  requestId?: string;
}

export interface ReplaceOrderGroupsCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: ReplaceOrderGroupsRequestDto;
  requestId?: string;
}

export interface OrderGroupLinkRepositoryPort {
  getOrderGroups(command: GetOrderGroupsCommand): Promise<OrderGroupsResponseDto>;
  replaceOrderGroups(command: ReplaceOrderGroupsCommand): Promise<ReplaceOrderGroupsResponseDto>;
}
