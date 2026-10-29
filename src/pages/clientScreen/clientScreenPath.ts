/**
 * Address of the customer window. It is a page of its own (client-screen.html with its own entry),
 * not a route of the app: the main application never loads in that window, whatever the flags are.
 */
export const CLIENT_SCREEN_PATH = '/client-screen.html';

/**
 * The customer window runs only when the deployment's runtime config was read and it switches the
 * customer screen on. A config that could not be read is never replaced by a build-time default.
 */
export function clientScreenSwitchedOn(loadedConfig: unknown, flag: unknown): boolean {
  return loadedConfig !== null && loadedConfig !== undefined && flag === true;
}
