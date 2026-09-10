/** A frozen key can only identify an unchanged payload, including catalogue rows. */
export function orderSaveRetryKey(key: string | undefined, previousSignature: string | undefined,
  nextSignature: string, createKey: () => string): string {
  return key && previousSignature === nextSignature ? key : createKey();
}
