// Narrows an unknown caught value to a human-readable string. `throw` can
// raise anything, so `err.message` is unsound without the instanceof guard.

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
