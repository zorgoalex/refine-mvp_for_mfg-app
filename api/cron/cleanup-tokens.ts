import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hasuraAdminQuery } from '../_lib/db';
import { logger } from '../_lib/logger';

/**
 * GET /api/cron/cleanup-tokens
 * 
 * Cron job to clean up expired refresh tokens.
 * Should be scheduled to run daily.
 * 
 * Requires CRON_SECRET header for security.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Verify cron secret
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Call the database function to cleanup tokens
        const result = await hasuraAdminQuery<{ cleanup_expired_tokens: void }>(
            `
      mutation CleanupTokens {
        cleanup_expired_tokens
      }
      `
        );

        logger.info('Expired tokens cleaned up successfully');

        return res.status(200).json({
            success: true,
            message: 'Cleanup completed'
        });
    } catch (error) {
        logger.error('Failed to cleanup tokens', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
