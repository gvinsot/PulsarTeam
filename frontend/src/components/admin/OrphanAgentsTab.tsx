import { useState, useEffect, useCallback } from 'react';
import { Bot, RefreshCw, UserCheck, UserX } from 'lucide-react';
import { api } from '../../api';
import { errorMessage } from '../../utils/errors';
import type { OrphanAgent, ShowToastFn, User } from '../../types';

interface OrphanAgentsTabProps {
  active: boolean;
  showToast?: ShowToastFn;
}

/** `name` is optional on the wire (same reason as Agent.name), so the id is the
 *  only label always available. */
function agentLabel(agent: OrphanAgent): string {
  return agent.name || agent.id;
}

function userLabel(user: User): string {
  return user.display_name || user.username;
}

/**
 * Why this agent is on the list, phrased for the admin reading the row.
 *
 * The discriminator is `ownerId`, NOT `ownerExists`: an agent carrying no owner
 * at all has nothing to resolve, so it reports `ownerExists: false` for a reason
 * that has nothing to do with a deleted user. Testing `ownerId` first keeps the
 * two cases apart whichever value the null-owner case happens to carry.
 */
function orphanReason(agent: OrphanAgent): { label: string; tone: string; detail: string } {
  if (agent.ownerId === null) {
    return {
      label: 'No owner',
      tone: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
      detail: 'The agent carries no owner at all.',
    };
  }
  if (!agent.ownerExists) {
    return {
      label: 'Owner deleted',
      tone: 'bg-red-500/10 border-red-500/30 text-red-400',
      detail: `Owner ${agent.ownerId} no longer exists.`,
    };
  }
  // Not reachable through the current route — it only lists agents with no board
  // and no reachable owner — but the shape allows it, so it renders rather than
  // falling through to a blank badge.
  return {
    label: 'Unowned board-less',
    tone: 'bg-dark-700 border-dark-600 text-dark-300',
    detail: `Owner ${agent.ownerId} exists but the agent is attached to no board.`,
  };
}

function formatCreatedAt(createdAt: string | undefined): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

/**
 * Admin-only reassignment screen for agents that belong to nobody.
 *
 * `active` flips true when the tab is selected; each activation re-fetches both
 * the orphan list and the user directory (the same GET /users UsersTab reads).
 * The component stays MOUNTED behind a CSS `hidden` like every other tab, so the
 * per-agent `<select>` values survive a tab round-trip.
 */
export default function OrphanAgentsTab({ active, showToast }: OrphanAgentsTabProps) {
  const [orphans, setOrphans] = useState<OrphanAgent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // agent id → the user id picked in that row's select, kept across re-fetches.
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const [orphanResponse, userList] = await Promise.all([api.getOrphanAgents(), api.getUsers()]);
      setOrphans(orphanResponse.agents);
      setUsers(userList);
    } catch (err) {
      const message = errorMessage(err);
      setLoadError(message);
      showToast?.(`Failed to load orphan agents: ${message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const handleAssign = async (agent: OrphanAgent) => {
    const ownerId = selection[agent.id];
    if (!ownerId) {
      showToast?.('Pick a user before reassigning.', 'error');
      return;
    }
    const owner = users.find(u => u.id === ownerId);
    try {
      setAssigningId(agent.id);
      const result = await api.setAgentOwner(agent.id, ownerId);
      const target = owner ? userLabel(owner) : ownerId;
      // `affected` is > 1 when the agent belongs to a batch: ownership is a
      // batch-shared field, so every member moves together. Say so rather than
      // let the admin believe one row changed.
      showToast?.(
        result.affected > 1
          ? `${agentLabel(agent)} and its ${result.affected - 1} batch sibling(s) reassigned to ${target}`
          : `${agentLabel(agent)} reassigned to ${target}`,
        'success'
      );
      setSelection(prev => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
      await load();
    } catch (err) {
      showToast?.(`Failed to reassign owner: ${errorMessage(err)}`, 'error');
    } finally {
      setAssigningId(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-dark-300 uppercase tracking-wider flex items-center gap-2">
          <UserX className="w-4 h-4" />
          Orphan Agents ({orphans.length})
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      ) : loadError ? (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
          <p className="text-sm text-red-400">Could not load orphan agents.</p>
          <p className="text-xs text-red-400/80 mt-1">{loadError}</p>
          <button
            onClick={load}
            className="mt-3 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-xs font-medium transition-colors"
          >
            Try again
          </button>
        </div>
      ) : orphans.length === 0 ? (
        // The nominal state: on a healthy install this is what an admin sees.
        <div className="text-center py-12">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <UserCheck className="w-6 h-6 text-emerald-400" />
          </div>
          <p className="text-sm text-dark-300">No orphan agents.</p>
          <p className="text-xs text-dark-500 mt-1">
            Every agent is attached to a board or to an existing owner — nothing to reassign.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {users.length === 0 && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-400">
              No users to assign these agents to. Create one in the Users tab first.
            </div>
          )}
          {orphans.map(agent => {
            const reason = orphanReason(agent);
            const created = formatCreatedAt(agent.createdAt);
            const busy = assigningId === agent.id;
            return (
              <div
                key={agent.id}
                className="p-4 bg-dark-800 rounded-xl border border-dark-700 hover:border-dark-600 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Bot className="w-4 h-4 text-dark-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-dark-100 truncate">
                        {agentLabel(agent)}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${reason.tone}`}>
                        {reason.label}
                      </span>
                    </div>
                    <p className="text-xs text-dark-400 mt-1.5">{reason.detail}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-dark-500 font-mono truncate">
                        {agent.id}
                      </span>
                      {created && (
                        <span className="text-[11px] text-dark-500">created {created}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <select
                      value={selection[agent.id] || ''}
                      onChange={e =>
                        setSelection(prev => ({ ...prev, [agent.id]: e.target.value }))
                      }
                      disabled={busy || users.length === 0}
                      className="px-3 py-2 bg-dark-900 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    >
                      <option value="">Select a user...</option>
                      {users.map(user => (
                        <option key={user.id} value={user.id}>
                          {userLabel(user)}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleAssign(agent)}
                      disabled={busy || !selection[agent.id]}
                      className="flex items-center gap-1 px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      {busy ? 'Assigning...' : 'Assign'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="p-4 bg-dark-800/50 rounded-xl border border-dark-700">
        <p className="text-xs text-dark-400">
          An agent is listed here when its owner cannot be resolved to a live user — either none was
          ever recorded, or the account it pointed at has been deleted. Board membership is not part
          of the test: a board-scoped agent is still reachable through its board, but its owner is
          what carries the OAuth credentials and the token accounting, so it needs a new one just as
          much. An agent with no board and no owner is hidden from every non-admin, and reassigning
          here is what makes it visible and usable again.
        </p>
      </div>
    </>
  );
}
