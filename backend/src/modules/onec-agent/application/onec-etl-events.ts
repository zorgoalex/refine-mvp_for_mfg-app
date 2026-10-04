import { Injectable, Logger } from '@nestjs/common';

/** A run published the `warehouses` entity (status `done`); emitted only after its `complete` committed. */
export interface WarehousesPublished {
  sourceId: number;
  runId: string;
  requestId: string;
  correlationId: string;
}

/** A run published these entities (status `done`, not revoked); emitted only after its `complete` committed. */
export interface EntitiesPublished {
  sourceId: number;
  runId: string;
  requestId: string;
  correlationId: string;
  entities: string[];
}

type Listener = (event: WarehousesPublished) => Promise<void> | void;
type EntitiesListener = (event: EntitiesPublished) => Promise<void> | void;

/**
 * In-process signals of the ETL for business modules (plan E4: business modules subscribe,
 * the 1C module never depends on them). Delivery is best effort: a lost signal (restart
 * between commit and emit) is covered by the subscriber's own periodic pass.
 */
@Injectable()
export class OnecEtlEvents {
  private readonly logger = new Logger(OnecEtlEvents.name);
  private readonly warehouseListeners = new Set<Listener>();
  private readonly entityListeners = new Set<EntitiesListener>();

  onEntitiesPublished(listener: EntitiesListener): () => void {
    this.entityListeners.add(listener);
    return () => this.entityListeners.delete(listener);
  }

  emitEntitiesPublished(event: EntitiesPublished): void {
    for (const listener of this.entityListeners) this.deliver(() => listener(event), 'entities');
  }

  onWarehousesPublished(listener: Listener): () => void {
    this.warehouseListeners.add(listener);
    return () => this.warehouseListeners.delete(listener);
  }

  emitWarehousesPublished(event: WarehousesPublished): void {
    for (const listener of this.warehouseListeners) this.deliver(() => listener(event), 'warehouses');
  }

  /** Never delays or fails the agent's complete response. */
  private deliver(call: () => Promise<void> | void, name: string): void {
    void Promise.resolve()
      .then(call)
      .catch((error: unknown) => this.logger.error(`${name} listener failed: ${error instanceof Error ? error.message : String(error)}`));
  }
}
