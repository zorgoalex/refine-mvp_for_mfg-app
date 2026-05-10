import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgPaymentRepository } from './adapters/pg-payment-repository';
import { UnavailablePaymentRepository } from './adapters/unavailable-payment-repository';
import { PaymentService } from './application/payment.service';
import { PaymentsRuntimeConfigService } from './http/payments-runtime-config.service';
import { PaymentsController } from './http/payments.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsRuntimeConfigService,
    {
      provide: PaymentService,
      useFactory: (database: DatabaseService) =>
        new PaymentService({
          payments: database.isConfigured
            ? new PgPaymentRepository(database)
            : new UnavailablePaymentRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class PaymentsModule {}

