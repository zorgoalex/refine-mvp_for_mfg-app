export interface OutboxPort {
  enqueue(input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
