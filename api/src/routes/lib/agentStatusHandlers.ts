import { getUserBoardIdSet } from '../../lib/boardAccess.js';

/**
 * Agent-status handler builders shared by the user-scoped agent routes and the
 * unscoped swarm-leader routes (leaderTools).
 *
 * The board-scoping difference is deliberate, not accidental, but it is NOT
 * "scoped vs everyone":
 *
 *   scoped   — always passes the caller's accessible boards, admins included.
 *              This is what /api/agents/* uses, and an admin gets no extra
 *              visibility there.
 *   leader   — passes nothing for an ADMIN, so the agent manager's admin branch
 *              grants the whole-swarm view these routes exist for; passes the
 *              caller's boards for everyone else.
 *
 * The `leader` variant used to pass nothing for EVERY caller, which the agent
 * manager then read as "show all". Since /api/leader-tools is mounted behind
 * `authenticateToken` with no role gate (index.ts), that meant any authenticated
 * account could enumerate every agent of every tenant. Passing the board set for
 * non-admins is what closes that while leaving both the admin swarm view and the
 * non-admin leader's own boards intact.
 *
 * Express is 4.x: a sync throw reaches the error middleware but a rejected
 * promise in an async handler does NOT — every handler built here is async, so
 * the mount sites wrap them in asyncHandler.
 */

/**
 * Boards to scope a leader route by: none for an admin, the caller's own
 * otherwise. Takes the claims rather than the request so it needs no `any` —
 * a missing `req.user` throws here exactly as it did when this was inline.
 */
async function leaderBoardIds(user: {
  userId: string;
  role: string;
}): Promise<Set<string> | undefined> {
  return user.role === 'admin' ? undefined : await getUserBoardIdSet(user.userId);
}

function applyProjectFilter(statuses: any[], project: unknown): any[] {
  const lower = ((project as string) || '').toLowerCase();
  if (!lower) return statuses;
  return statuses.filter(s => (s.project || '').toLowerCase() === lower);
}

export const statusesHandler = (agentManager: any, scoped: boolean) =>
  scoped
    ? async (req: any, res: any) => {
        const boardIds = await getUserBoardIdSet(req.user.userId);
        const statuses = await agentManager.getAllStatuses(
          req.user.userId,
          req.user.role,
          boardIds
        );
        res.json(applyProjectFilter(statuses, req.query.project));
      }
    : async (req: any, res: any) => {
        const statuses = await agentManager.getAllStatuses(
          req.user.userId,
          req.user.role,
          await leaderBoardIds(req.user)
        );
        res.json(applyProjectFilter(statuses, req.query.project));
      };

export const swarmStatusHandler = (agentManager: any, scoped: boolean) =>
  scoped
    ? async (req: any, res: any) => {
        const boardIds = await getUserBoardIdSet(req.user.userId);
        res.json(await agentManager.getSwarmStatus(req.user.userId, req.user.role, boardIds));
      }
    : async (req: any, res: any) => {
        res.json(
          await agentManager.getSwarmStatus(
            req.user.userId,
            req.user.role,
            await leaderBoardIds(req.user)
          )
        );
      };

export const byProjectHandler = (agentManager: any, scoped: boolean) =>
  scoped
    ? async (req: any, res: any) => {
        const boardIds = await getUserBoardIdSet(req.user.userId);
        res.json(
          await agentManager.getAgentsByProject(
            req.params.project,
            req.user.userId,
            req.user.role,
            boardIds
          )
        );
      }
    : async (req: any, res: any) => {
        res.json(
          await agentManager.getAgentsByProject(
            req.params.project,
            req.user.userId,
            req.user.role,
            await leaderBoardIds(req.user)
          )
        );
      };

export const projectSummaryHandler = (agentManager: any, scoped: boolean) =>
  scoped
    ? async (req: any, res: any) => {
        const boardIds = await getUserBoardIdSet(req.user.userId);
        res.json(agentManager.getProjectSummary(req.user.userId, req.user.role, boardIds));
      }
    : async (req: any, res: any) => {
        res.json(
          agentManager.getProjectSummary(
            req.user.userId,
            req.user.role,
            await leaderBoardIds(req.user)
          )
        );
      };
