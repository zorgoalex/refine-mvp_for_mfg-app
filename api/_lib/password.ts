import bcrypt from 'bcryptjs';

/**
 * Сравнивает пароль в открытом виде с bcrypt хэшем
 * @param plainPassword - Пароль в открытом виде
 * @param hash - bcrypt хэш из БД
 * @returns true если пароль совпадает
 */
export async function comparePassword(
  plainPassword: string,
  hash: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(plainPassword, hash);
  } catch (error) {
    console.error('Password comparison failed:', error);
    return false;
  }
}

/**
 * Хэширует пароль используя bcrypt (cost factor 10)
 * Используется для создания новых пользователей
 * @param plainPassword - Пароль в открытом виде
 * @returns bcrypt хэш
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plainPassword, salt);
}
