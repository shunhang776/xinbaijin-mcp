# Phase 3-B: Real Review Shadow Smoke

> Status: smoke commit only
> Purpose: trigger the real-review-shadow workflow without modifying production logic

## Intent

This file exists solely to create a dev-branch commit that can be paired
with a subsequent `review.json` push, which triggers:

```text
push review.json to dev
  → baijin/real-review-shadow workflow
  → governance reusable-final-gate-shadow
  → expected-deny / expected-allow based on review.verdict
```

## What this is NOT

- NOT a production review
- NOT a modification to Worker, MCP tools, or business logic
- NOT a Required Check
- NOT a production final-gate

## Smoke path

1. This commit lands on `dev`
2. A ChatGPT review is generated on the dev branch (separate commit)
3. `review.json` is pushed to `dev`
4. `baijin/real-review-shadow` triggers on `paths: review.json`
5. Governance shadow evaluation runs
6. Result is observed, not enforced
