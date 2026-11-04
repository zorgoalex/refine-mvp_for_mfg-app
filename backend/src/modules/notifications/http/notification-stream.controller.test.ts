import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { NotificationStreamService } from '../application/notification-stream.service';
import { NotificationStreamController } from './notification-stream.controller';

function response() {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    ended: false,
    setHeader(name: string, value: string) { res.headers[name] = value; },
    status(code: number) { res.statusCode = code; return res; },
    end() { res.ended = true; },
    json(body: unknown) { res.body = body; },
  };
  return res;
}

const request = (user: unknown = { id: '7' }) => ({ user, accessTokenExpiresAt: new Date(Date.now() + 60_000) }) as unknown as RequestWithCurrentUser;

describe('GET /notifications/stream', () => {
  it('401 without a user (no stream opened)', () => {
    const open = vi.fn();
    const controller = new NotificationStreamController({ open } as unknown as NotificationStreamService);
    expect(() => controller.stream(request(null), response() as unknown as Response)).toThrow(/Authentication required/);
    expect(open).not.toHaveBeenCalled();
  });

  it('passes the token user and expiry; 204 when disabled; 429 with Retry-After over the limit', () => {
    const open = vi.fn().mockReturnValueOnce('disabled').mockReturnValueOnce('limited').mockReturnValueOnce('opened');
    const controller = new NotificationStreamController({ open } as unknown as NotificationStreamService);
    const req = request();

    const disabled = response();
    controller.stream(req, disabled as unknown as Response);
    expect(open).toHaveBeenCalledWith({ tokenUser: req.user, accessTokenExpiresAt: req.accessTokenExpiresAt, response: disabled });
    expect(disabled.statusCode).toBe(204);
    expect(disabled.ended).toBe(true);

    const limited = response();
    controller.stream(req, limited as unknown as Response);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['Retry-After']).toBe('30');
    expect(limited.body).toMatchObject({ error: { code: 'NOTIFICATION_STREAM_CONNECTION_LIMIT' } });

    const opened = response();
    controller.stream(req, opened as unknown as Response);
    expect(opened.statusCode).toBe(0); // the service wrote the SSE headers itself
  });
});
