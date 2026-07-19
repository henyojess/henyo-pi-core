---
name: plan-generation
description: Generate structured, executable plans that an agent can follow end-to-end. Produces plans with measurable acceptance criteria, scope boundaries, dependency ordering, and per-step verification. Use whenever a plan is requested or when a task involves multiple steps, file changes, or dependencies.
---

# Plan Generation

A structured methodology for producing plans that an agent can execute without human clarification. Every plan is a checklist: read, check off steps, commit, verify.

## Structure

Every plan has these sections:

### 1. How to Use This Plan (required)

Instruct the agent how to execute the plan:

```
## How to Use This Plan

### Execution Loop (per sub-step)
1. Find the first unchecked `[ ]` sub-step in the current step.
2. Do the work described in that sub-step.
3. **Immediately** mark it `[x]` in the plan file.
4. Move to the next `[ ]` sub-step.
5. When all sub-steps in a step are `[x]`, run verification + commit.

### Discipline
- Mark each checkbox **right after completing that sub-step**, not at the end of the step.
- Do not batch-mark checkboxes. Each `[x]` is a record, not a pre-commitment.
- If a sub-step is unclear, stop and ask. Do not guess.
- One sub-step at a time. It is better to do one correctly than five poorly.
```
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

### 4. Inventory (table)

| # | Item | Current State | Problem | Fix |
|---|------|---------------|---------|-----|

One row per thing being changed. Problem and Fix must be specific.

### 5. Steps

Each step is a self-contained unit:

```
## - [ ] Step N: [What] → [Result]

**Acceptance:** [measurable criteria]

**Scope:** [what NOT to do]

### N.x [Sub-task]
- [ ] [action]
- [ ] [action]

### N.x Verify + commit
- [ ] [verification command] passes
- [ ] Run `git add` and `git commit -m "[type](scope): [description]"`
```

### 6. Checkpoints

```
## Checkpoints

| After Step | Check | Gate |
|------------|-------|------|
| 1 | [verification] | All green before proceeding |
```

### 6. Final Verification

```
## Final Verification

- [ ] [primary verification] passes
- [ ] [secondary check] passes
- [ ] No unintended changes
- [ ] Git diff shows clean work
```

### 7. Meta (optional)

```
## Dependencies
- No new external dependencies

## Estimated Effort
- Step 1: 30 min
```

---

## Rules

1. **Checkboxes, not prose.** Every action is `- [ ]`. No paragraphs describing what to do.
2. **One step, one commit.** Never batch commits across steps.
3. **Acceptance criteria are measurable.** Numbers, not vibes.
4. **Scope boundaries prevent creep.** State what NOT to do.
5. **Dependencies are explicit.** List them before the steps.
6. **No diagrams or visuals.** Simple list is enough.
7. **No arbitrary thresholds.** Use observations, not rules.
8. **Each step is self-contained.** Can be executed in isolation and verified.
9. **Inventory comes before steps.** Agent knows what it's working on before reading instructions.
10. **Verify before claiming.** Every step ends with a verification command.

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
2. **Write the plan** — use the structure above, save to `~/.pi/agent/plans/<name>.md`
3. **Self-review** — check the plan against every rule and anti-pattern below
4. **Fix issues** — edit the plan until all checks pass
5. **Present for review** — show the plan to the user
6. **Execute** — follow the plan, check off steps, commit after each one
7. **Verify** — run final verification, confirm all acceptance criteria met

### Self-Review Checklist

After writing the plan, run through this checklist. Fix any failures before presenting.

| # | Check | Fix If... |
|---|-------|-----------|
| 1 | Every action is a checkbox `- [ ]` | Prose paragraphs describe what to do |
| 2 | Each step has its own commit | Multiple steps share one commit |
| 3 | Acceptance criteria have numbers | Criteria say "works" or "passes" without counts |
| 4 | Every step has scope boundaries | Any step lacks "Do NOT..." |
| 5 | Dependencies are listed before steps | Dependencies appear after steps or not at all |
| 6 | No diagrams or visuals | ASCII art, flowcharts, or images |
| 7 | No arbitrary thresholds | Line counts used as rules, not observations |
| 8 | Steps are self-contained | A step depends on another without stating it |
| 9 | Inventory comes before steps | Steps appear before the inventory table |
| 10 | Every step ends with verification | Any step lacks a verify + commit subsection |
| 11 | Undefined terms are defined | Words like "large", "better", "fix" appear without context |
| 12 | No duplicate sections | Same section appears twice |
| 13 | Agent can execute without asking clarifying questions | Agent would need to guess line numbers, test structure, or file content |
| 14 | Plan instructs agent to mark checkboxes | Missing "How to Use This Plan" section |
| 15 | Plan tells agent to be deliberate | Missing discipline reminder ("do not rush", "be deliberate") |

If any row fails, edit the plan and re-check. Do not present until all 15 pass.