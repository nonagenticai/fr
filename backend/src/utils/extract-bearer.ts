/**
 * Extract the raw Bearer token string from a Request's Authorization
 * header, or return null if there isn't one. Does NOT validate.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}
