import bcrypt from 'bcryptjs';
import type { PasswordVerifierPort } from '../auth.types';

export class BcryptPasswordVerifier implements PasswordVerifierPort {
  async verify(password: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(password, passwordHash);
  }
}
