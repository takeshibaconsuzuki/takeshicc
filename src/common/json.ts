// A plain JSON object: not null, not an array. The shape both the Claude
// hook receiver (server side) and the settings merger (extension side)
// validate before indexing into an external payload.
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
