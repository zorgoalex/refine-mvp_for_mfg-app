import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { DailyDigestFileStore } from '../daily-digest-file-store';

/**
 * PNG store of the broadcasts: a `broadcasts/` subdirectory of the digest volume with
 * its own lock and accounting. The legacy digest cleanup only touches files in the
 * volume root (`uuid-N.png`, `*.tmp`) and ignores subdirectories, so both stores share
 * the volume and an older backend never deletes broadcast images.
 */
@Injectable()
export class BroadcastFileStore extends DailyDigestFileStore {
  protected override storeRoot(volumeRoot: string): string {
    return join(volumeRoot, 'broadcasts');
  }

  protected override storeLockName(): string {
    return 'whatsapp-broadcast-store';
  }
}
