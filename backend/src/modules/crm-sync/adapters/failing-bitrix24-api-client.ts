import type {
  Bitrix24ApiPort,
  Bitrix24RequestGuard,
} from './bitrix24-api-client';

const MESSAGE =
  'Bitrix24 sync client not configured: missing BITRIX24_WEBHOOK_URL';

export class FailingBitrix24ApiClient implements Bitrix24ApiPort {
  withRequestGuard<T>(
    _guard: Bitrix24RequestGuard,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }

  private fail<T>(): Promise<T> {
    return Promise.reject(new Error(MESSAGE));
  }

  createCrmItem(): Promise<string> { return this.fail(); }
  updateCrmItem(): Promise<void> { return this.fail(); }
  findCrmItemByOrigin(): Promise<string | null> { return this.fail(); }
  deleteCrmItem(): Promise<void> { return this.fail(); }
  setDealProductRows(): Promise<void> { return this.fail(); }
  findPaymentByXmlId(): Promise<string | null> { return this.fail(); }
  listDealPaymentIds(): Promise<string[]> { return this.fail(); }
  createDealPayment(): Promise<string> { return this.fail(); }
  updatePayment(): Promise<void> { return this.fail(); }
  deletePayment(): Promise<void> { return this.fail(); }
}
