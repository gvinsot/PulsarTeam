// ─── Parsing helpers ─────────────────────────────────────────────────────────
import { getAccessibleBoardRepos, getReposForBoards } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const parsingMethods = {
  /**
   * The project (repo) names a caller may be told about.
   *
   * `boardIds` is REQUIRED and has no default on purpose: this used to ask
   * getAccessibleBoardRepos(null, 'admin') — every repo on the instance — for
   * every agent that reached it, so the compiler now forces each call site to
   * name its scope. Agent call sites pass the agent's board scope
   * (lib/agentScope.ts getAgentBoardScope); `null` means "no scope to apply"
   * and is reserved for a human admin session (the voice console).
   */
  async _listAvailableProjects(this: any, boardIds: ReadonlySet<string> | null): Promise<string[]> {
    try {
      const repos = boardIds
        ? await getReposForBoards([...boardIds])
        : await getAccessibleBoardRepos(null, 'admin');
      return repos
        .map((r: any) => r.full_name)
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  },
};
