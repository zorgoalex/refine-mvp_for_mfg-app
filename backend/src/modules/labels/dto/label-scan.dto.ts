import { z } from 'zod';

export const scanResolveSchema = z.object({
  payload: z.string().trim().min(1).max(2000),
  source: z.enum(['qr', 'manual']).optional().default('qr'),
});

export type ScanResolveInput = z.infer<typeof scanResolveSchema>;
