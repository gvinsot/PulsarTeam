// Pure helpers behind the admin "Pending users" tab — kept out of the component
// so the approve / reject flows can be unit-tested without a DOM.

import { errorMessage } from '../../utils/errors';
import { safeImageDataUrl } from '../../utils/safeImage';
import type { LoginProvider, PendingUser, ShowToastFn, UserRole } from '../../types';

export const PROVIDER_LABELS: Record<LoginProvider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  github: 'GitHub',
};

/** Roles an admin can grant on approval; the server defaults to 'advanced'. */
export const APPROVAL_ROLES: { value: UserRole; label: string }[] = [
  { value: 'basic', label: 'Basic' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'admin', label: 'Admin' },
];

export const DEFAULT_APPROVAL_ROLE: UserRole = 'advanced';

export function pendingUserLabel(user: PendingUser): string {
  return user.displayName || user.username;
}

/**
 * An avatar `src` that is safe to render, or null. Provider avatars are https
 * URLs (Google/GitHub) or a base64 data: URI (Microsoft photo); anything else —
 * including a data: URI of a non-raster type — is dropped.
 */
export function pendingUserAvatarSrc(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('https://')) return url;
  if (url.startsWith('data:')) return safeImageDataUrl({ preview: url });
  return null;
}

/** The list without the given user (after an approval / rejection). */
export function withoutPendingUser(users: PendingUser[], id: string): PendingUser[] {
  return users.filter(u => u.id !== id);
}

/**
 * - 'done': the action went through.
 * - 'stale': the user is no longer pending (404 unknown / 409 not pending) —
 *   another admin got there first; the row should leave the list all the same.
 * - 'failed': any other error (already toasted).
 * - 'cancelled': the admin dismissed the confirmation.
 */
export type PendingActionOutcome = 'done' | 'stale' | 'failed' | 'cancelled';

export interface PendingUserActionDeps {
  approveUser: (id: string, role?: UserRole) => Promise<unknown>;
  rejectUser: (id: string) => Promise<unknown>;
  confirm: (message: string) => boolean;
  showToast?: ShowToastFn;
}

function errorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object' || !('status' in err)) return undefined;
  return typeof err.status === 'number' ? err.status : undefined;
}

function settleFailure(
  err: unknown,
  verb: string,
  user: PendingUser,
  showToast?: ShowToastFn
): PendingActionOutcome {
  const status = errorStatus(err);
  if (status === 404 || status === 409) {
    showToast?.(`${pendingUserLabel(user)} is no longer awaiting approval.`, 'info');
    return 'stale';
  }
  showToast?.(`Failed to ${verb} ${pendingUserLabel(user)}: ${errorMessage(err)}`, 'error');
  return 'failed';
}

export async function approvePendingUser(
  deps: PendingUserActionDeps,
  user: PendingUser,
  role: UserRole = DEFAULT_APPROVAL_ROLE
): Promise<PendingActionOutcome> {
  try {
    await deps.approveUser(user.id, role);
  } catch (err) {
    return settleFailure(err, 'approve', user, deps.showToast);
  }
  deps.showToast?.(`${pendingUserLabel(user)} approved as ${role}`, 'success');
  return 'done';
}

export async function rejectPendingUser(
  deps: PendingUserActionDeps,
  user: PendingUser
): Promise<PendingActionOutcome> {
  if (
    !deps.confirm(
      `Decline the access request of "${pendingUserLabel(user)}"? They will not be able to sign in.`
    )
  ) {
    return 'cancelled';
  }
  try {
    await deps.rejectUser(user.id);
  } catch (err) {
    return settleFailure(err, 'decline', user, deps.showToast);
  }
  deps.showToast?.(`Access request of ${pendingUserLabel(user)} declined`, 'success');
  return 'done';
}
