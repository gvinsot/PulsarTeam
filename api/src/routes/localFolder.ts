import { Router } from 'express';
import { isDesktopConnected, getDesktopBridgeInfo } from '../ws/socketHandler.js';

/**
 * Local Folder connector status routes. Unlike OAuth/credential connectors there
 * is nothing to "connect" server-side — the link is the user's desktop app being
 * open and registered over the socket bridge. The frontend widget polls /status
 * (and live-updates on the BRIDGE_FOLDER_CHANGED socket event) to show whether
 * the desktop is online and which folder(s) it shared, with a download link
 * otherwise.
 */
export function localFolderRoutes(): Router {
  const router = Router();

  router.get('/status', (req, res) => {
    const userId = (req as any).user?.userId as string | undefined;
    if (!userId) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const info = getDesktopBridgeInfo(userId);
    res.json({
      connected: isDesktopConnected(userId),
      folders: info?.folders ?? [],
      registeredAt: info?.registeredAt ?? null,
      downloadUrl: process.env.DESKTOP_DOWNLOAD_URL || null,
    });
  });

  return router;
}
