import { featureFlags } from '../../config/featureFlags';
import { initializeRuntimeConfig } from '../../config/runtimeConfig';
import { clientScreenSwitchedOn } from './clientScreenPath';
import { mountClientScreen } from './mountClientScreen';

/**
 * Entry of the customer window (client-screen.html). The only thing it asks the network for is the
 * runtime config, to learn whether the customer screen is switched on for this deployment. Without
 * a config that was actually read the window stays inert, whatever the build-time default is.
 */
async function start(): Promise<void> {
  let config: unknown = null;
  try {
    config = await initializeRuntimeConfig();
  } catch {
    config = null;
  }
  mountClientScreen(document.getElementById('root') as HTMLElement, { enabled: clientScreenSwitchedOn(config, featureFlags.clientScreen) });
}

void start();
