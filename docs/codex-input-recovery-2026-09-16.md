# Codex workflow input recovery — 2026-09-16

Task: `b8445096-a5e7-48e1-9e94-5d2b644190b8` (IM-HUM-005).
Affected CEO: `2f05bdaa-1451-43a4-b226-271ed656dcab`.

## Findings

The production logs for 06:59–07:20 UTC show a successful project clone and
intentional closure of the previous terminal at 07:03:55. They do not show a
failed repository switch. They do show these runner defects:

- Codex 0.154.0 renders `› Ask Codex to do anything`; the generic readiness
  recipe does not recognize it. Its placeholder remains visible while working,
  so `esc to interrupt` must veto readiness. A complete tmux pane is needed:
  partial redraws and a 4096-character tail can omit the busy footer or prompt.
- At 07:12:15.169, Stop interrupted the session while input was waiting. At
  07:12:15.584 the request nevertheless pasted the task and returned HTTP 200.
  Pending input had no cancellation tied to Stop.
- A local real-Codex reproduction left `/status` in the composer after a
  bracketed paste and Enter in one write at cold start. Sending the paste,
  waiting for the nonempty composer to render, then sending Enter directly
  to the targeted tmux pane submitted the command. Spacing raw PTY writes
  alone was not reliable in the expanded smoke suite. Both cold start and
  idle reuse pass with the corrected path. This reproduces
  a delivery failure consistent with the incident, but the historical logs do
  not record the actual bytes consumed, so they cannot prove this was the only
  cause of every failed attempt.

`PtySession.send_input` now owns serialized workflow submissions, readiness and
Stop cancellation. Codex timeouts and cancelled submissions return HTTP 409
without a blind fallback; closed sessions and failed writes return HTTP 503.
The runner verifies that Codex consumes the draft. If it remains unchanged,
only Enter is retried once; the task is never pasted twice. Short writes are
completed so the paste terminator is retained.
No prompt contents or authentication parameters are added to logs.

HTTP 200 acknowledges input delivery (and, for Codex, a confirmed empty
composer after submission), **not task completion**. Acceptance
still requires the executor's task update and actual deliverable evidence.
A Stop after the paste but before Enter cancels submission; the draft may remain
visible in the composer. No automatic retry should infer that it was executed.
The follow-up below makes this refusal enforceable in the runner.

## Residual draft ownership follow-up

Task: `2fb8d90d-a96a-4333-88b2-412b049642d3`.

Policy: **preserve the draft and return HTTP 409; never clear it automatically**.
An existing draft, including a multiline draft with an empty first line, blocks
workflow input. Readiness hints such as `? for shortcuts` do not override this.
The complete composer is read again immediately before the paste. Missing or
unrecognized composer evidence is a conflict, not permission to write.

The runner pastes once under an input epoch and checks the expected content
before Enter. A collapsed paste must have the expected character count and no
extra text; its provenance also requires an empty composer before the write and
no intervening broker input. Character count alone is not an ownership check.
All administrator WebSocket writes invalidate the epoch, including edits that
leave an identical visible draft. A fresh capture and epoch check precede every
Enter, including the single retry for a lost Enter. The final check and local
tmux send have no asynchronous yield between them. A changed draft after Enter
is a conflict, not successful delivery.

Once a paste may have been written, Stop, task cancellation, paste timeout,
failed/partial write, failed screen capture or unconfirmed submission leave the
session's automatic input quarantined. The latch is cleared only by confirmed
consumption of this injection. Even a temporarily empty/stale screen cannot
release it and admit a second task. Paste-only (`submit=false`) also leaves the
latch set. Raw administrator input remains available so the operator can inspect
and preserve their draft. To resume automatic tasks after an ambiguous delivery,
explicitly close/restart **that terminal**; this destroys its old composer. No
terminal is reset automatically. A Stop before any paste needs no restart.

These checks govern the runner's workflow and WebSocket input paths. Direct
out-of-band writes to the tmux server are outside the broker's input epoch.
No prompt or draft contents are added to logs or conflict messages.

Validation adds a stateful composer simulation (paste appends, Escape preserves,
Enter submits the entire draft) covering Stop → different task, late rendering
after timeout, administrator drafts and concurrent input, edits between capture
and Enter, lost/unconfirmed Enter, and clean resume. The opt-in real Codex smoke
uses a dedicated tmux socket and temporary directory, sends only `/status`,
checks residual-draft refusal, and closes only its own session before testing
clean restart. It never starts a model task or resets another agent.

Follow-up validation on Codex 0.154.0:
`CODEX_TERMINAL_SMOKE=1 RUNNER_TYPE=mock python -m pytest runner-service/tests -q
--ignore=runner-service/tests/test_cli_flag_compatibility.py` — **262 passed,
1 skipped**. The installed-CLI flag compatibility probes are outside this input
ownership change.

## Validation

- Unit, HTTP and real-PTY coverage includes current idle/busy frames, tall panes,
  capture failures, timeout without injection, Stop during readiness and during
  paste, queued cancellation, explicit resume, partial writes, UTF-8 and a
  60 KB payload including its final Enter.
- `RUNNER_TYPE=mock python -m pytest runner-service/tests -q
  --ignore=runner-service/tests/test_cli_flag_compatibility.py` with
  `CODEX_TERMINAL_SMOKE=1`: 246 passed, 1 skipped. The separate installed-CLI
  help probes are unrelated to this fix.
- `CODEX_TERMINAL_SMOKE=1 RUNNER_TYPE=mock python -m pytest
  runner-service/tests/test_codex_terminal_input.py -q` also exercises the
  installed Codex 0.154.0. The live smoke sends only `/status` in an isolated
  temporary tmux session; it does not start a model task.

## Production workflow evidence

These checks exercised the existing production deployment through the workflow
and API, with no terminal keystrokes and no reset of other agents. They establish
operational recovery; they do not establish deployment of this source change.

- Control `c2daf4c0-acad-47ef-8caa-92bfc4aea270`: created Todo, moved to
  In Progress, selected the CEO UUID above, calculated `17 × 23 = 391`, and
  moved itself to Done at 08:59:24 UTC.
- IM-SETUP-002 `115b661a-8a88-4133-a392-02f8b4f1ac69` was already Done.
  GitHub confirms commits `0156a5347b0e94174750342e994dac4150d8932b`,
  `2b31ac1176d600ea49188049183bcc5b485f55a3`, and
  `d4facb08ae2ec6d486d2c5daa66e4e0afe3b5685`. The task records Gmail acceptance
  IDs `1a0a91778f1ed8b2` (earlier preparation agent) and `1a0a91c0cc3663cf`
  (CEO). The duplicate is explicitly documented in the last commit; the setup
  and alert were not rerun as part of this recovery.
- IM-CEO-DAILY `76c60d29-5610-409b-959e-6f2cb3cb3a05`: launched through
  In Progress at 09:00:13 and completed by the CEO at 09:05:48 UTC. Published
  review: `direction/reunions/2026-09-16-76c60d29-5610-409b-959e-6f2cb3cb3a05.md`
  in `gvinsot/Intra-Muros`, remote commit
  `cdd6ce1218e7d23de2253778cd1ca818d225bff4`. Outcome explicitly degraded due
  to human access dependencies; no claim that those dependencies are resolved.
- Recurring rule `5e95626e-2083-45e5-9958-4c275336a309` enabled through the
  admin API: `intervalMinutes=1440`, `originalStatus=in_progress` (In Progress),
  `onOverlap=skip`, `historyRetentionDays=null`, `keepLastOccurrences=null`.
  Original card retained as occurrence 1 with its history. The template contains
  the original recurring instructions, without the first run's appended report.
- An extra occurrence was requested through the rule's `/run` API, without
  advancing the scheduled clock: `aeb11b2c-724b-4b3b-a9d9-d95d5b9396e0`,
  sequence 2. Both assignee and running executor were verified as the CEO UUID.
  It completed at 09:10:40 UTC with remote commit
  `4395c4ca9c8dd24814ce3764f9c3f30c7e461300`, a published review under its
  occurrence ID, and no new email (prior alert deduplicated). Both completed
  occurrences and their history remain accessible.
  Next scheduled run remains 2026-09-17 09:06:23 UTC; this is a schedule check,
  not a claim that a full 24-hour scheduler cycle has elapsed.

Production deployment requires the configured manual PulsarCD promotion gate.
Do not reset the instance or other agent sessions to validate this patch.
