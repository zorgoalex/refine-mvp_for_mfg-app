import type { DatabaseClient } from '../../../database/database.types';
import type { OutboxPort } from '../ports/outbox.port';

export class PgOutboxPort implements OutboxPort {
  constructor(private readonly database: DatabaseClient) {}

  async enqueue(input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(
      `
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json)
      VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload),
      ],
    );
  }
}
