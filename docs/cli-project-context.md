# CLI repository context

An agent has three independent context surfaces: API conversation history,
the runner's active working directory, and the live CLI process in tmux.
Changing only `agent.project` does not change the CLI process's directory.

Repository preparation now follows these rules:

- `/projects/ensure` preserves existing branches, commits, index and working
  tree. Git synchronization is an explicit operation performed by the agent;
  preparation no longer fetches and resets a checkout.
- Previous repositories remain on disk so returning to a repository preserves
  unfinished work. `projects/.primary` selects the active repository. An empty
  selection means no repository, including after a runner restart.
- The runner prepares every requested checkout before selecting the new primary
  and closing the old terminal. Failed preparation retains the previous selection.
  Terminal creation and project preparation share a per-agent lock.
- Reattaching a surviving tmux session checks its initial directory. A session
  from another repository is replaced. Adding secondary repositories does not
  replace the primary terminal.
- Manual and bulk project updates await preparation and serialize per agent.
  Chat and workflow entry points wait for pending manual changes. API history
  switches after successful preparation, including task-driven changes.
- Interactive CLI task resumption receives the full task text: restored API
  history does not imply that a newly started CLI remembers that task.

The tradeoff is that archived working copies consume disk until explicitly
cleaned up. Automatic project selection does not delete them.

Regression coverage: `runner-service/tests/test_project_context.py`,
`runner-service/tests/test_pty_session.py`, and
`api/src/services/__tests__/projectContext.test.ts`.
