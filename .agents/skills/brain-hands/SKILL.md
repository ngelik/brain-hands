---
name: brain-hands
description: Run an approval-gated Brain, Hands, and Verifier workflow through brain-hands.
requires:
  codex_flow: "^0.5.1"
---

# Brain Hands

Use this skill when the user explicitly asks to create, change, fix, review, or
research a software project with “brain hands”, or invokes `$brain-hands`.
The skill is the conversational front door; `brain-hands` is the deterministic
engine and durable source of truth. The engine runs sequential
controller-managed Brain, Hands, and Verifier roles; nested agents and fan-out
are unavailable inside those roles. The default quality gate performs one Hands
self-review pass, configurable from `0` to `3`, and optional reflection is a
single Brain call.

Execute every engine command through the wrapper beside this file by replacing
the leading `brain-hands` in examples with
`node <skill-directory>/scripts/brain-hands.mjs`. Do not invoke the raw `brain-hands`
executable; the wrapper owns controller compatibility checks.

## Repository initialization gate

Apply this gate before interactive intake for every new task. Resolve the target
repository, then check whether `<repo>/.brain-hands/config.yaml` exists and can
be loaded by `brain-hands`. Do not invoke `brain-hands run` against an
uninitialized repository.

If the config is missing, tell the user that Brain Hands has not initialized
the repository and ask: “Should I run `brain-hands init --repo <repo>` first?”
Wait for explicit confirmation before running it. This initialization is
local-only and must not include `--github`. After it succeeds, show the result
and continue the normal interactive intake without asking the user to repeat
their task.

If the config exists but is invalid, stop and report the validation error. Do
not overwrite it or use `--force` without separate explicit authorization. If
the user directly requested the `init` command, that request itself authorizes
the matching local initialization and no additional confirmation is required.

## Configuration preview gate

Immediately after initialization validation and before any intake question,
invoke the wrapper beside this file as
`node <skill-directory>/scripts/brain-hands.mjs preview --repo <repo> --json`
(the forwarded CLI form is `brain-hands preview --repo <repo> --json`). Pass
only choices and model overrides the user already supplied: `--mode`,
`--research`/`--no-research`, `--reflection`/`--no-reflection`, and the matching
role-model flags. Do not infer or default a missing choice.

Parse the strict JSON response and display `rendered_preview` verbatim and in
full before any intake question. Never replace it with a shortened summary,
move fields to a later message, or reconstruct the preview from raw repository
configuration. The engine-owned preview must contain all of these fields:

- Repository and Initialized configuration path
- Controller package, version, and installed/development mode
- Mode, Research, and Reflection, with unresolved values marked pending
- Brain, Hands, and Verifier model, reasoning, sandbox, and configuration source
- Nested subagent status plus Hands self-review and Reflection phase reasoning
- Reflection protocol
- Hands backup, Hands fix attempts, Replan attempts, Review limit, and Quality gate
- GitHub remote and conditional GitHub effects

After displaying the preview, ask only the questions named by
`missing_choices`, in its canonical `mode`, `research`, `reflection` order and
using the exact wording below. If `missing_choices` is empty, ask no intake
questions and proceed to the resolved-intake confirmation. If a later answer or
model override changes a displayed value, invoke preview again and display the
complete updated `rendered_preview` before invoking `brain-hands run`.

## Interactive intake

Collect the task and repository from the conversation, then use only the
engine-returned `missing_choices` to select questions. Do not silently choose a
mode or optional behavior.

| Setting | Allowed values | Question when omitted |
| --- | --- | --- |
| Execution mode | `local` or `github` | “Should I run locally without GitHub, or use GitHub issues and one pull request?” |
| Research | `research` or `no-research` | “Should Brain use Codex’s built-in web research for this task?” |
| Reflection | `reflection` or `no-reflection` | “Should I produce a process reflection after the terminal outcome?” |

Models are optional. The preview resolves `brain`, `hands`, and `verifier` from
the repository config unless the user supplied an override. Do not ask the user
to pick a model when the preview already supplies one.

### Model request resolution

When the user names a role and gives a recognizable model tier instead of an
exact slug, pass that wording to the matching model override flag. The engine
resolves `Sol`, `flagship`, or `best` to `gpt-5.6-sol`; `Terra`, `balanced`, or
`everyday` to `gpt-5.6-terra`; `Luna`, `fast`, or `efficient` to
`gpt-5.6-luna`; `5.5` to `gpt-5.5`; and `5.5 Pro` to `gpt-5.5-pro`. Always
`Spark` or `Codex Spark` resolves to the text-only research-preview model
`gpt-5.3-codex-spark`, for which Brain Hands recommends `high` reasoning.
Always display the resulting full preview so the user sees the canonical slug
and effective reasoning effort before the run starts.

Do not infer which role an unscoped model request should change. Do not guess
when wording does not resolve to one deterministic built-in choice; report the
engine error and ask for the missing role or model distinction. The built-in
registry helps interpret the request, but `codex debug models` remains the
runtime authority for actual availability and supported reasoning efforts.

## Run protocol

1. Confirm the resolved intake and invoke the wrapper with `brain-hands run`,
   passing `--mode`, `--research`/`--no-research`, `--reflection`/`--no-reflection`,
   and any explicit model overrides. When research is enabled, use Codex’s
   built-in web research capability and preserve the returned source list in
   the Brain plan; do not substitute an untracked external research process.
   The wrapper requires a compatible installed `@ngelik/brain-hands` CLI. It
   never falls back to the checkout controller unless the operator explicitly
   supplies wrapper-only `--development-controller`; use that option only for
   checkout development, never for stable self-hosting validation.
   The command stops successfully at the first user boundary; this is an
   expected result, not a failed or incomplete wrapper invocation.
2. Drive the engine-owned discovery protocol one question at a time. Read the
   current pending action with `brain-hands status --run <run-dir> --json`,
   present its engine-authored question, approaches, or brief verbatim, and do
   not rewrite, combine, invent, answer, or skip it. Record only the user's
   response using the matching exact command:

   - `brain-hands answer-discovery --run <run-dir> --question <id>` reads the
     answer from standard input, or from `--input-file <path>`.
   - `brain-hands select-discovery-approach --run <run-dir> --revision <number>
     --approach <id>` records one displayed approach.
   - `brain-hands proceed-discovery --run <run-dir> --question <id>` reads guidance for named
     assumptions from standard input, or from `--input-file <path>`. The engine
     records a durable forced-proceed intent; Brain may not ask another question
     and must preserve the uncertainty as a linked proceed-sourced assumption
     whose statement contains the operator guidance.
   - `brain-hands revise-discovery --run <run-dir> --revision <number>` reads
     revision guidance from standard input, or from `--input-file <path>`.
   - `brain-hands approve-discovery --run <run-dir> --revision <number>` may be
     used only after displaying the exact brief revision and its recorded
     SHA-256. Silence or an unrelated reply is not approval.

   For a brief-approval action, take the brief verbatim from
   `pending_action.brief` and read its digest from the matching
   `manifest.json` `discovery.brief_revisions` record. Do not calculate a
   substitute digest over reformatted content.

   Brain may recommend discovery choices when the engine supplies a
   recommendation, but Brain never recommends approval of its own plan.

   Each mutating command stops at the next user boundary. Discovery remains
   local-only even in GitHub mode. `resume` is read-only at a discovery
   boundary: it displays the persisted pending action without invoking Brain or
   creating another revision. Initial discovery has a five-answer soft limit
   and six-answer hard limit; a planning gap permits its evidence-backed
   question and at most one adaptive follow-up. If an answer or revision request
   resembles a secret, the engine rejects it before ordinary persistence or
   model reuse; ask the user for a redacted response.
   Treat `pending_action.permitted_next_actions` as the exact command allowlist
   for the displayed boundary.
3. Discovery-brief approval and execution-plan approval are distinct
   approvals. After `approve-discovery` verifies and pins the exact brief
   revision and SHA-256, stop and ask for separate explicit plan approval by
   handling the plan boundary in this exact order:

   1. Read `brain-hands status --run <run-dir> --json`.
   2. Keep discovery `pending_action` separate from
      `plan_approval_request`; never combine the two boundary types. Use
      `plan_approval_request` only to detect and verify the pending boundary.
      Do not display, stringify, reorder, or summarize the JSON request.
   3. If `plan_approval_request` is present, immediately read the canonical
      human output with `brain-hands status --run <run-dir>`. This second
      observational read performs full request verification again. If it no
      longer contains the same revision and subject digest, stop and report the
      blocker.
   4. From that human output, display the exact contiguous engine-rendered plan
      approval block starting at `Approval required:` and ending at
      `Next command (approve-plan):`, verbatim and in full. Do not display the
      surrounding generic status fields.
   5. Ask for explicit approval of the request's exact plan revision and
      `approval_subject_sha256`. Silence, “looks good”, or an unrelated reply
      is not approval.
      If the user instead rejects the material replan, record their guidance with
      `brain-hands revise-plan --run <run-dir> --revision <revision> --actor <identity>`
      using standard input or `--input-file`, then resume the fresh controller-owned
      replan cycle. Never overwrite or delete the rejected immutable candidate.
   6. On explicit approval, invoke `brain-hands approve-plan --run <run-dir>
      --revision <revision> --follow`.
   7. If no request is pending and exact approval is already recorded, invoke
      `brain-hands resume --run <run-dir> --follow` without asking again.

   Initial plan approval authorizes the exact scope, commands, risks, external
   effects, and authority encoded in that revision. Material replan approval
   authorizes the exact proposed plan; its engine-rendered human status block
   uses a delta-first display. Never summarize a delta from model prose or
   reconstruct one from the patch.
4. Internal Hands retries and Verifier fixes inside the approved contract do
   not require a new plan approval. An identical same-run resume continues the
   exact recorded approval without asking again; cross-run approval
   carry-forward is unsupported.
5. Report progress from the ledger and Verifier evidence. Report the terminal
   assurance outcome (`verified_ready`, `human_accepted`, `blocked`, or
   `abandoned`) separately from delivery mechanics. A successful GitHub run also
   reports the pull-request URL. Brain approves
   delivery only when the Verifier evidence, attempt, and final review match.
   The workflow never merges automatically; GitHub merge remains a separate
   manual action.
   Use `--follow` on `run`, `approve-plan`, or `resume` for safe same-terminal
   progress, or attach with `brain-hands logs --follow --run <run-dir>`.
   Plain progress views coalesce heartbeat runs and duplicate unreadable
   progress warnings; `logs --json` remains lossless. `progress.jsonl` is
   normalized operator telemetry; progress is not approval and never replaces
   validated artifacts, Verifier evidence, or explicit plan revision approval.
   For new `bounded-context-v1` runs, expect immutable work-item summaries,
   Verifier/reflection evidence indexes, compact role context packages, and
   five resource-budget dimensions in `status --json`.
   In GitHub mode, issue comments and `brain-hands:*` labels are a best-effort
   public projection of that ledger: update only at durable state boundaries,
   never include logs, paths, prompts, secrets, or arbitrary model text, and
   retry failed projection work on resume without changing workflow truth.
6. If reflection was enabled, present the generated reflection after any
   terminal outcome. Reflection is an account of what worked, what was
   correct, failures, root causes, and improvements; it does not reopen the
   implementation loop.

## Reflection updates

For `--update-from-reflection`, pass the supplied JSON or Markdown artifact to
`brain-hands reflection --update-from-reflection <path> --repo <source-repo>`.
This is analysis-only: Brain writes a standalone improvement plan under
`.brain-hands/improvement-plans/<timestamp>/` and stops. Explain that the plan
must be implemented and tested in a separate task/thread; never invoke Hands
or modify the product repository in the current thread.

## Recovery

Use the engine-authored status and exact next command for an interrupted run.
Do not offer an interactive resume-versus-replacement menu when the engine state
determines the only permitted action. Preserve discovery approval and plan
approval as separate gates.

The same-run recovery order is:

1. inspect status/logs with `brain-hands status --run <run-dir>` and
   `brain-hands logs --run <run-dir> --follow`.
2. resume the existing run with `brain-hands resume --run <run-dir>`.
3. authorize one diagnostic retry when required with
   `brain-hands resume --run <run-dir> --actor <identity> --recovery-note-file <path>`.
4. attest an expected controller hash when required with
   `brain-hands recover-controller --run <run-dir> --actor <identity> --reason <reason> --expected-package-sha256 <sha256>`.
5. explicitly abandon only when same-run recovery is unsafe with
   `brain-hands abandon --run <run-dir> --actor <identity> --reason <reason>`.
6. replace only an abandoned run with
   `brain-hands replace --run <run-dir> --actor <identity> --reason <reason>`.
7. never use ordinary run for recovery; `brain-hands run` starts a new root run,
   not a recovery attempt.
8. never reuse approval or GitHub effects across replacement; a replacement
   successor has fresh approval, worktree, branch, issue, PR, risk, delivery,
   and final-artifact state.

At discovery boundaries, `resume` is read-only and returns the exact persisted
pending action; continue with one of the five discovery commands above. Legacy
runs without durable discovery metadata resume under their original workflow
contract.
After plan approval, same-run `resume` reuses the exact recorded subject and
does not ask for approval again. Cross-run approval carry-forward is
unsupported; start a new run with its own discovery and plan approvals instead.
Use `brain-hands logs --follow --run <run-dir>` to observe the safe append-only
`progress.jsonl` timeline during long model or verification calls. Progress is
not approval or workflow evidence: `events.jsonl`, the manifest, saved evidence,
and Verifier reviews remain authoritative. A five-minute activity gap is only
reported as possibly stale; never start another worker automatically.
Treat a blocked state, missing evidence, failed verification, or a capability
handshake failure as a blocker to report, not as permission to bypass approval.
An open pull request never restores `verified_ready` on its own. Use
`accept-risk --gate final-delivery --actor ... --reason ...` only for an explicit
human decision to accept the exact recorded evidence gap; never describe
`human_accepted` as verified. `abandon --actor ... --reason ...` is irreversible.
Treat `verified_ready`, `human_accepted`, `blocked`, and `abandoned` as separate
operator outcomes. Diagnostic authorization does not approve implementation; it
permits one exact retry only. Controller attestation does not approve
implementation; it permits continuation under the named controller hash only.
Keep the run ledger, worktree, evidence, and review artifacts linked in the
final response so the user can audit the result.
