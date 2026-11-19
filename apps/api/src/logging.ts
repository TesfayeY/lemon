/**
 * Log-safe description of an error: its class name and machine-readable codes only.
 *
 * Error messages are never logged. Driver and storage messages can embed stored
 * values: a MongoDB duplicate-key message includes the key (for example a
 * Firebase UID), and filesystem errors include object paths with owner IDs.
 */
export function describeError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return `non-error thrown (${typeof err})`;

  const e = err as { name?: unknown; code?: unknown; codeName?: unknown };
  const parts = [safeToken(e.name) ?? 'Error'];
  const code = safeToken(e.code);
  if (code) parts.push(`code=${code}`);
  // MongoServerError: e.g. code=11000 codeName=DuplicateKey
  const codeName = safeToken(e.codeName);
  if (codeName) parts.push(`codeName=${codeName}`);
  return parts.join(' ');
}

// Names and codes are identifiers like `MongoServerError`, `11000`, `ENOENT` or `auth/id-token-expired`
const TOKEN = /^[A-Za-z0-9_./-]{1,64}$/;

function safeToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && TOKEN.test(value)) return value;
  return null;
}
