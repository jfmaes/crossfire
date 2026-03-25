import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createPhaseOrchestrator } from "./phase-orchestrator";

function createAnalysisProvider(name: "gpt" | "claude"): ProviderAdapter {
  return {
    name,
    async *sendTurn(_input: ProviderTurnInput) {
      const turn: ModelTurn = {
        actor: name,
        rawText: `${name} analysis of the problem`,
        summary: `${name} summary`,
        newInsights: [`${name} insight`],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [`${name} question for human`],
        proposedSpecDelta: "",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      };
      yield { type: "structured_turn", actor: name, turn } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

function createFailingProvider(name: "gpt" | "claude", message: string): ProviderAdapter {
  return {
    name,
    async *sendTurn(_input: ProviderTurnInput) {
      yield { type: "error", message } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

function createSilentProvider(name: "gpt" | "claude"): ProviderAdapter {
  return {
    name,
    async *sendTurn(_input: ProviderTurnInput) {
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

describe("createPhaseOrchestrator", () => {
  describe("runDualAnalysis", () => {
    it("runs GPT and Claude in parallel and collects proposed questions", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createAnalysisProvider("claude")
      });

      const result = await orchestrator.runDualAnalysis("s1", "Design a task manager");

      expect(result.gptAnalysis).toContain("gpt analysis");
      expect(result.claudeAnalysis).toContain("claude analysis");
      expect(result.proposedQuestions.length).toBeGreaterThan(0);
      expect(result.proposedQuestions.some((q) => q.proposedBy === "gpt")).toBe(true);
      expect(result.proposedQuestions.some((q) => q.proposedBy === "claude")).toBe(true);
    });
  });

  describe("runQuestionDebate", () => {
    it("produces synthesized questions from debate", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createAnalysisProvider("claude")
      });

      const result = await orchestrator.runQuestionDebate(
        "s1",
        "Design a task manager",
        "gpt analysis text",
        "claude analysis text",
        [
          { text: "What is scope?", priority: 1, rationale: "Bounds the project", proposedBy: "gpt" },
          { text: "What is the stack?", priority: 2, rationale: "Tech choice", proposedBy: "claude" }
        ]
      );

      expect(result.debateSummary).toBeTruthy();
      // The debate returns questions extracted from the structured turns
      expect(result.synthesizedQuestions).toBeDefined();
      expect(Array.isArray(result.synthesizedQuestions)).toBe(true);
    });
  });

  describe("runInterviewStep", () => {
    it("evaluates an answer and may produce follow-ups", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createAnalysisProvider("claude")
      });

      const result = await orchestrator.runInterviewStep(
        "s1",
        "Design a task manager",
        { text: "What is the scope?", rationale: "Defines boundaries" },
        "Web only, no mobile",
        []
      );

      expect(result.evaluation).toBeTruthy();
      expect(typeof result.sufficientContext).toBe("boolean");
      expect(Array.isArray(result.followUpQuestions)).toBe(true);
    });
  });

  describe("runApproachDebate", () => {
    it("runs a full debate round with interview context", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createAnalysisProvider("claude")
      });

      const result = await orchestrator.runApproachDebate(
        "s1",
        "Design a task manager",
        [{ question: "Scope?", answer: "Web only" }]
      );

      expect(result.convergedApproach).toBeTruthy();
      expect(result.turns.length).toBeGreaterThan(0);
    });
  });

  describe("runSpecGeneration", () => {
    it("drafts, reviews, walks through, and produces a spec", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createAnalysisProvider("claude")
      });

      const result = await orchestrator.runSpecGeneration(
        "s1",
        "Design a task manager",
        [{ question: "Scope?", answer: "Web only" }],
        "Use React + Node"
      );

      expect(result.spec).toBeTruthy();
      expect(result.summary).toBeTruthy();
      // walkthroughGaps should be present (empty array when no gaps found)
      expect(Array.isArray(result.walkthroughGaps)).toBe(true);
    });

    it("includes walkthrough gaps when models find operational issues", async () => {
      function createWalkthroughProvider(name: "gpt" | "claude"): ProviderAdapter {
        let callCount = 0;
        return {
          name,
          async *sendTurn(_input: ProviderTurnInput) {
            callCount++;
            // The walkthrough phase is the 2nd call for GPT, 3rd for Claude
            const isWalkthrough = (name === "gpt" && callCount === 2) || (name === "claude" && callCount === 3);
            const turn: ModelTurn = {
              actor: name,
              rawText: isWalkthrough
                ? `Found an operational gap in the spec`
                : `${name} spec output`,
              summary: `${name} summary`,
              newInsights: [],
              assumptions: [],
              disagreements: [],
              questionsForPeer: [],
              questionsForHuman: [],
              proposedSpecDelta: isWalkthrough ? "" : `${name} spec content`,
              milestoneReached: null,
              degraded: isWalkthrough
            };
            // For walkthrough turns, emit degraded JSON with walkthroughGaps
            if (isWalkthrough) {
              turn.rawText = JSON.stringify({
                actor: name,
                rawText: "Found operational gaps during walkthrough",
                summary: "Walkthrough found gaps",
                newInsights: [],
                assumptions: [],
              disagreements: [],
              questionsForPeer: [],
              questionsForHuman: [],
              proposedSpecDelta: "",
              milestoneReached: null,
              implementationPlan: null,
              proposedQuestions: null,
              synthesizedQuestions: null,
              followUpQuestions: null,
              sufficientContext: null,
              degraded: false,
              walkthroughGaps: [
                { location: "Section 3", issue: `${name}: token budget too small`, fix: "Increase to 40K" }
              ]
              });
              turn.degraded = true;
            }
            yield { type: "structured_turn", actor: name, turn } as const;
            yield { type: "done" } as const;
          },
          async healthCheck() {
            return { ok: true, detail: "ready" };
          }
        };
      }

      const orchestrator = createPhaseOrchestrator({
        gpt: createWalkthroughProvider("gpt"),
        claude: createWalkthroughProvider("claude")
      });

      const result = await orchestrator.runSpecGeneration(
        "s1",
        "Design a task manager",
        [{ question: "Scope?", answer: "Web only" }],
        "Use React + Node"
      );

      expect(result.walkthroughGaps).toBeDefined();
      expect(result.walkthroughGaps!.length).toBeGreaterThan(0);
    });

    it("preserves non-degraded phase-specific fields from provider turns", async () => {
      function createStructuredProvider(name: "gpt" | "claude"): ProviderAdapter {
        let callCount = 0;
        return {
          name,
          async *sendTurn(_input: ProviderTurnInput) {
            callCount++;

            const baseTurn: ModelTurn = {
              actor: name,
              rawText: `${name} output`,
              summary: `${name} summary`,
              newInsights: [],
              assumptions: [],
              disagreements: [],
              questionsForPeer: [],
              questionsForHuman: [],
              proposedSpecDelta: `${name} spec content`,
              milestoneReached: null,
              implementationPlan: null,
              proposedQuestions: null,
              synthesizedQuestions: null,
              followUpQuestions: null,
              sufficientContext: null,
              walkthroughGaps: null,
              degraded: false
            };

            if (callCount === 1 && name === "gpt") {
              yield {
                type: "structured_turn",
                actor: name,
                turn: {
                  ...baseTurn,
                  implementationPlan: "draft implementation plan"
                }
              } as const;
              yield { type: "done" } as const;
              return;
            }

            if (callCount === 1 && name === "claude") {
              yield {
                type: "structured_turn",
                actor: name,
                turn: {
                  ...baseTurn,
                  implementationPlan: "reviewed implementation plan"
                }
              } as const;
              yield { type: "done" } as const;
              return;
            }

            yield {
              type: "structured_turn",
              actor: name,
              turn: {
                ...baseTurn,
                rawText: `${name} walkthrough`,
                proposedSpecDelta: "",
                walkthroughGaps: [
                  {
                    location: `${name} section`,
                    issue: `${name} found a missing operational guardrail`,
                    fix: "Add an explicit guardrail"
                  }
                ]
              }
            } as const;
            yield { type: "done" } as const;
          },
          async healthCheck() {
            return { ok: true, detail: "ready" };
          }
        };
      }

      const orchestrator = createPhaseOrchestrator({
        gpt: createStructuredProvider("gpt"),
        claude: createStructuredProvider("claude")
      });

      const result = await orchestrator.runSpecGeneration(
        "s1",
        "Design a task manager",
        [{ question: "Scope?", answer: "Web only" }],
        "Use React + Node"
      );

      expect(result.implementationPlan).toBe("reviewed implementation plan");
      expect(result.walkthroughGaps).toBeDefined();
      expect(result.walkthroughGaps!.length).toBe(2);
    });

    it("throws when a provider reports an error instead of masking it as empty output", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createFailingProvider("claude", "Claude process timed out")
      });

      await expect(
        orchestrator.runSpecGeneration(
          "s1",
          "Design a task manager",
          [{ question: "Scope?", answer: "Web only" }],
          "Use React + Node"
        )
      ).rejects.toThrow("CLAUDE spec_generation failed: Claude process timed out");
    });

    it("throws when a provider finishes without emitting any output", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createSilentProvider("claude")
      });

      await expect(
        orchestrator.runSpecGeneration(
          "s1",
          "Design a task manager",
          [{ question: "Scope?", answer: "Web only" }],
          "Use React + Node"
        )
      ).rejects.toThrow("CLAUDE spec_generation failed: CLAUDE returned no output");
    });
  });
});
