import { z } from 'zod';
import { NAME_CONTROL_CHARACTERS } from './human-name';

export const humanName = (max: number, min = 1) => z.string()
  .refine(value => !NAME_CONTROL_CHARACTERS.test(value), 'Название не должно содержать управляющие символы')
  .trim().min(min).max(max);
