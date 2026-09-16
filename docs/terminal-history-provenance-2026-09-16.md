# Shared terminal history: refuse unproven provenance

Task: `f4c39cea-df21-4c1f-8915-44582227507e`.
Source review: `1bc8c52aa54b09f778cb5c3d6f06e176887454ca`.

`_pane_lines()` used to return the same empty list for an empty pane and a failed
capture. `begin_history_capture()` then treated both as an empty valid baseline.
A later successful read could persist the entire previous task's pane in the
new task's history, even without a single new output byte.

The initial observation now has explicit states: not started, baseline failed,
and shared pane observed but provenance unverified. An empty successful capture
is distinct from an exception, a nonzero exit or an unavailable pane. A failed
initial observation cannot be upgraded by a later successful read in that run.

A successful baseline does not make line subtraction safe either. A shared TUI
can rewrap, repaint, scroll or restore an earlier task's text. Those bytes arrive
after the boundary and their lines can differ from the baseline. Neither the
pane difference nor a post-boundary byte slice establishes execution provenance.
Both raw-history paths are therefore removed. `history_output()` returns a fixed
diagnostic and never reads the shared pane again or falls back to its byte stream.
This deliberately omits raw terminal diagnostics, including apparently new text,
until a source tied to the execution is available.

The API also accepts only the fixed diagnostic notices. An older runner returning
ordinary confidential prose is treated as unverified output, even if credential
redaction would leave that prose unchanged. Only the safe diagnostic reaches
`task.history` and `task:updated`. Structured conversation messages, the current
injected prompt, and completion notes remain available; completion notes take
precedence and avoid the terminal request entirely. Concurrent task updates are
still re-read before saving the execution entry.

No terminal session is reset, no scrollback is cleared, and no administrator
input is changed. Interactive terminal access is unaffected. This change does
not retroactively rewrite existing history.

Regression coverage uses synthetic previous-ticket text only:

- Initial capture exception and nonzero exit, followed by a successful read of
  the old pane without new execution bytes.
- Empty baseline, changed line wrapping, restored old pane content and replayed
  post-boundary bytes (including scrollback eviction).
- Runner HTTP output, API history persistence and `task:updated` emission.
- Legacy raw runner responses, safe diagnostics, and preserved completion notes.

Validation:

- Runner tests (excluding installed-CLI flag probes): 329 passed, 2 skipped after rebasing on `9ee4afb`.
- API suite with `CODE_SEARCH_VECTOR_BACKEND=memory`: 788 passed. This uses the
  same vector backend configured by the API production Dockerfile.
- TypeScript typecheck and targeted ESLint checks passed.
- API build and full ESLint passed (existing warnings within the configured
  ceiling). Prettier passes for both changed TypeScript files. The global format
  check reports seven unchanged files: `agentScope.ts`, `schemas/tasks.ts`,
  `helpers/taskDbFake.ts`, `workflow.test.ts`, `agentManager/index.ts`,
  `llmProviders.ts`, and `taskRecurrence.ts`.
