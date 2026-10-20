import { useState, useEffect, useCallback } from 'react';
import { UserPlus, Check, X, RefreshCw, Inbox } from 'lucide-react';
import { api } from '../../api';
import { errorMessage } from '../../utils/errors';
import {
  APPROVAL_ROLES,
  DEFAULT_APPROVAL_ROLE,
  PROVIDER_LABELS,
  approvePendingUser,
  pendingUserAvatarSrc,
  pendingUserLabel,
  rejectPendingUser,
  withoutPendingUser,
} from './pendingUsers';
import type { PendingActionOutcome } from './pendingUsers';
import type { PendingUser, ShowToastFn, UserRole } from '../../types';

interface PendingUsersTabProps {
  active: boolean;
  /** The live count (GET pending/count + 'users:pending' socket event). A change
   *  while the tab is shown means the queue moved, so the list is re-fetched. */
  pendingCount: number;
  showToast?: ShowToastFn;
  /** Called with the server's new count after an approval / rejection. */
  onCountChange?: (count: number) => void;
  /** Called after an approval / rejection so the Users tab can refresh. */
  onUsersChanged?: () => void;
}

function formatRequestedAt(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function Avatar({ user }: { user: PendingUser }) {
  const src = pendingUserAvatarSrc(user.avatarUrl);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        className="w-9 h-9 rounded-full object-cover flex-shrink-0 bg-dark-700"
      />
    );
  }
  return (
    <div className="w-9 h-9 rounded-full flex-shrink-0 bg-indigo-500/15 text-indigo-300 flex items-center justify-center text-sm font-semibold uppercase">
      {pendingUserLabel(user).charAt(0)}
    </div>
  );
}

/**
 * Admin approval queue: OAuth accounts created by a first sign-in, which get no
 * access until an admin approves them. Stays mounted behind a CSS `hidden` like
 * every other tab; `active` drives the re-fetch.
 */
export default function PendingUsersTab({
  active,
  pendingCount,
  showToast,
  onCountChange,
  onUsersChanged,
}: PendingUsersTabProps) {
  const [users, setUsers] = useState<PendingUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // user id → role picked in that row's select (default: advanced).
  const [roles, setRoles] = useState<Record<string, UserRole>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.getPendingUsers();
      setUsers(data.users);
      setLoaded(true);
    } catch (err) {
      const message = errorMessage(err);
      setLoadError(message);
      showToast?.(`Failed to load pending users: ${message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (active) load();
  }, [active, pendingCount, load]);

  const settle = (user: PendingUser, outcome: PendingActionOutcome) => {
    if (outcome !== 'done' && outcome !== 'stale') return;
    setUsers(prev => withoutPendingUser(prev, user.id));
    onUsersChanged?.();
    // The socket event carries the new count too; asking keeps the badge right
    // when the realtime connection is down.
    api
      .getPendingUsersCount()
      .then(data => onCountChange?.(data.count))
      .catch(() => {});
  };

  const deps = {
    approveUser: api.approveUser,
    rejectUser: api.rejectUser,
    confirm: (message: string) => window.confirm(message),
    showToast,
  };

  const handleApprove = async (user: PendingUser) => {
    setBusyId(user.id);
    try {
      settle(user, await approvePendingUser(deps, user, roles[user.id] || DEFAULT_APPROVAL_ROLE));
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (user: PendingUser) => {
    setBusyId(user.id);
    try {
      settle(user, await rejectPendingUser(deps, user));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-dark-300 uppercase tracking-wider flex items-center gap-2">
          <UserPlus className="w-4 h-4" />
          Pending users ({users.length})
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <p className="text-xs text-dark-400">
        Accounts created by a first sign-in with Google, Microsoft or GitHub. They have no access
        until approved.
      </p>

      {!loaded && loading ? (
        <div className="text-center py-8">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : !loaded && loadError ? (
        <div className="p-4 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl">
          {loadError}
        </div>
      ) : users.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-dark-400">
          <Inbox className="w-8 h-8 text-dark-500" />
          <p className="text-sm">No account is awaiting approval.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {users.map(user => {
            const busy = busyId === user.id;
            const label = pendingUserLabel(user);
            return (
              <div
                key={user.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-3 py-2.5 bg-dark-800 rounded-lg border border-dark-700"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar user={user} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-dark-100 truncate">{label}</span>
                      <span className="text-[10px] px-1 py-0.5 rounded bg-dark-700 border border-dark-600 text-dark-300 flex-shrink-0">
                        {user.provider ? PROVIDER_LABELS[user.provider] : 'Unknown provider'}
                      </span>
                    </div>
                    {label !== user.username && (
                      <div className="text-xs text-dark-400 truncate">{user.username}</div>
                    )}
                    <div className="text-[11px] text-dark-500">
                      Requested {formatRequestedAt(user.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <select
                    value={roles[user.id] || DEFAULT_APPROVAL_ROLE}
                    onChange={e => {
                      const role = APPROVAL_ROLES.find(r => r.value === e.target.value)?.value;
                      if (role) setRoles(prev => ({ ...prev, [user.id]: role }));
                    }}
                    disabled={busy}
                    className="px-2 py-1.5 bg-dark-900 border border-dark-600 rounded-lg text-xs text-dark-100 focus:outline-none focus:border-indigo-500"
                    title="Role granted on approval"
                  >
                    {APPROVAL_ROLES.map(r => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleApprove(user)}
                    disabled={busy}
                    className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(user)}
                    disabled={busy}
                    className="flex items-center gap-1 px-3 py-1.5 text-dark-300 hover:text-red-400 hover:bg-dark-700 border border-dark-600 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    <X className="w-3.5 h-3.5" />
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
