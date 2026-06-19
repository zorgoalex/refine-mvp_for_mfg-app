import type { TwentyObject, TwentyApiPort } from './twenty-api-client';

const MSG = 'Twenty sync client not configured: missing TWENTY_SYNC_BASE_URL/TWENTY_SYNC_API_KEY';

/**
 * Hard-failing implementation of TwentyApiPort.
 * Used when credentials are absent but the real (non-dry-run) consumer is invoked.
 * Every method throws immediately so that misconfigured runs fail loudly → markRetry,
 * never silently-processed via a Noop client.
 */
export class FailingTwentyApiClient implements TwentyApiPort {
  createRecord(_object: TwentyObject, _body: Record<string, unknown>): Promise<{ id: string }> {
    return Promise.reject(new Error(MSG));
  }

  updateRecord(_object: TwentyObject, _id: string, _body: Record<string, unknown>): Promise<void> {
    return Promise.reject(new Error(MSG));
  }

  findIdByErpId(_object: TwentyObject, _erpId: string): Promise<string | null> {
    return Promise.reject(new Error(MSG));
  }

  deleteRecord(_object: TwentyObject, _id: string): Promise<void> {
    return Promise.reject(new Error(MSG));
  }
}
