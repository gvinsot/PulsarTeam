import { getProjectById } from './database.js';
import { errorMessage } from '../lib/errors.js';

/**
 * The rules of the project a task belongs to (board → project), formatted as a
 * prompt section. Read from the DB every time a task prompt is built, so an
 * edit applies to the very next run without touching the agent. The rules are
 * written by the tenant, so callers place them outside the untrusted-content
 * wrapper even for an external task. Returns '' when the task has no project,
 * the project has no rules, or the project cannot be read.
 */
export async function projectRulesSection(task: {
  id: string;
  projectId?: string | null;
}): Promise<string> {
  if (!task.projectId) return '';
  let project;
  try {
    project = await getProjectById(task.projectId);
  } catch (err) {
    console.warn(
      `[ProjectRules] rules unavailable for task ${task.id} (project ${task.projectId}): ${errorMessage(err)}`
    );
    return '';
  }
  const rules = project?.rules?.trim();
  if (!project || !rules) return '';
  return `\nProject rules (${project.name}) — follow them for this task:\n${rules}\n`;
}
