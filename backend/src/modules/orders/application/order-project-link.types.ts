import type { CurrentUser } from '../../../permissions/current-user';
import type {
  OrderProjectsResponseDto,
  ReplaceOrderProjectsRequestDto,
  ReplaceOrderProjectsResponseDto,
} from '../dto/order-project-link.dto';

export interface GetOrderProjectsCommand {
  currentUser: CurrentUser;
  orderId: number;
  requestId?: string;
}

export interface ReplaceOrderProjectsCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: ReplaceOrderProjectsRequestDto;
  requestId?: string;
}

export interface OrderProjectLinkRepositoryPort {
  getOrderProjects(command: GetOrderProjectsCommand): Promise<OrderProjectsResponseDto>;
  replaceOrderProjects(command: ReplaceOrderProjectsCommand): Promise<ReplaceOrderProjectsResponseDto>;
}
