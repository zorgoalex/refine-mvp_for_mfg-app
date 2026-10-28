// Turns an error into one printable line with every given secret removed. Playwright errors can carry
// call logs with request headers, so scripts that send a credential never print raw errors.
export function printableError(error, secrets = []) {
  const first = String(error?.message ?? error ?? 'error').split('\n')[0];
  let text = `${error?.name ?? 'Error'}: ${first}`;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, 300);
}
