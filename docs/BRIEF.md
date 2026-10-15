# crossfire — project brief

<!-- Canonical cross-project registry source (2026-07-09 plan §4.2).
     The KEY: value lines above the --- are lifted verbatim into the
     generated ~/projects/CLAUDE.md by projects-registry-gen. Keep each
     on ONE line, compact. Update when purpose/provides/claims change
     (retro-skill checklist). Body below --- is free-form. -->

PURPOSE: Local adversarial dual-LLM spec workshop: Fastify daemon pits claude and codex CLIs through independent analysis, debate, human interview, and consensus drafting to produce spec + plan markdown; React UI on :5173.
PROVIDES: adversarially-reviewed specs — the natural upstream of ralph-ng execution.
CONSUMES: claude + codex CLIs.
CLAIMS: port 5173; data/council.sqlite (legacy "council" naming).
CONFIDENTIALITY: personal.
HOOKS: dormant since 2026-04-28 — archive-or-resume decision open; the planned "RALPH loops" bridge to ralph-ng was never built; overlaps superpowers writing-plans (no documented when-to-use-which).

---

## Audit snapshot (2026-07-09, frozen)

STATUS: dormant — git repo, last commit 2026-04-28 (PR #2 merge, existing-spec review feature); clean working tree; local usage evidence through May 8 (data/council.sqlite, node_modules)
RAGNAROK: None. Only an incidental mention: a RAGNAROK MVP spec file path used as smoketest input in docs/superpowers/plans/2026-04-27-claude-spec-generation-mitigation.md:331.
BRIEF: Crossfire (/home/jenkins/projects/AI-WORKFLOWS/crossfire) is a local-only adversarial dual-LLM spec workshop: a pnpm/TypeScript monorepo where a Fastify daemon spawns the claude and codex CLIs and pits them through independent analysis, adversarial debate, a human interview, and consensus drafting to produce spec + implementation-plan markdown artifacts, with a React UI at localhost:5173; it can also review existing specs. It is complete and publicly blogged about but dormant since 2026-04-28, with a clean tree and rich design docs in docs/plans/ and docs/superpowers/. It has no repo-level agent bootstrapping (no CLAUDE.md/AGENTS.md/.claude) and no RAGNAROK integration beyond using a RAGNAROK spec as smoketest input. For other projects it matters as an upstream spec-generation stage: its output specs are natural input to ralph-ng/ultimate-agentic-workflow execution, and its "RALPH loops" future-work item signals an intended bridge to the ralph tooling. Legacy naming ("council" in env vars and the SQLite DB) persists from an earlier project name.
PAIN: No CLAUDE.md/AGENTS.md/.claude — future agent sessions start cold despite the repo being heavily agent-authored (docs/superpowers workflow artifacts exist) | Dormant since 2026-04-28; docs/plans/2026-03-18-implementation-status.md lists unfinished future work (e.g. RALPH loops) with no tracking since | Naming drift: code/env vars/DB still say 'council' (COUNCIL_ACCESS_TOKEN, data/council.sqlite) while the project is branded Crossfire — mildly confusing for tooling and docs | Docker path is explicitly experimental and fragile (CLI credential mounting, Codex OAuth expiry) — host-only is the real supported mode | Spec-workshop role overlaps conceptually with superpowers writing-plans/brainstorming and ralph planning; no documented decision on when to use which
CONNECTIONS: docs/plans/2026-03-18-implementation-status.md:104 — future-work item 'RALPH loops — recursive adversarial LLM planning with human checkpoints', name-overlap/synergy with the developer's ralph autonomous-coding tooling (init-ralph/ralph.toml) rather than a code dependency ;; docs/superpowers/plans/2026-04-27-claude-spec-generation-mitigation.md:331 — references /home/jenkins/projects/crossfire-preexist-smoketest/RAGNAROK-MVP_spec.md, i.e. a RAGNAROK spec was used as smoketest input for the existing-spec-review feature (mention only, no integration) ;; Potential synergy: Crossfire's spec outputs are exactly the input ralph-ng/ultimate-agentic-workflow expects (specs/ + plans), and second-brain could federate docs/plans artifacts into RAGNAROK
