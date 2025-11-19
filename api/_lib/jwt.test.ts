import { describe, it, expect } from 'vitest';
import { generateAccessToken, generateRefreshToken } from './jwt';
import jwt from 'jsonwebtoken';

describe('JWT Utilities', () => {
    describe('generateAccessToken', () => {
        it('should generate a valid JWT with correct claims', () => {
            const token = generateAccessToken('123', 'testuser', 'admin', ['admin', 'manager']);
            const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;

            expect(decoded.username).toBe('testuser');
            expect(decoded['https://hasura.io/jwt/claims']).toEqual({
                'x-hasura-allowed-roles': ['admin', 'manager'],
                'x-hasura-default-role': 'admin',
                'x-hasura-user-id': '123',
            });
        });

        it('should have 8 hour expiration', () => {
            const token = generateAccessToken('123', 'testuser', 'admin', ['admin']);
            const decoded = jwt.decode(token) as any;

            const now = Math.floor(Date.now() / 1000);
            // Allow small time difference (using -1 precision for approx check if needed, or just check difference)
            // 8 hours = 28800 seconds
            expect(decoded.exp - now).toBeCloseTo(8 * 60 * 60, -1);
        });
    });

    describe('generateRefreshToken', () => {
        it('should generate a valid refresh token', () => {
            const token = generateRefreshToken('123');
            const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as any;

            expect(decoded.sub).toBe('123');
        });

        it('should have 7 days expiration', () => {
            const token = generateRefreshToken('123');
            const decoded = jwt.decode(token) as any;

            const now = Math.floor(Date.now() / 1000);
            // 7 days = 604800 seconds
            expect(decoded.exp - now).toBeCloseTo(7 * 24 * 60 * 60, -1);
        });
    });
});
