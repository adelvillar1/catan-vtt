# Plans

This directory holds **plan-as-contract** files. Each plan is a pre-work document describing what's about to be built, how we'll know it's done, and which contract docs need updating.

## Filename format

```
YYYY-MM-DD-<short-slug>.md
```

ISO date prefix is non-negotiable (self-sorting, doubles as identifier in recaps). Slug describes the *thing built*, kebab-case.

## Plan structure

Every plan follows `~/.hermes/skills/draft-feature-plan/templates/plan.md.template`. Required sections: frontmatter (`status`, `created`, `updated`, `slug`), Context, Approach, **Acceptance criteria** (checkbox list of single-sentence verifiable assertions — the contract), Files to be touched, Out of scope, Verification, Linked artifacts.

## Status lifecycle

`draft → active → completed` (or `abandoned`, with reason). What's in flight:

```bash
grep -l 'status: active' docs/plans/*.md
```

## How plans connect to recaps

Each recap references the plan(s) it touched by filename; finishing the last AC flips the plan to `completed`. Bidirectional grep links.

## Drafting

Use the `draft-feature-plan` skill / `/plan-feature`. Don't start implementation until the user approves the plan (Claude doesn't approve its own plans). AC changes mid-flight are deliberate and noted in recaps.

## Skip plans for

typos, single-line fixes, dependency bumps, pure refactors, hot fixes (write retroactive plan after).
