/**
 * Desktop app configuration. The desktop is a thin local Node host:
 *  - serves the built React frontend and PROXIES /api + /socket.io to the remote
 *    PulsarTeam platform (so the unchanged same-origin frontend just works);
 *  - runs the office-engine sidecar locally;
 *  - opens a reverse socket bridge to the platform so server-side agents can
 *    read/edit/generate files in the shared folder without the files leaving
 *    this machine.
 */
import os from 'os';
import path from 'path';

export const config = {
  /** Remote PulsarTeam platform (where the api + frontend live). */
  serverUrl: process.env.PULSAR_SERVER_URL || 'https://app.pulsarteam.local',

  /** Loopback port for the local server hosting the webview UI. 0 = ephemeral. */
  localPort: Number(process.env.PULSAR_LOCAL_PORT || 0),

  /** Office-engine sidecar: a bundled binary, or `python -m office_engine.mcp_server` in dev. */
  sidecar: {
    // Absolute path to the PyInstaller binary when packaged; falls back to the
    // dev python module invocation when unset.
    binary: process.env.OFFICE_ENGINE_BIN || '',
    devCommand: process.env.OFFICE_ENGINE_DEV_CMD || 'python -m office_engine.mcp_server',
    host: '127.0.0.1',
  },

  /** Where to write the per-machine settings (last shared folder, etc.). */
  stateFile: path.join(os.homedir(), '.pulsarteam-desktop', 'state.json'),

  /** Hard caps mirrored from the office-engine. */
  maxReadBytes: 25 * 1024 * 1024,

  /** Default subfolder destructive writes land in unless overwrite is explicit. */
  outputDirName: 'pulsar-output',
};
