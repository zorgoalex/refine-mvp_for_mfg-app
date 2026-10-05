export interface OutboxEventRecord {
  outboxEventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  /** Момент записи события (для отсечки устаревших событий, `maxEventAgeHours`). */
  createdAt?: string;
}
