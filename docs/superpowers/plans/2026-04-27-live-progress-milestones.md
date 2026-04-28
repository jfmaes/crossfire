# Live Progress Milestones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generic slow-run placeholders with concrete backend milestones in `Live Progress` and `Run Detail`, while leaving `Run History` unchanged.

**Architecture:** Introduce a small pure event-to-milestone normalization helper reused by both `ProgressFeed` and `RunDetail`. Keep backend APIs unchanged; derive headline and rolling milestone summaries entirely from existing persisted/SSE run events, with a pending-state fallback only when no real events exist yet.

**Tech Stack:** TypeScript, React, Vitest, Vite, existing REST/SSE run-event APIs, app CSS

---

### Task 1: Add Shared Milestone Derivation Helper

**Files:**
- Create: `apps/web/src/components/progress-milestones.ts`
- Create: `apps/web/src/components/progress-milestones.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `apps/web/src/components/progress-milestones.test.ts` with focused event normalization tests:

```tsx
import { describe, expect, it } from "vitest";
import { deriveMilestones } from "./progress-milestones";

describe("deriveMilestones", () => {
  it("turns material run events into concrete milestones", () => {
    const milestones = deriveMilestones([
      {
        id: "evt_1",
        type: "phase_start",
        phase: "analysis",
        message: "Phase 1: Dual Analysis (GPT + Claude in parallel)",
        createdAt: "2026-04-27T17:28:34.760Z"
      },
      {
        id: "evt_2",
        type: "model_done",
        model: "claude",
        phase: "analysis",
        elapsedMs: 176497,
        message: "Done in 176.5s — 10989 chars",
        createdAt: "2026-04-27T17:31:31.260Z"
      }
    ]);

    expect(milestones.map((m) => m.text)).toEqual([
      "Phase 1: Dual Analysis (GPT + Claude in parallel)",
      "Claude finished analysis in 2m 56s"
    ]);
  });

  it("filters noisy stream/progress chatter from the milestone list", () => {
    const milestones = deriveMilestones([
      {
        id: "evt_1",
        type: "model_stream",
        model: "gpt",
        phase: "analysis",
        message: "Reading additional input from stdin...",
        createdAt: "2026-04-27T17:28:35.000Z"
      },
      {
        id: "evt_2",
        type: "model_progress",
        model: "gpt",
        phase: "analysis",
        message: "Still working",
        createdAt: "2026-04-27T17:28:36.000Z"
      }
    ]);

    expect(milestones).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the helper test to verify it fails**

Run:

```bash
pnpm vitest run apps/web/src/components/progress-milestones.test.ts
```

Expected:
- FAIL because `progress-milestones.ts` does not exist yet.

- [ ] **Step 3: Implement the shared helper**

Create `apps/web/src/components/progress-milestones.ts` with a small pure API:

```ts
import type { ProgressEventMetadata, SessionRunEvent } from "../lib/api";

export interface ProgressMilestone {
  id: string;
  createdAt: string;
  model?: string;
  phase?: string | null;
  text: string;
}

function formatElapsed(ms?: number | null): string | null {
  if (typeof ms !== "number") return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}

function isMaterialMilestone(event: Pick<SessionRunEvent, "type">): boolean {
  return event.type === "phase_start"
    || event.type === "model_start"
    || event.type === "model_done"
    || event.type === "consensus"
    || event.type === "info";
}

function milestoneText(event: Pick<SessionRunEvent, "type" | "model" | "phase" | "message" | "elapsedMs">): string {
  if (event.type === "model_done" && event.model && event.phase) {
    const elapsed = formatElapsed(event.elapsedMs);
    const phase = event.phase.replaceAll("_", " ");
    return `${event.model.charAt(0).toUpperCase()}${event.model.slice(1)} finished ${phase}${elapsed ? ` in ${elapsed}` : ""}`;
  }

  if (event.type === "model_start" && event.model && event.phase) {
    const phase = event.phase.replaceAll("_", " ");
    return `${event.model.charAt(0).toUpperCase()}${event.model.slice(1)} started ${phase}`;
  }

  return event.message;
}

export function deriveMilestones(events: SessionRunEvent[]): ProgressMilestone[] {
  return events
    .filter(isMaterialMilestone)
    .map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      model: event.model ?? null ?? undefined,
      phase: event.phase ?? null,
      text: milestoneText(event)
    }));
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run:

```bash
pnpm vitest run apps/web/src/components/progress-milestones.test.ts
```

Expected:
- PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/progress-milestones.ts apps/web/src/components/progress-milestones.test.ts
git commit -m "feat: derive frontend progress milestones"
```

---

### Task 2: Wire Concrete Milestones Into Live Progress

**Files:**
- Modify: `apps/web/src/components/progress-feed.tsx`
- Modify: `apps/web/src/components/progress-feed.test.tsx`

- [ ] **Step 1: Extend the failing `ProgressFeed` tests**

Update `apps/web/src/components/progress-feed.test.tsx` to cover:

```tsx
it("renders the latest concrete milestone as the active headline when persisted events exist", async () => {
  getRunEventsMock.mockResolvedValue([
    {
      id: "evt_1",
      runId: "run_1",
      sessionId: "sess_1",
      type: "phase_start",
      phase: "analysis",
      message: "Phase 1: Dual Analysis (GPT + Claude in parallel)",
      createdAt: new Date().toISOString()
    },
    {
      id: "evt_2",
      runId: "run_1",
      sessionId: "sess_1",
      type: "model_done",
      model: "claude",
      phase: "analysis",
      elapsedMs: 176497,
      message: "Done in 176.5s — 10989 chars",
      createdAt: new Date().toISOString()
    }
  ]);

  render(<ProgressFeed sessionId="sess_1" runId="run_1" />);

  await waitFor(() => {
    expect(screen.getByText("Claude finished analysis in 2m 56s")).toBeTruthy();
  });
});

it("shows a rolling list of recent milestones under the active area", async () => {
  getRunEventsMock.mockResolvedValue([
    {
      id: "evt_1",
      runId: "run_1",
      sessionId: "sess_1",
      type: "phase_start",
      phase: "analysis",
      message: "Phase 1: Dual Analysis (GPT + Claude in parallel)",
      createdAt: new Date("2026-04-27T17:28:34.760Z").toISOString()
    },
    {
      id: "evt_2",
      runId: "run_1",
      sessionId: "sess_1",
      type: "model_done",
      model: "claude",
      phase: "analysis",
      elapsedMs: 176497,
      message: "Done in 176.5s — 10989 chars",
      createdAt: new Date("2026-04-27T17:31:31.260Z").toISOString()
    }
  ]);

  render(<ProgressFeed sessionId="sess_1" runId="run_1" />);

  await waitFor(() => {
    expect(screen.getByText("Recent milestones")).toBeTruthy();
  });

  expect(screen.getByText("Phase 1: Dual Analysis (GPT + Claude in parallel)")).toBeTruthy();
  expect(screen.getByText("Claude finished analysis in 2m 56s")).toBeTruthy();
});
```

- [ ] **Step 2: Run the component test to verify it fails**

Run:

```bash
pnpm vitest run apps/web/src/components/progress-feed.test.tsx
```

Expected:
- FAIL because `ProgressFeed` does not render milestone headline/list yet.

- [ ] **Step 3: Update `ProgressFeed`**

Import the helper and render milestone UI using persisted/live events:

```tsx
import { deriveMilestones } from "./progress-milestones";

const milestones = deriveMilestones(
  visibleEvents.map((event) => ({
    id: String(event.id),
    runId: event.runId ?? "",
    sessionId: event.sessionId,
    type: event.type,
    message: event.message,
    model: event.model ?? null,
    phase: event.phase ?? null,
    turnNumber: event.turnNumber ?? null,
    elapsedMs: event.elapsedMs ?? null,
    disagreements: event.disagreements ?? null,
    metadata: event.metadata ?? null,
    createdAt: new Date(event.receivedAt).toISOString()
  }))
);

const latestMilestone = milestones.at(-1) ?? null;
const recentMilestones = milestones.slice(-5).reverse();
```

Render:

```tsx
{latestMilestone && (
  <div className="progress-feed__milestone">
    <div className="progress-feed__milestone-title">{latestMilestone.text}</div>
  </div>
)}

{recentMilestones.length > 0 && (
  <div className="progress-feed__milestones">
    <div className="progress-feed__milestones-heading">Recent milestones</div>
    {recentMilestones.map((milestone) => (
      <div key={milestone.id} className="progress-feed__milestone-row">
        <span className="progress-feed__milestone-time">
          {new Date(milestone.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        {milestone.model && (
          <span className={`progress-feed__model progress-feed__model--${milestone.model}`}>
            {milestone.model.toUpperCase()}
          </span>
        )}
        <span className="progress-feed__milestone-text">{milestone.text}</span>
      </div>
    ))}
  </div>
)}
```

Keep the pending fallback only when `milestones.length === 0`.

- [ ] **Step 4: Re-run the component test**

Run:

```bash
pnpm vitest run apps/web/src/components/progress-feed.test.tsx
```

Expected:
- PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/progress-feed.tsx apps/web/src/components/progress-feed.test.tsx
git commit -m "feat: show concrete live progress milestones"
```

---

### Task 3: Add Recent Milestones Summary To Run Detail

**Files:**
- Modify: `apps/web/src/components/run-detail.tsx`
- Create: `apps/web/src/components/run-detail.test.tsx`

- [ ] **Step 1: Write the failing `RunDetail` test**

Create `apps/web/src/components/run-detail.test.tsx`:

```tsx
// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunDetail } from "./run-detail";

const { getRunEventsMock } = vi.hoisted(() => ({
  getRunEventsMock: vi.fn()
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual("../lib/api") as object;
  return {
    ...actual,
    getRunEvents: getRunEventsMock
  };
});

describe("RunDetail", () => {
  it("shows recent milestones above the raw event log", async () => {
    getRunEventsMock.mockResolvedValue([
      {
        id: "evt_1",
        runId: "run_1",
        sessionId: "sess_1",
        type: "phase_start",
        phase: "analysis",
        message: "Phase 1: Dual Analysis (GPT + Claude in parallel)",
        createdAt: new Date("2026-04-27T17:28:34.760Z").toISOString()
      },
      {
        id: "evt_2",
        runId: "run_1",
        sessionId: "sess_1",
        type: "model_done",
        model: "claude",
        phase: "analysis",
        elapsedMs: 176497,
        message: "Done in 176.5s — 10989 chars",
        createdAt: new Date("2026-04-27T17:31:31.260Z").toISOString()
      }
    ]);

    render(<RunDetail run={{
      id: "run_1",
      sessionId: "sess_1",
      kind: "create",
      status: "running",
      phase: "analysis",
      startedAt: new Date().toISOString()
    }} />);

    await waitFor(() => {
      expect(screen.getByText("Recent milestones")).toBeTruthy();
    });

    expect(screen.getByText("Claude finished analysis in 2m 56s")).toBeTruthy();
    expect(screen.getByText("Phase 1: Dual Analysis (GPT + Claude in parallel)")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm vitest run apps/web/src/components/run-detail.test.tsx
```

Expected:
- FAIL because `RunDetail` does not render milestone summary yet.

- [ ] **Step 3: Update `RunDetail`**

Reuse the helper:

```tsx
import { deriveMilestones } from "./progress-milestones";

const milestones = deriveMilestones(events);
const recentMilestones = milestones.slice(-5).reverse();
```

Render above `run-detail__events`:

```tsx
{recentMilestones.length > 0 && (
  <div className="run-detail__milestones">
    <h3 className="run-detail__milestones-heading">Recent milestones</h3>
    <div className="run-detail__milestones-list">
      {recentMilestones.map((milestone) => (
        <div key={milestone.id} className="run-detail__milestone-row">
          <span className="run-detail__milestone-time">
            {formatTimestamp(milestone.createdAt)}
          </span>
          {milestone.model && (
            <span className={`run-history__status run-history__status--${milestone.model}`}>
              {milestone.model.toUpperCase()}
            </span>
          )}
          <span className="run-detail__milestone-text">{milestone.text}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Re-run the test**

Run:

```bash
pnpm vitest run apps/web/src/components/run-detail.test.tsx
```

Expected:
- PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/run-detail.tsx apps/web/src/components/run-detail.test.tsx
git commit -m "feat: summarize recent run milestones"
```

---

### Task 4: Add Styles And Final Verification

**Files:**
- Modify: `apps/web/src/styles/app.css`
- Optionally modify: `apps/web/src/App.test.tsx` only if needed for render coverage

- [ ] **Step 1: Add milestone styles**

In `apps/web/src/styles/app.css`, add classes for:

```css
.progress-feed__milestone,
.progress-feed__milestones,
.run-detail__milestones {
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  background: var(--bg-surface);
}

.progress-feed__milestone {
  margin-bottom: 12px;
  padding: 12px 14px;
}

.progress-feed__milestone-title,
.run-detail__milestone-text {
  color: var(--ink);
  font-size: 0.88rem;
  line-height: 1.5;
}

.progress-feed__milestones,
.run-detail__milestones {
  margin-bottom: 12px;
  padding: 10px 12px;
}

.progress-feed__milestones-heading,
.run-detail__milestones-heading {
  margin: 0 0 8px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-secondary);
}

.progress-feed__milestone-row,
.run-detail__milestone-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  padding: 6px 0;
}

.progress-feed__milestone-time,
.run-detail__milestone-time {
  color: var(--muted);
  font-size: 0.72rem;
  flex-shrink: 0;
}
```

- [ ] **Step 2: Run focused frontend verification**

Run:

```bash
pnpm vitest run \
  apps/web/src/components/progress-milestones.test.ts \
  apps/web/src/components/progress-feed.test.tsx \
  apps/web/src/components/run-detail.test.tsx
```

Expected:
- PASS.

- [ ] **Step 3: Run broader safety verification**

Run:

```bash
pnpm vitest run \
  apps/web/src/components/progress-feed.test.tsx \
  apps/web/src/components/run-detail.test.tsx \
  apps/web/src/App.test.tsx
```

Expected:
- PASS.

- [ ] **Step 4: Run build**

Run:

```bash
pnpm build
```

Expected:
- PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/progress-milestones.ts apps/web/src/components/progress-milestones.test.ts apps/web/src/components/progress-feed.tsx apps/web/src/components/progress-feed.test.tsx apps/web/src/components/run-detail.tsx apps/web/src/components/run-detail.test.tsx apps/web/src/styles/app.css
git commit -m "feat: surface concrete run milestones in slow flows"
```
