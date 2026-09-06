// ─── Parsing helpers ─────────────────────────────────────────────────────────
import { getAccessibleBoardRepos } from '../database/boardRepos.js';

/** @this {import('./index.js').AgentManager} */
export const parsingMethods = {
  async _listAvailableProjects(this: any): Promise<string[]> {
    try {
      const repos = await getAccessibleBoardRepos(null, 'admin');
      return repos
        .map((r: any) => r.full_name)
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  },
};
