import { describe, expect, it } from 'vitest';
import { currentRoundStageEvents } from './currentRoundStageEvents';

describe('currentRoundStageEvents («Переделка»: stage marks of the current round only)', () => {
  const events = [
    { event_id: 1, order_id: 10, production_status_id: 7, round_no: 1 }, // «Упакован» in round 1
    { event_id: 2, order_id: 10, production_status_id: 1, round_no: 2 }, // «Отрисован» in round 2
    { event_id: 3, order_id: 11, production_status_id: 7 }, // no round_no: round 1
    { event_id: 4, order_id: null, production_status_id: 3, round_no: 1 },
  ];

  it('takes the newest round of each order when the current round is not given', () => {
    expect(currentRoundStageEvents(events).map((e) => e.event_id)).toEqual([2, 3, 4]);
  });

  it('takes the given current round (a closed round stays current until the next one)', () => {
    expect(currentRoundStageEvents(events, new Map([[10, 1]])).map((e) => e.event_id)).toEqual([1, 3, 4]);
    expect(currentRoundStageEvents(events, (orderId) => (orderId === 10 ? 2 : null)).map((e) => e.event_id)).toEqual([2, 3, 4]);
  });
});
