---
name: plans
description: Use when a plan is requested, a task involves multiple steps or file changes, steps have interdependencies, or verification is required. Generate structured, executable plans with measurable acceptance criteria, scope boundaries, and per-step verification. ALWAYS use when the user explicitly asks for a plan. When a task is multi-step or complex, default to using this skill rather than skipping it.
---

# Plan Generation

A structured methodology for producing plans that an agent can execute without human clarification. Every plan is a checklist: read, check off steps, commit, verify.

## Structure

Every plan has these sections:

### 1. How to Use This Plan (required)

Every plan must begin with a `## How to Use This Plan` section embedded **verbatim** from `templates/how-to-use.md` (read that file; paste its full content into the plan unchanged — do not paraphrase or trim).

**Must-contain:**
- `The shape of a plan` (step/action/box-state definitions; tool-agnostic completion check)
- Execution Discipline blockquote banner (after the shape block — discipline lands once the reader knows the structure)
- `Before You Start` (read the plan in full; first-reply statement of understanding + commitment before any tool call)
- `Execution Loop` (step-outer, action-inner; tick immediately after each action; covers Final Verification after the last step)
- `Editing the plan file` (smallest-safe-unit edits; single-line `oldText`)
- `Discipline` (unattended default — recoverable → `[assumption]`, no-valid-path incl. unlisted dependency → `[blocker]`; note format with `[assumption]:`/`[deviation]:` prefixes)
### 2. Goal (1 line)

```
## Goal
[What is being done] and [why it matters].
```

### 3. Dependencies

Simple list. No diagrams.

```
## Dependencies
- Step 1: independent
- Step 2 → Step 3 (Step 2 requires output from Step 3)
- Recommended order: 1 → 3 → 2
```

### 4. Assumptions & Open Questions (required)

Every ambiguity the agent could not resolve while writing the plan goes here as a row — nothing hidden in prose. Populated at generation; resolved during review.

```
## Assumptions & Open Questions

| # | Item | Agent's read | Status |
|---|------|--------------|--------|
| 1 | [ambiguous point] | [what the agent assumed or would choose] | `[open]` |

Statuses:
- `[open]` — needs a user decision
- `[assumption]` — user deferred it; implementation proceeds with "Agent's read"
- `[decision]` — user confirmed during review; binding, do not revisit in implementation
```

### 5. Inventory (table)

| # | Item | Current State | Problem | Fix |
|---|------|---------------|---------|-----|

One row per thing being changed. Problem and Fix must be specific.
Granularity: one row per *logical unit of change* (e.g. "auth middleware"
spanning 3 files = 1 row), not per file. Use the "Item" column for the logical
unit name; add file paths in the "Fix" column.

Slice shape: prefer *tracer-bullet vertical slices* — one row is a narrow but
complete end-to-end path through the relevant layers (e.g. data → logic → UI →
test), not a horizontal layer slice (all data first, then all logic, then all
UI). Each slice must be independently verifiable on its own. Wide refactors are
the exception — see "Wide refactors" in section 6.

### 6. Steps

Implementation plans start with the Baseline Pre-Check as Step 1 (section 7) — the only commit-exempt step; every other step ends in exactly one commit. Each step is a self-contained unit: a flat list of numbered actions, with no sub-task level between the step header and its actions. Number actions `N.1`, `N.2`, ... in order, so every checkbox line is unique by construction (Rule 17). The number of actions is whatever the step needs — the template below shows the common shape, not a fixed count. Mark checkboxes as you complete each action (see Discipline section for process):

```
## - [ ] Step N: [What] → [Result]

**Acceptance:** [measurable criteria]

**Scope:** [what NOT to do]
**Tick:** each action line is complete only when its line is `[x]` — mark it immediately after doing the work, before the next action. Batch-marking at step end is false progress.

### Actions

- [ ] N.1 [work action] — do the work
- [ ] N.2 [work action] — do the work   (repeat: one action per unit of work
      the step actually needs; numbering stays sequential, N.3, N.4, ...)
- [ ] N.k Verify: test suite passes (dynamic verification)
- [ ] N.k+1 Verify: type-check, lint, or project-equivalent clean
      (structural verification)
- [ ] N.k+2 Verify against the real artifact — run the behavior and inspect
      the diff, when this environment can execute it. Green tests and clean
      lint are proxies, not proof. If it can't run here (no docker, app
      server, database, or dependent services available), log
      `[assumption]: behavior not executed in this environment` and treat
      tests + lint as the verification.
- [ ] N.k+3 Commit: run `git add -A` and `git commit -m "[type](scope): [description]"`
      ↳ Don't forget to tick the action line you just finished, and the step
        header if all actions are completed.

**On verification failure:** Fix within the same step. Log `[deviation]:` +
what you did instead whenever the fix changes anything the step's actions
did not describe. Re-run the failed check. Only log `[blocker]` if the
failure makes subsequent steps impossible (not merely "my test is red").
```

**Wide refactors (exception to vertical slicing):** A single mechanical change
(rename a column, retype a shared symbol) whose blast radius spans the whole
codebase can't land green as one slice. Don't force it into a step — sequence
it expand–contract: (1) add the new form beside the old, (2) migrate call sites
in batches sized by blast radius (one commit each, old form still valid so
stays green), (3) delete the old form once no caller remains.

### 7. Baseline Pre-Check (required — as Step 1)

Every implementation plan carries the Baseline Pre-Check **as Step 1** — a commit-exempt step (its final action is `Commit: none`). It prevents failures introduced by the plan's own steps from being mistaken for pre-existing ones. The plan contains the step with empty `Output:` placeholders; the **executor** runs the commands as Step 1's actions, pastes results verbatim, and ticks each action — no Step 2 work happens until the baseline is recorded.

```
## - [ ] Step 1: Record baseline (git status + test + lint, verbatim)

**Acceptance:** all three `Output:` placeholders below are filled with
verbatim output from this session; `git status --porcelain` is empty or
every listed file is acknowledged in this step as intentionally dirty;
every test failure is individually identified (test name + error) and
labeled pre-existing.

**Scope:** Do NOT fix, adjust, or "clean up" anything in this step — record
only.
**Tick:** each action line is complete only when its line is `[x]` — mark it
immediately after doing the work, before the next action. Batch-marking at
step end is false progress.

### Actions

- [ ] 1.1 `git status --porcelain`
      Output:
      (paste verbatim, or "empty")
- [ ] 1.2 `<repo test script>` (e.g. `pnpm test` / `npm test`) — capture exact
      pass/fail counts; every failure individually identified (test name +
      error) and labeled pre-existing. If no test script is defined, record
      "no tests defined."
      Output:
      (paste summary + full failure list verbatim)
- [ ] 1.3 Lint, if the repo defines it (`eslint`/`biome`/lint script in
      package.json). If none is defined, record "no lint defined."
      Output:
      (paste verbatim)
- [ ] 1.4 Commit: none — baseline step records only; the tick + pasted output
      is the record.

Baseline rule for all later steps: a later step's test/lint run is compared
only against this recorded output. A new failure — or a failure count that
grows — is a regression to fix in the step that introduced it, not a
"pre-existing" line to wave through. A remembered count is not a baseline;
only the recorded output is.
```

### 8. Documentation Update step (when coding changes)

Include this as its own numbered `## - [ ] Step N:` within the Steps section, with a single closing commit (Rule 2), when the plan changes observable behavior, public APIs, or setup/usage.

**When to update:**
- The plan modifies source code that changes observable behavior or public APIs
- The plan adds or changes user-facing functionality
- The plan changes configuration that affects setup or usage

**When to skip:**
- Pure refactors with no behavior/API change
- Version bumps, lockfile updates, CI config tweaks
- Internal test-only changes

**What to update:**
- README.md — usage, setup, or feature changes
- SKILL.md — skill description, parameters, or behavior changes
- API docs — new endpoints, changed signatures, new types
- Inline comments — complex logic, edge cases, non-obvious behavior
- Usage examples — new features, changed workflows, new patterns

**Format** (standard §6 step shape; N is this step's number, actions numbered N.x):

```
## - [ ] Step N: Update documentation → docs reflect the change

**Acceptance:** every listed doc file updated; docs build/compile without errors.
**Scope:** doc updates only — do NOT rewrite docs for unchanged behavior.
**Tick:** each action line is complete only when its line is `[x]` — mark it
immediately after doing the work, before the next action.

### Actions

- [ ] N.1 Update [file path]: [what changed]
- [ ] N.2 Update [file path]: [what changed]
- [ ] N.3 Verify: docs build/compile without errors
- [ ] N.4 Commit: run `git add -A` and `git commit -m "docs(scope): [description]"`
```

**Scope boundary:** Do NOT update docs for purely refactoring changes that don't change behavior or public APIs.

### 9. Checkpoints

```
## Checkpoints

| After Step | Check | Gate |
|------------|-------|------|
| 1 | [verification] | No new failures vs the recorded baseline before proceeding |
```

### 10. Final Verification

Every plan ends with a `## Final Verification` section that re-verifies the Goal
from scratch on the final tree. It carries **plan-level** checks only (full-suite
baseline diff, repo-wide state, commit structure); per-step checks live in the
steps and are not repeated here. Its boxes are executed and ticked by the
Execution Loop (item 7) — Final Verification is a section, not a step, and
produces no commit.

```
## Final Verification

- [ ] [primary verification] passes
- [ ] [secondary check] passes
- [ ] Full test suite re-run; failure list diffed against the Baseline
      Pre-Check record — same pre-existing set, no new failures (never
      compared against a remembered count)
- [ ] No unintended changes
- [ ] Working tree clean (`git status --porcelain` empty) and the commit
      range since the baseline contains only this plan's commits — no
      unrelated files touched
```

**When a note in `~/.pi/agent/notes/` spawned the plan**, the note file is deleted at plan generation (Rule 14). Final Verification must include a residual confirmation (guards against a failed delete):

```
- [ ] Confirm source note `~/.pi/agent/notes/<source>.md` no longer exists
      (deleted at plan generation — the plan is the record; never "update the note" instead)
```

### 11. Meta (optional)

Free-form section for anything that doesn't fit elsewhere (estimated effort, links, risk notes). Must NOT duplicate sections that already have their own numbered heading — e.g. do not repeat a `## Dependencies` header here; use the section 3 Dependencies list.

```
## Estimated Effort
- Step 1: 30 min
```

### 12. Source Note Inheritance (when a plan is spawned from a note)

When a note in `~/.pi/agent/notes/` spawned the plan, the plan must carry the note's content so nothing is lost when the note is deleted:

```
## Source Note Inheritance

Source: ~/.pi/agent/notes/<note>.md

| Note item (finding / decision / context / next step) | Carried into |
|---|---|
| [item] | Inventory row N / Assumption #N / Step N.x / retained here (background only) |
```

- **Exhaustive:** every entry in the note's Context, Notes (findings/decisions), and Next Steps needs a row — mapped to a concrete plan location, or explicitly "retained here" for background-only content. Nothing is dropped silently.
- **Deleted at generation:** build the mapping, re-read the note file, confirm every item has a row — then delete the note. The plan is the sole record from that point on; there is no later delete step.

---

## Rules

1. **Checkboxes, not prose.** Every action is `- [ ]`. No paragraphs describing what to do.
2. **At most one commit per step.** Never batch commits across steps. The baseline step (Step 1) is the one zero-commit step; every other step ends in exactly one commit.
3. **Acceptance criteria are measurable.** Numbers, not vibes.
4. **Scope boundaries prevent creep.** State what NOT to do.
5. **Dependencies are explicit.** List them before the steps.
6. **No diagrams or visuals.** Simple list is enough.
7. **No arbitrary thresholds.** Use observations, not rules.
8. **Each step is self-contained.** Can be executed in isolation and verified.
9. **Inventory comes before steps.** Agent knows what it's working on before reading instructions.
10. **Verify before claiming.** Every step except Step 1 (baseline) ends with a verification command; the baseline step is itself the record and carries no verify.
11. **Documentation follows code.** If a plan changes observable behavior, public APIs, or setup/usage, include a Documentation Update step listing every doc that needs changes. Skip conditions per §8: pure refactors with no behavior/API change, version bumps, lockfile/CI tweaks, internal test-only changes.
12. **Never use /tmp.** Plans must be saved to `~/.pi/agent/plans/` — never to `/tmp` or any other transient directory. The file is named <goal-slug>.md — the kebab-case slug of the Goal (defined in the Workflow, step 2).
13. **Never guess dates.** The current date is not in your context — model-recalled dates are fabricated. Before embedding any date in a plan, run `date +%F` and use its output.
14. **Source notes are inherited, then die.** If a note in `~/.pi/agent/notes/` spawned the plan, the plan must include a Source Note Inheritance section mapping every finding/decision/context item/next step to a plan location. The note file is deleted at generation — after the mapping is built and verified exhaustive against the note (re-read it; every item must have a row). From that point the plan is the sole record. Never "update the note" instead.
15. **Handoff path.** After creating a plan file, the last line of the reply must be the
    plan's absolute path (expand `~`), on its own line. A short label prefix (e.g. "Plan:")
    is acceptable; surrounding prose is not. Multiple paths → one per line:
    plan paths first, then paths of any notes created in the same reply
    (a source note that spawned a plan is deleted at generation per Rule 14
    and is never listed).
16. **Baseline as Step 1.** As specified in §7: commit-exempt step, results
    recorded verbatim in its `Output:` placeholders before any other step's
    work begins; later steps diff failures only against that recorded
    baseline — a new failure, or a growing count, is a regression owned by
    the step that introduced it. A remembered count is never a baseline.
17. **Checkbox lines are unique.** Every checkbox line in a generated plan
    must be textually unique within the file — numbering actions `N.x` makes
    this hold for step actions; unnumbered lines (Final Verification, How to
    Use This Plan) must be worded so they stay distinct — so a single-line
    `oldText` is always sufficient.

---

## Anti-Patterns

| Anti-Pattern | Why It Fails |
|--------------|--------------|
| Diagrams and visuals | Agent can't parse them, adds noise |
| Vague acceptance ("works") | Not measurable, agent can't verify |
| One commit for multiple steps | Violates commit discipline |
| Hidden dependencies | Agent picks wrong order |
| Prose paragraphs instead of checkboxes | Agent can't track completion |
| Undefined terms ("large", "better") | Agent guesses the threshold |
| Steps that modify shared state without ordering | Agent creates conflicts |
| No scope boundaries | Agent does extra work, scope creep |
| Acceptance criteria requiring human judgment | Agent can't self-verify |
| Missing doc updates for coding changes | Docs go stale, users can't follow the code |
| "Update the note (status → Planned)" instead of deleting it | Notes are ephemeral — the plan supersedes them; a status field keeps a dead artifact alive |
| Batching multiple review questions into one message | The user can't answer iteratively and the turn-by-turn decision trail collapses; each item gets its own turn, with the user's own multi-answer replies as the only allowed batching (observed: agent front-loaded items as "trivial" despite the one-at-a-time instruction) |
| Counting failures from memory ("5 pre-existing, unrelated") | A failure introduced by the plan's own step gets miscounted as pre-existing and ships (henyo-pi-web 4.2.0: a self-inflicted ENOENT was waved through as "pre-existing"). Diff the failure list against the recorded baseline, never against a remembered count |
| Editing the plan mid-review Q&A | Feedback gathered item-by-item applies as one coherent revision only after the full pass — interleaving edits churns the plan and loses the decision rationale (Review Flow: gather first, update once) |
| Batch-marking a step's sub-steps at step end | An interrupt loses all progress and `[assumption]`/`[deviation]` logs vanish into one end-of-step blob; the plan no longer reflects actual state. Tick each sub-step immediately after doing it |

---

## Execution

### When to Use This Skill

- User asks for a plan
- Task involves multiple steps or file changes
- Steps have dependencies between them
- Verification is required before proceeding

### When NOT to Use This Skill

- Single-step tasks (just do it)
- Exploration/research without a clear goal
- Simple questions that don't require planning

### Workflow in pi

1. **Read the codebase** — understand current state before writing the plan
2. **Write the plan** — use the structure above, save to `~/.pi/agent/plans/<goal-slug>.md` (expand `~` to the absolute home path), where <goal-slug> is the kebab-case slug of the Goal line (lowercase words joined by hyphens), e.g. the Goal "Fix auth token expiry" → fix-auth-token-expiry.md. If a note in `~/.pi/agent/notes/` spawned this plan, the plan must include the Source Note Inheritance section (section 12) and the note file is deleted at generation after the mapping is verified (rule 14).
3. **Self-review** — check the plan against every rule and anti-pattern below
4. **Fix issues** — edit the plan until all checks pass
5. **Present for review** — show the plan to the user; if the user asks to review it, run the Review Flow below (two-phase: all feedback gathered before any plan edit)
6. **Execute** — follow the plan, check off steps, commit after each one
7. **Verify** — run final verification, confirm all acceptance criteria met

### Self-Review Checklist

After writing the plan, run through this checklist. Fix any failures before presenting.

| # | Check | Fix If... |
|---|-------|-----------|
| 1 | Rule 1 — checkboxes not prose | Prose paragraphs describe what to do |
| 2 | Rule 2 — at most one commit per step | Multiple steps share one commit, or a step batches more than one commit |
| 3 | Rule 3 — measurable acceptance | Criteria say "works" or "passes" without counts (acceptance lines only; the Verify sub-steps — "Test suite passes" / "Static checks pass" — are exempt, no counts required there) |
| 4 | Rule 4 — scope boundaries | Any step lacks "Do NOT..." |
| 5 | Rule 5 — dependencies explicit | Dependencies appear after steps or not at all |
| 6 | Rule 6 — no diagrams | ASCII art, flowcharts, or images |
| 7 | Rule 7 — no arbitrary thresholds | Line counts used as rules, not observations |
| 8 | Rule 8 — steps self-contained | A step depends on another without stating it |
| 9 | Rule 9 — inventory before steps | Steps appear before the inventory table |
| 10 | Rule 10 — verify before claiming | Any step other than Step 1 lacks verify + commit actions |
| 11 | Undefined terms are defined | Words like "large", "better" appear without context |
| 12 | No duplicate sections | Same section appears twice |
| 13 | Every ambiguity surfaced in Assumptions & Open Questions | Ambiguity silently baked into a step |
| 14 | Plan instructs agent to mark checkboxes | Missing "How to Use This Plan" section |
| 15 | Plan tells agent to be deliberate | Missing discipline reminder ("One action at a time — discipline over momentum") |
| 16 | Plan instructs agent to add implementation notes | Missing from discipline section |
| 17 | Plan has prominent discipline banner after the shape block | Missing "Execution Discipline" blockquote, or placed before the shape block |
| 18 | Rule 11 — documentation follows code | Plan changes behavior/API/usage without a doc update step, or includes one despite a §8 skip condition applying |
| 19 | Rule 12 — never use /tmp | Plan was written to `/tmp` or another transient location instead of `~/.pi/agent/plans/` |
| 20 | Plan documents assumption logging | Discipline section lacks the `[assumption]`/`[deviation]` prefix convention |
| 21 | Assumptions & Open Questions section present | Ambiguities hidden in prose/steps instead of the table |
| 22 | Unattended rule in embedded instructions | Template still says "if told to proceed without asking" |
| 23 | Out-of-plan dependency rule in embedded instructions | Template lacks the "deps beyond the plan's list are `[blocker]`s" line |
| 24 | Plan generated from a note includes the Source Note Inheritance section with exhaustive mapping | A note spawned the plan but a finding/decision/next step has no inheritance row (verify against the note file before deleting it) |
| 25 | Note file deleted at generation (Rule 14) | Note file still exists after plan generation, or the mapping was not verified against the note before deletion |
| 26 | Rule 16 — baseline as Step 1 (commit-exempt) | Missing, or a later step could compare failures against a remembered count instead of the recorded baseline |
| 27 | Every step header includes a **Tick:** one-liner reminding the executor to mark each action `[x]` immediately, and a `### Actions` heading separates the metadata from the action list | Any step lacks the per-step tick reminder or the `### Actions` heading |
| 28 | Goal section present with a single-line purpose + why-it-matters | Missing or multi-line |
| 29 | Checkpoints table present with at least one row | Missing (at least one gate required) |
| 30 | Final Verification section present with baseline-diff check | Missing, or it repeats checks that already exist in a step's actions |
| 31 | Rule 17 — checkbox lines unique | Two lines are identical → single-line edit becomes ambiguous |
| 32 | Rule 13 — no fabricated dates | Plan contains a date not taken from a `date +%F` run in this session |
| 33 | Rule 15 — handoff path | Final reply does not end with the plan's absolute path on its own line |

### Review Flow (when the user asks to review a plan)

Plan review resolves the Assumptions & Open Questions table — it is the decision phase; the plan itself was the async inspection pass. Two phases; no plan edits during Phase 1.

**Definitions**
- **Open item** — a decision not yet made (`[open]` row).
- **Assumption** — a decision made without user confirmation (`[assumption]` row).

**Phase 1 — Interactive Q&A (gather only, no plan edits)**
1. State the review objective up front: what decision this review resolves and the
   closure condition — every `[open]` row answered and every `[assumption]` row
   either confirmed or explicitly deferred. One pass per item; once the user
   answers, the item is settled and is not re-litigated.
2. Surface the Assumptions & Open Questions rows **one per turn**: present a
   single item, then **wait for the user's reply** before surfacing the next.
   Order: `[open]` items first, then `[assumption]` rows; binding decisions
   and blockers before trivial items. This applies to every item — no
   agent-side batching, including of items the agent judges trivial.
   The user MAY answer several items in one reply; treat that as settled and
   continue with the remaining unanswered items. Never front-load.
3. Each prompt: the item + minimal context to judge it + one clear question +
   the agent's recommended default. Never paste walls of plan text.
4. Record every answer in the reply (a review log), not in the plan file.

**Phase 2 — Single consolidated update (after all answers are collected)**
1. Apply every answer to the plan in one pass — do not interleave edits with
   the Q&A.
2. Update the Assumptions & Open Questions statuses: user-confirmed row →
   `[decision]`; user-deferred row → `[assumption]`.
3. Record each decision with its rationale next to the affected row or step;
   note what was deferred.
4. Re-run the Self-Review Checklist on the updated plan, then hand off the
   plan path (Rule 15).

If any row fails, edit the plan and re-check. Do not present until all 33 pass.