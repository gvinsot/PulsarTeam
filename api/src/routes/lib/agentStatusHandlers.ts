import { getUserBoardIdSet } from '../../lib/boardAccess.js';

/**
 * Agent-status handler builders shared by the user-scoped agent routes and the
 * unscoped swarm-leader routes (leaderTools).
 *
 * The board-scoping difference is deliberate, not accidental: the scoped
 * variants resolve and pass the caller's accessible boards; the unscoped
 * variants pass nothing so the agent manager falls back to "show all"
 * (admin-like) — leaders see the whole swarm (see getters.ts and
 * docs/API_REFERENCE.md /api/leader-tools).
 *
 * Express is 4.x: a sync throw reaches the error middleware but a rejected
 * promise in an async handler does NOT. The unscoped variant therefore stays a
 * plain sync handler (it has no await); only the scoped variant is async.
 */

function applyProjectFilter(statuses: any[], project: unknown): any[] {
  const lower = ((project as string) || '').toLowerCase();
  if (!lower) return statuses;
  return statuses.filter(s => (s.project || '').toLowerCase() === lower);
}

export const statusesHandler = (agentManager: any, scoped: boolean) => scoped
  ? async (req: any, res: any) => {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      const statuses = await agentManager.getAllStatuses(req.user.userId, req.user.role, boardIds);
      res.json(applyProjectFilter(statuses, req.query.project));
    }
  : async (req: any, res: any) => {
      const statuses = await agentManager.getAllStatuses(req.user.userId, req.user.role);
      res.json(applyProjectFilter(statuses, req.query.project));
    };

export const swarmStatusHandler = (agentManager: any, scoped: boolean) => scoped
  ? async (req: any, res: any) => {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      res.json(await agentManager.getSwarmStatus(req.user.userId, req.user.role, boardIds));
    }
  : async (req: any, res: any) => {
      res.json(await agentManager.getSwarmStatus(req.user.userId, req.user.role));
    };

export const byProjectHandler = (agentManager: any, scoped: boolean) => scoped
  ? async (req: any, res: any) => {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      res.json(await agentManager.getAgentsByProject(req.params.project, req.user.userId, req.user.role, boardIds));
    }
  : async (req: any, res: any) => {
      res.json(await agentManager.getAgentsByProject(req.params.project, req.user.userId, req.user.role));
    };

export const projectSummaryHandler = (agentManager: any, scoped: boolean) => scoped
  ? async (req: any, res: any) => {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      res.json(agentManager.getProjectSummary(req.user.userId, req.user.role, boardIds));
    }
  : (req: any, res: any) => {
      res.json(agentManager.getProjectSummary(req.user.userId, req.user.role));
    };
