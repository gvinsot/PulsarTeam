/**
 * Context files of a task: repo-relative paths the user wants the executing
 * agent to read before starting. They are listed in the task prompt
 * (lib/taskTrust.ts taskContentForPrompt), so every runner sees them.
 */

export const MAX_CONTEXT_FILES = 20;
export const MAX_CONTEXT_FILE_PATH = 500;

/** Coerce any input into a clean, de-duplicated list of trimmed paths. */
export function normalizeContextFiles(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const p = item.trim().replace(/^\.\//, '').slice(0, MAX_CONTEXT_FILE_PATH);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= MAX_CONTEXT_FILES) break;
  }
  return out;
}

/** Prompt block listing the context files; empty string when there are none. */
export function contextFilesForPrompt(files: unknown): string {
  const list = normalizeContextFiles(files);
  if (!list.length) return '';
  return (
    `<task_context_files>\nRead these files first; they are part of the context of this task:\n` +
    list.map(f => `- ${f}`).join('\n') +
    `\n</task_context_files>`
  );
}
