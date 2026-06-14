import { getBoardsByUser } from '../services/database.js';

/**
 * Resolve the caller's accessible board IDs (own boards + shared boards),
 * swallowing errors to an empty set. The single canonical "visible boards"
 * resolution used by the agents/tasks routes.
 *
 * Returns a Set for membership checks; callers needing a SQL array spread it
 * via `[...ids]`.
 */
export async function getUserBoardIdSet(userId: string): Promise<Set<string>> {
  try {
    return new Set((await getBoardsByUser(userId)).map(b => b.id));
  } catch {
    return new Set();
  }
}
