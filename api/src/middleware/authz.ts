// ── Resource authorization (IDOR protection) ─────────────────────────────────
//
// Centralized helpers used by routes/{boards,projects,tasks,agents}.ts to
// verify that the authenticated user is allowed to read/edit/admin a board
// or a project. Without these checks an attacker who knows another tenant's
// resource id could read or modify it (Insecure Direct Object Reference).

import { getBoardById, getBoardShare, getProjectById, hasProjectBoardAccess } from '../services/database.js';

export type Permission = 'read' | 'edit' | 'admin';
const PERMISSION_LEVELS: Record<Permission, number> = { read: 0, edit: 1, admin: 2 };

export interface BoardAccessResult {
  ok: boolean;
  board?: any;
  permission?: Permission;
  isOwner?: boolean;
  status?: number;
  error?: string;
}

/**
 * Resolve effective access level a user has on a board.
 * - Default boards: readable by all authenticated users, admin-writable.
 * - Board owner: full admin access.
 * - System admin: full admin access.
 * - Otherwise: must have a board_share row with sufficient permission.
 */
export async function checkBoardAccess(
  boardId: string | undefined | null,
  userId: string,
  userRole: string,
  required: Permission = 'read'
): Promise<BoardAccessResult> {
  if (!boardId) return { ok: false, status: 400, error: 'boardId required' };
  const board = await getBoardById(boardId);
  if (!board) return { ok: false, status: 404, error: 'Board not found' };

  if (board.is_default) {
    const perm: Permission = userRole === 'admin' ? 'admin' : 'read';
    if (PERMISSION_LEVELS[perm] < PERMISSION_LEVELS[required]) {
      return { ok: false, status: 403, error: `Requires ${required} permission` };
    }
    return { ok: true, board, permission: perm, isOwner: false };
  }

  if (board.user_id === userId) {
    return { ok: true, board, permission: 'admin', isOwner: true };
  }

  if (userRole === 'admin') {
    return { ok: true, board, permission: 'admin', isOwner: false };
  }

  const share = await getBoardShare(boardId, userId);
  if (!share) return { ok: false, status: 403, error: 'Access denied' };

  const sharePerm = share.permission as Permission;
  if ((PERMISSION_LEVELS[sharePerm] ?? -1) < PERMISSION_LEVELS[required]) {
    return { ok: false, status: 403, error: `Requires ${required} permission` };
  }
  return { ok: true, board, permission: sharePerm, isOwner: false };
}

/**
 * Express middleware factory enforcing board access.
 * Reads the board id from req.params[paramName] (default 'id') with fallback
 * to req.query[paramName]. On success, attaches { board, permission, isOwner }
 * to req.boardAccess so the handler can reuse the loaded board without a
 * second DB round-trip.
 */
export function authorizeBoardAccess(
  required: Permission = 'read',
  paramName: string = 'id'
) {
  return async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const boardId = (req.params?.[paramName] || req.query?.[paramName]) as string;
    try {
      const access = await checkBoardAccess(boardId, req.user.userId, req.user.role, required);
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      req.boardAccess = { board: access.board, permission: access.permission, isOwner: access.isOwner };
      next();
    } catch (err: any) {
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

// Attached by authorizeBoardAccess so downstream handlers can reuse the loaded
// board without a second checkBoardAccess round-trip.
declare global {
  namespace Express {
    interface Request {
      boardAccess?: { board?: any; permission?: Permission; isOwner?: boolean };
    }
  }
}

export interface ProjectAccessResult {
  ok: boolean;
  project?: any;
  isOwner?: boolean;
  status?: number;
  error?: string;
}

/**
 * Resolve effective access on a project.
 * - Read: admin, project owner, or user with access to an attached board.
 * - Edit/admin: admin role OR project owner only.
 */
export async function checkProjectAccess(
  projectId: string | undefined | null,
  userId: string,
  userRole: string,
  required: Permission = 'read'
): Promise<ProjectAccessResult> {
  if (!projectId) return { ok: false, status: 400, error: 'projectId required' };
  const project = await getProjectById(projectId);
  if (!project) return { ok: false, status: 404, error: 'Project not found' };

  const isOwner = !!project.owner_id && project.owner_id === userId;

  if (userRole === 'admin') {
    return { ok: true, project, isOwner };
  }
  if (required === 'read') {
    const canRead = isOwner || await hasProjectBoardAccess(projectId, userId);
    if (canRead) return { ok: true, project, isOwner };
    return { ok: false, status: 403, error: 'Access denied' };
  }
  if (!isOwner) {
    return { ok: false, status: 403, error: 'You can only modify projects you created' };
  }
  return { ok: true, project, isOwner: true };
}

export function authorizeProjectAccess(
  required: Permission = 'read',
  paramName: string = 'id'
) {
  return async (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const projectId = (req.params?.[paramName] || req.query?.[paramName]) as string;
    try {
      const access = await checkProjectAccess(projectId, req.user.userId, req.user.role, required);
      if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
      req.projectAccess = { project: access.project, isOwner: access.isOwner };
      next();
    } catch (err: any) {
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}
