import { describe, it, expect } from 'vitest';
import { hashPassword, comparePassword } from './password';

describe('Password Utilities', () => {
    it('should hash password correctly', async () => {
        const password = 'password123';
        const hash = await hashPassword(password);

        expect(hash).not.toBe(password);
        expect(hash).toHaveLength(60); // bcrypt hash length
    });

    it('should verify correct password', async () => {
        const password = 'password123';
        const hash = await hashPassword(password);
        const isValid = await comparePassword(password, hash);

        expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
        const password = 'password123';
        const hash = await hashPassword(password);
        const isValid = await comparePassword('wrongpassword', hash);

        expect(isValid).toBe(false);
    });
});
