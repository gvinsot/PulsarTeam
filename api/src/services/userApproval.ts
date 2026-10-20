import { countPendingApprovalUsers } from './database.js';
import type { ApprovalStatus } from './database/users.js';
import { WsEvents } from '../ws/events.js';
import { errorMessage } from '../lib/errors.js';

/**
 * Admin approval of new OAuth accounts.
 *
 * A NEW account created by an OAuth login (Google, Microsoft, GitHub) starts
 * 'pending' and gets nothing — no session, no provisioned board — until an
 * admin approves it (routes/users.ts). Everything that mints or re-hands a
 * session (routes/authLogin.ts) asks `approvalRefusal` first.
 */

/** Socket.io room every admin socket joins at connect (ws/socketHandler.ts). */
export const ADMIN_ROOM = 'role:admin';

/** The slice of socket.io's `Server` this module emits through. */
export interface AdminSocketEmitter {
  to(room: string): { emit(event: string, data: unknown): unknown };
}

/** The 403 body a session refused for approval reasons answers with. */
export interface ApprovalRefusal {
  error: string;
  code: 'ACCOUNT_PENDING_APPROVAL' | 'ACCOUNT_REJECTED';
}

/**
 * Why `user` may not hold a session, or null when it may. Anything other than
 * an explicit 'approved' is refused: a row read without the column must fail
 * closed rather than let an unapproved account in.
 */
export function approvalRefusal(user: {
  approval_status?: ApprovalStatus | string | null;
}): ApprovalRefusal | null {
  if (user.approval_status === 'approved') return null;
  if (user.approval_status === 'rejected') {
    return {
      error: 'This account was declined by an administrator.',
      code: 'ACCOUNT_REJECTED',
    };
  }
  return {
    error: 'Your account has been created and is awaiting approval by an administrator.',
    code: 'ACCOUNT_PENDING_APPROVAL',
  };
}

/**
 * Tell connected admins how many accounts now wait for them. Only the count
 * travels, and only to the admin room — never an account's details, never to
 * anyone else. Best-effort: a failure here must not undo the change it reports.
 */
export async function emitPendingUsersCount(
  io: AdminSocketEmitter | null | undefined
): Promise<void> {
  if (!io) return;
  try {
    const count = await countPendingApprovalUsers();
    io.to(ADMIN_ROOM).emit(WsEvents.USERS_PENDING, { count });
  } catch (err) {
    console.error('[Auth] Failed to emit the pending users count:', errorMessage(err));
  }
}
