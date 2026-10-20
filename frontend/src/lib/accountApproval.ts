import type { AccountApprovalErrorCode } from '../types';

/**
 * Admin approval of new OAuth accounts, as seen from the sign-in side.
 *
 * A NEW account created through Google / Microsoft / GitHub sign-in starts
 * 'pending': the callback (and POST /auth/login, defence in depth) answers
 * 403 `{ error, code }` without setting a session cookie. That is not a failed
 * sign-in — the account exists and is waiting for an administrator — so the SPA
 * shows a notice instead of an error toast.
 */
export type AccountApprovalNotice = 'pending' | 'rejected';

const NOTICE_BY_CODE: Record<AccountApprovalErrorCode, AccountApprovalNotice> = {
  ACCOUNT_PENDING_APPROVAL: 'pending',
  ACCOUNT_REJECTED: 'rejected',
};

function isApprovalCode(code: unknown): code is AccountApprovalErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(NOTICE_BY_CODE, code);
}

/**
 * The notice a failed sign-in calls for, or null when it is an ordinary failure.
 *
 * Reads the `status` + `code` that api.ts's handleResponse attaches to a thrown
 * error. Both must match: a 403 carrying another code (or a code on another
 * status) is not an approval answer.
 */
export function accountApprovalNotice(err: unknown): AccountApprovalNotice | null {
  if (err === null || typeof err !== 'object') return null;
  const status = 'status' in err ? err.status : undefined;
  const code = 'code' in err ? err.code : undefined;
  if (status !== 403 || !isApprovalCode(code)) return null;
  return NOTICE_BY_CODE[code];
}
