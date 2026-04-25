import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createPhaseOrchestrator } from "./phase-orchestrator";

function createAnalysisProvider(name: "gpt" | "claude"): ProviderAdapter {
  return {
    name,
    async *sendTurn(input: ProviderTurnInput) {
      const turn: ModelTurn = {
        actor: name,
        rawText: `${name} analysis of the problem`,
        summary: `${name} summary`,
        newInsights: [`${name} insight`],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: input.phase === "analysis" ? [`${name} question for human`] : [],
        proposedSpecDelta: input.phase === "spec_generation" ? `${name} spec output` : "",
        milestoneReached: input.phase === "spec_generation" ? "implementation_plan_ready" : null,
        implementationPlan: input.phase === "spec_generation" ? `${name} implementation plan` : null,
        proposedQuestions: input.phase === "analysis"
          ? [{ text: `${name} question for human`, priority: 1, rationale: `${name} needs clarification` }]
          : null,
        synthesizedQuestions: input.phase === "analysis_debate"
          ? [{ text: `${name} synthesized question`, priority: 1, rationale: `${name} merged the list` }]
          : null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: input.phase === "walkthrough" ? [] : null,
        degraded: false
      };
      yield { type: "structured_turn", actor: name, turn, rawResponse: JSON.stringify(turn) } as const;
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

function createInvalidPhaseProvider(
  name: "gpt" | "claude",
  turn: Record<string, unknown>
): ProviderAdapter {
  return {
    name,
    async *sendTurn(_input: ProviderTurnInput) {
      yield {
        type: "structured_turn",
        actor: name,
        turn: turn as ModelTurn,
        rawResponse: JSON.stringify(turn)
      } as const;
      yield { type: "done" } as const;
    },
    async healthCheck() {
      return { ok: true, detail: "ready" };
    }
  };
}

function createTurnSequenceProvider(
  name: "gpt" | "claude",
  turns: ModelTurn[]
): ProviderAdapter {
  let index = 0;

  return {
    name,
    async *sendTurn() {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      yield {
        type: "structured_turn",
        actor: name,
        turn,
        rawResponse: JSON.stringify(turn)
      } as const;
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
    it("stops on consensus when both latest turns are disagreement-free", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createTurnSequenceProvider("gpt", [{
          actor: "gpt",
          rawText: "Question debate turn 1",
          summary: "GPT endorses the candidate list",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "",
          milestoneReached: null,
          implementationPlan: null,
          proposedQuestions: null,
          synthesizedQuestions: [{ text: "What is scope?", priority: 1, rationale: "Need scope" }],
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        }]),
        claude: createTurnSequenceProvider("claude", [{
          actor: "claude",
          rawText: "Question debate turn 2",
          summary: "Claude also endorses the candidate list",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "",
          milestoneReached: null,
          implementationPlan: null,
          proposedQuestions: null,
          synthesizedQuestions: [{ text: "What is scope?", priority: 1, rationale: "Need scope" }],
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        }])
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

      expect(result.trace.stopReason).toBe("consensus");
      expect(result.trace.turnsUsed).toBe(2);
      expect(result.synthesizedQuestions).toHaveLength(1);
      expect(result.synthesizedQuestions[0].text).toBe("What is scope?");
    });

    it("stops for clarification when a model asks the human to resolve the debate", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createTurnSequenceProvider("gpt", [{
          actor: "gpt",
          rawText: "We need one answer before finalizing the interview.",
          summary: "Blocked on clarification",
          newInsights: [],
          assumptions: [],
          disagreements: ["The target environment changes which questions matter most."],
          questionsForPeer: [],
          questionsForHuman: ["Is this system web-only or cross-platform?"],
          proposedSpecDelta: "",
          milestoneReached: null,
          implementationPlan: null,
          proposedQuestions: null,
          synthesizedQuestions: [{ text: "What platforms must this support?", priority: 1, rationale: "Defines the scope" }],
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        }]),
        claude: createAnalysisProvider("claude")
      });

      const result = await orchestrator.runQuestionDebate(
        "s1",
        "Design a task manager",
        "gpt analysis text",
        "claude analysis text",
        [{ text: "What platforms must this support?", priority: 1, rationale: "Defines the scope", proposedBy: "gpt" }]
      );

      expect(result.trace.stopReason).toBe("questions_for_human");
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].questionsForHuman).toEqual(["Is this system web-only or cross-platform?"]);
    });

    it("stops at the turn cap and preserves unresolved disagreements", async () => {
      const unresolvedTurn: ModelTurn = {
        actor: "gpt",
        rawText: "GPT still wants an auth question included.",
        summary: "Keep the auth question",
        newInsights: [],
        assumptions: [],
        disagreements: ["The list still omits a required authentication question."],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: [{ text: "How should authentication work?", priority: 1, rationale: "Security scope" }],
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      };

      const claudeTurn: ModelTurn = {
        actor: "claude",
        rawText: "Claude still disagrees that auth belongs in the interview.",
        summary: "Auth can wait",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: [{ text: "What is the target platform?", priority: 1, rationale: "Scope first" }],
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      };

      const orchestrator = createPhaseOrchestrator({
        gpt: createTurnSequenceProvider("gpt", [unresolvedTurn]),
        claude: createTurnSequenceProvider("claude", [claudeTurn])
      });

      const result = await orchestrator.runQuestionDebate(
        "s1",
        "Design a task manager",
        "gpt analysis text",
        "claude analysis text",
        [{ text: "What is the target platform?", priority: 1, rationale: "Scope first", proposedBy: "claude" }]
      );

      expect(result.trace.stopReason).toBe("max_turns");
      expect(result.trace.turnsUsed).toBe(4);
      expect(result.trace.finalDisagreements).toEqual(["The list still omits a required authentication question."]);
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
      expect(result.finalApproachHandoff).toContain("Final Approach Handoff");
    });

    it("reports unresolved disagreements from the final valid pair when debate hits max turns", async () => {
      function singleTurnProvider(turn: ModelTurn): ProviderAdapter {
        return {
          name: turn.actor,
          async *sendTurn() {
            yield {
              type: "structured_turn",
              actor: turn.actor,
              turn,
              rawResponse: JSON.stringify(turn)
            } as const;
            yield { type: "done" } as const;
          },
          async healthCheck() {
            return { ok: true, detail: "ready" };
          }
        };
      }

      const orchestrator = createPhaseOrchestrator({
        gpt: singleTurnProvider({
          actor: "gpt",
          rawText: "gpt debate",
          summary: "gpt summary",
          newInsights: [],
          assumptions: [],
          disagreements: ["Caching layer remains too complex"],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "Prefer the simpler option.",
          milestoneReached: null,
          implementationPlan: null,
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        }),
        claude: singleTurnProvider({
          actor: "claude",
          rawText: "claude debate",
          summary: "claude summary",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "Keep the current plan.",
          milestoneReached: null,
          implementationPlan: null,
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: false
        })
      });

      const result = await orchestrator.runApproachDebate(
        "s1",
        "Design a task manager",
        [],
        4
      );

      expect(result.trace.stopReason).toBe("max_turns");
      expect(result.trace.finalDisagreementCount).toBe(1);
      expect(result.trace.finalDisagreements).toEqual(["Caching layer remains too complex"]);
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
      expect(result.trace.canonicalHandoffUsed).toBe(true);
      expect(result.trace.authorityPathUncompressed).toBe(true);
      expect(result.trace.compaction).toEqual({
        approachResult: false,
        peerDraft: false,
        revisionPeerDraft: false
      });
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
              implementationPlan: isWalkthrough ? null : `${name} implementation plan`,
              proposedQuestions: null,
              synthesizedQuestions: null,
              followUpQuestions: null,
              sufficientContext: null,
              walkthroughGaps: isWalkthrough ? [
                { location: "Section 3", issue: `${name}: token budget too small`, fix: "Increase to 40K" }
              ] : null,
              degraded: false
            };
            if (isWalkthrough) {
              turn.rawText = "Found operational gaps during walkthrough";
              turn.summary = "Walkthrough found gaps";
            }
            yield { type: "structured_turn", actor: name, turn, rawResponse: JSON.stringify(turn) } as const;
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
                },
                rawResponse: JSON.stringify({
                  ...baseTurn,
                  implementationPlan: "draft implementation plan"
                })
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
                },
                rawResponse: JSON.stringify({
                  ...baseTurn,
                  implementationPlan: "reviewed implementation plan"
                })
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
              },
              rawResponse: JSON.stringify({
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
              })
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

    it("fails closed when the canonical handoff exceeds the authority-path budget", async () => {
      const orchestrator = createPhaseOrchestrator({
        gpt: createAnalysisProvider("gpt"),
        claude: createAnalysisProvider("claude")
      });

      await expect(
        orchestrator.runSpecGeneration(
          "s1",
          "Design a task manager",
          [{ question: "Scope?", answer: "Web only" }],
          "X".repeat(20_001)
        )
      ).rejects.toThrow("spec_generation_input_too_large");
    });
  });
});
