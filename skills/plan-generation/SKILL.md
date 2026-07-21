---
name: plan-generation
description: Use when a plan is requested, a task involves multiple steps or file changes, steps have interdependencies, or verification is required. Generate structured, executable plans with measurable acceptance criteria, scope boundaries, and per-step verification.
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
3. **Immediately** mark it `[x]` in the plan file, adding implementation notes (details, deviations, assumptions).
4. Move to the next `[ ]` sub-step.
5. When all sub-steps in a step are `[x]`, run verification + commit.

### Discipline
- Mark each checkbox **right after completing that sub-step**, not at the end of the step.
- Add implementation details, deviations, and assumptions alongside the marked sub-step.
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

### 5. Documentation Update (when coding changes)

Include this section when the plan modifies source code, tests, config, or any non-doc file.

**When to update:**
- The plan modifies source code files
- The plan adds or changes tests
- The plan modifies configuration files
- The plan changes behavior or public APIs

**What to update:**
- README.md — usage, setup, or feature changes
- SKILL.md — skill description, parameters, or behavior changes
- API docs — new endpoints, changed signatures, new types
- Inline comments — complex logic, edge cases, non-obvious behavior
- Usage examples — new features, changed workflows, new patterns

**Format:**

```
### 5.x Update Documentation
- [ ] Update [file path]: [what changed]
- [ ] Update [file path]: [what changed]
- [ ] Verify docs build/compile without errors
```

**Scope boundary:** Do NOT update docs for purely refactoring changes that don't change behavior or public APIs.

### 6. Steps

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

### 7. Checkpoints

```
## Checkpoints

| After Step | Check | Gate |
|------------|-------|------|
| 1 | [verification] | All green before proceeding |
```

### 8. Final Verification

```
## Final Verification

- [ ] [primary verification] passes
- [ ] [secondary check] passes
- [ ] No unintended changes
- [ ] Git diff shows clean work
```

### 9. Meta (optional)

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
11. **Documentation follows code.** If a plan modifies source files, include a Documentation Update step listing every doc that needs changes.

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
| 16 | Plan instructs agent to add implementation notes | Missing from discipline section |
| 17 | Documentation updates included when coding changes exist | Plan modifies code but has no doc update step |

If any row fails, edit the plan and re-check. Do not present until all 17 pass.