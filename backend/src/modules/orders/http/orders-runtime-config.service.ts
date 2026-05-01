import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface OrdersHttpFeatureFlags {
  ordersEnabled: boolean;
  ordersReadOnly: boolean;
  orderExportEnabled?: boolean;
  exportDisabled?: boolean;
}

@Injectable()
export class OrdersRuntimeConfigService {
  constructor(private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): OrdersHttpFeatureFlags {
    return {
      ordersEnabled: this.config.get('BACKEND_ENABLE_ORDERS', { infer: true }),
      ordersReadOnly: this.config.get('BACKEND_ORDERS_READ_ONLY', { infer: true }),
      orderExportEnabled: this.config.get('BACKEND_ENABLE_ORDER_EXPORT', { infer: true }),
      exportDisabled: this.config.get('BACKEND_EXPORT_DISABLED', { infer: true }),
    };
  }
}
