import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { CurrentUser, RequestWithCurrentUser } from './current-user';

export const CurrentUserDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUser | undefined => {
    const request = context.switchToHttp().getRequest<RequestWithCurrentUser>();
    return request.user;
  },
);

export { CurrentUserDecorator as CurrentUser };
