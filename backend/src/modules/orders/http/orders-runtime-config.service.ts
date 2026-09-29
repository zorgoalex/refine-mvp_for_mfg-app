import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface OrdersHttpFeatureFlags {
  ordersEnabled: boolean;
  ordersReadOnly: boolean;
  orderExportEnabled?: boolean;
  exportDisabled?: boolean;
  /** BACKEND_RESOURCE_PROCUREMENT_ENABLED: отметки «Закуплено» у материалов заказа. */
  resourceProcurementEnabled?: boolean;
  /** BACKEND_PROCUREMENT_WORKSPACE_ENABLED: вкладка «Экран снабжения» (рабочий список). */
  procurementWorkspaceEnabled?: boolean;
}

@Injectable()
export class OrdersRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): OrdersHttpFeatureFlags {
    return {
      ordersEnabled: this.config.get('BACKEND_ENABLE_ORDERS', { infer: true }),
      ordersReadOnly: this.config.get('BACKEND_ORDERS_READ_ONLY', { infer: true }),
      orderExportEnabled: this.config.get('BACKEND_ENABLE_ORDER_EXPORT', { infer: true }),
      exportDisabled: this.config.get('BACKEND_EXPORT_DISABLED', { infer: true }),
      resourceProcurementEnabled: this.config.get('BACKEND_RESOURCE_PROCUREMENT_ENABLED', { infer: true }),
      procurementWorkspaceEnabled: this.config.get('BACKEND_PROCUREMENT_WORKSPACE_ENABLED', { infer: true }),
    };
  }
}
