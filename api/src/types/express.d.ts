import type { SessionClaims } from '../middleware/session.js';

declare global {
  namespace Express {
    interface Request {
      // Populated by authenticateToken from the session cookie or a bearer
      // header. SessionClaims is the single definition of what a session
      // carries — including the per-session `csrf` secret.
      user?: SessionClaims;
    }
  }
}

export {};
