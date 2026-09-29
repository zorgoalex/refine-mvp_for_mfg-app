import { Injectable, Logger } from '@nestjs/common';

/** A run published the `warehouses` entity (status `done`); emitted only after its `complete` committed. */
export interface WarehousesPublished {
  sourceId: number;
  runId: string;
  requestId: string;
  correlationId: string;
}

type Listener = (event: WarehousesPublished) => Promise<void> | void;

/**
 * In-process signals of the ETL for business modules (plan E4: business modules subscribe,
 * the 1C module never depends on them). Delivery is best effort: a lost signal (restart
 * between commit and emit) is covered by the subscriber's own periodic pass.
 */
@Injectable()
export class OnecEtlEvents {
  private readonly logger = new Logger(OnecEtlEvents.name);
  private readonly warehouseListeners = new Set<Listener>();

  onWarehousesPublished(listener: Listener): () => void {
    this.warehouseListeners.add(listener);
    return () => this.warehouseListeners.delete(listener);
  }

  emitWarehousesPublished(event: WarehousesPublished): void {
    for (const listener of this.warehouseListeners) {
      // Never delays or fails the agent's complete response.
      void Promise.resolve()
        .then(() => listener(event))
        .catch((error: unknown) => this.logger.error(`warehouses listener failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
