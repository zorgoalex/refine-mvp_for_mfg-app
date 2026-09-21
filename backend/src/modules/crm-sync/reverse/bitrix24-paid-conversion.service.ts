import { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import { PgBitrix24ReverseRepository, type PaidConversionInput, type PaidConversionResult } from './pg-bitrix24-reverse-repository';

/** Only verified snapshot continuations enter here; never an HTTP command. */
export class Bitrix24PaidConversionService {
  constructor(private readonly repository: PgBitrix24ReverseRepository, private readonly config: CrmSyncRuntimeConfigService) {}

  async run(input: Pick<PaidConversionInput, 'dealId' | 'requestId' | 'eventId' | 'lockToken' | 'widget'>): Promise<PaidConversionResult> {
    const flags = this.config.getReverseSync();
    if (!flags.autoConvertPaidRequests || !flags.enabled || flags.dryRun || flags.relayOwner === 'none' ||
        !flags.actorUserId || !flags.initialOrderStatusCode || !flags.initialProductionStatusCode ||
        !this.config.isProductionInitializationReady() ||
        (input.widget ? !this.config.getPaymentWidget().enabled : !input.eventId || !input.lockToken)) {
      return { status: 'unchanged' };
    }
    return this.repository.autoConvertPaidCrmRequest({ ...input, actorUserId: flags.actorUserId,
      initialOrderStatusCode: flags.initialOrderStatusCode, initialProductionStatusCode: flags.initialProductionStatusCode });
  }
}
