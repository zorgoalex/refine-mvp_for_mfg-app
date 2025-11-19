import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit } from './rate-limit';

describe('Rate Limiter', () => {
    beforeEach(() => {
        // Reset internal state if possible, or use unique identifiers for each test
    });

    it('should allow requests within limit', () => {
        const id = 'test-ip-1';
        const config = { windowMs: 1000, max: 2 };

        expect(rateLimit(id, config).success).toBe(true);
        expect(rateLimit(id, config).success).toBe(true);
    });

    it('should block requests exceeding limit', () => {
        const id = 'test-ip-2';
        const config = { windowMs: 1000, max: 1 };

        expect(rateLimit(id, config).success).toBe(true);
        expect(rateLimit(id, config).success).toBe(false);
    });

    it('should reset after window expires', async () => {
        const id = 'test-ip-3';
        const config = { windowMs: 100, max: 1 };

        expect(rateLimit(id, config).success).toBe(true);
        expect(rateLimit(id, config).success).toBe(false);

        // Wait for window to expire
        await new Promise(resolve => setTimeout(resolve, 150));

        expect(rateLimit(id, config).success).toBe(true);
    });
});
