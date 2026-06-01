/**
 * Opaque cursor codec for public list endpoints.
 *
 * A cursor is base64url(JSON({ id, ts })) — a position, not an offset, so it is
 * stable across inserts and reordering (PRD: Cursor Pagination). Consumers treat
 * it as opaque; only the platform encodes/decodes it.
 */
export interface CursorPosition {
  id: string;
  ts: string; // ISO timestamp (created_at)
}

export function encodeCursor(pos: CursorPosition): string {
  return Buffer.from(JSON.stringify(pos), 'utf8').toString('base64url');
}

/** Decode a cursor; returns null for absent/garbage input (treated as "from start"). */
export function decodeCursor(cursor: string | undefined | null): CursorPosition | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed.id === 'string' && typeof parsed.ts === 'string') {
      return { id: parsed.id, ts: parsed.ts };
    }
    return null;
  } catch {
    return null;
  }
}
