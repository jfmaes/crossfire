import { describe, expect, it } from "vitest";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter, ProviderTurnInput } from "@council/adapters";
import { createPhaseOrchestrator } from "./phase-orchestrator";
import { onProgress, type ProgressEvent } from "./progress";

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

function createCapturingProvider(
  name: "gpt" | "claude",
  turnForInput: (input: ProviderTurnInput) => ModelTurn
): ProviderAdapter & { calls: ProviderTurnInput[] } {
  const calls: ProviderTurnInput[] = [];

  return {
    name,
    calls,
    async *sendTurn(input: ProviderTurnInput) {
      calls.push(input);
      const turn = turnForInput(input);
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

    it("retries the final Claude revision once after degraded structured output and records recovery trace metadata", async () => {
      const revisionPrompts: string[] = [];
      const revisedSpec = "# Revised Spec\n\nRecovered valid spec";
      const revisedPlan = "# Revised Plan\n\n1. Apply the recovery edits";
      let revisionCalls = 0;

      const gpt: ProviderAdapter = {
        name: "gpt",
        async *sendTurn(input: ProviderTurnInput) {
          const isWalkthrough = input.phase === "walkthrough";
          const turn: ModelTurn = {
            actor: "gpt",
            rawText: isWalkthrough ? "GPT found one operational gap" : "GPT draft",
            summary: isWalkthrough ? "GPT walkthrough" : "GPT draft summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: isWalkthrough ? "" : "Draft spec content",
            milestoneReached: isWalkthrough ? null : "implementation_plan_ready",
            implementationPlan: isWalkthrough ? null : "Draft implementation plan",
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: isWalkthrough
              ? [{ location: "Section 2", issue: "Missing rollback behavior", fix: "Add rollback steps" }]
              : null,
            degraded: false
          };
          yield { type: "structured_turn", actor: "gpt", turn, rawResponse: JSON.stringify(turn) } as const;
          yield { type: "done" } as const;
        },
        async healthCheck() {
          return { ok: true, detail: "ready" };
        }
      };

      const claude: ProviderAdapter = {
        name: "claude",
        async *sendTurn(input: ProviderTurnInput) {
          if (input.phase === "walkthrough") {
            const walkthroughTurn: ModelTurn = {
              actor: "claude",
              rawText: "Claude found no additional gaps",
              summary: "Claude walkthrough",
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
              walkthroughGaps: [],
              degraded: false
            };
            yield {
              type: "structured_turn",
              actor: "claude",
              turn: walkthroughTurn,
              rawResponse: JSON.stringify(walkthroughTurn)
            } as const;
            yield { type: "done" } as const;
            return;
          }

          const isRevision = input.prompt.includes("ADVERSARIAL WALKTHROUGH FINDINGS:");
          if (isRevision) {
            revisionPrompts.push(input.prompt);
            revisionCalls += 1;

            if (revisionCalls === 1) {
              const wrappedRevisionResponse = [
                "Here is the JSON you requested:",
                JSON.stringify({
                  actor: "claude",
                  rawText: "Malformed recovery response",
                  summary: "Revision summary",
                  newInsights: [],
                  assumptions: [],
                  disagreements: [],
                  questionsForPeer: [],
                  questionsForHuman: [],
                  proposedSpecDelta: "Should be rejected",
                  milestoneReached: "implementation_plan_ready",
                  implementationPlan: "Rejected plan",
                  proposedQuestions: null,
                  synthesizedQuestions: null,
                  followUpQuestions: null,
                  sufficientContext: null,
                  walkthroughGaps: null,
                  degraded: true
                }),
                "Thanks."
              ].join("\n");

              const degradedTurn: ModelTurn = {
                actor: "claude",
                rawText: wrappedRevisionResponse,
                summary: "Revision summary",
                newInsights: [],
                assumptions: [],
                disagreements: [],
                questionsForPeer: [],
                questionsForHuman: [],
                proposedSpecDelta: "",
                milestoneReached: "implementation_plan_ready",
                implementationPlan: null,
                proposedQuestions: null,
                synthesizedQuestions: null,
                followUpQuestions: null,
                sufficientContext: null,
                walkthroughGaps: null,
                degraded: true
              };
              yield {
                type: "structured_turn",
                actor: "claude",
                turn: degradedTurn,
                rawResponse: wrappedRevisionResponse
              } as const;
              yield { type: "done" } as const;
              return;
            }

            const recoveredTurn: ModelTurn = {
              actor: "claude",
              rawText: "Recovered valid revision",
              summary: "Recovered revision summary",
              newInsights: [],
              assumptions: [],
              disagreements: [],
              questionsForPeer: [],
              questionsForHuman: [],
              proposedSpecDelta: revisedSpec,
              milestoneReached: "implementation_plan_ready",
              implementationPlan: revisedPlan,
              proposedQuestions: null,
              synthesizedQuestions: null,
              followUpQuestions: null,
              sufficientContext: null,
              walkthroughGaps: null,
              degraded: false
            };
            yield {
              type: "structured_turn",
              actor: "claude",
              turn: recoveredTurn,
              rawResponse: JSON.stringify(recoveredTurn)
            } as const;
            yield { type: "done" } as const;
            return;
          }

          const reviewTurn: ModelTurn = {
            actor: "claude",
            rawText: "Claude review",
            summary: "Claude review summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: "# Reviewed Spec\n\nShip the task manager",
            milestoneReached: "implementation_plan_ready",
            implementationPlan: "# Reviewed Plan\n\n1. Build the task manager",
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: null,
            degraded: false
          };
          yield {
            type: "structured_turn",
            actor: "claude",
            turn: reviewTurn,
            rawResponse: JSON.stringify(reviewTurn)
          } as const;
          yield { type: "done" } as const;
        },
        async healthCheck() {
          return { ok: true, detail: "ready" };
        }
      };

      const result = await createPhaseOrchestrator({ gpt, claude }).runSpecGeneration(
        "s1",
        "Design a task manager",
        [{ question: "Scope?", answer: "Web only" }],
        "Use React + Node",
        "run_1"
      );

      expect(revisionCalls).toBe(2);
      expect(revisionPrompts).toHaveLength(2);
      expect(revisionPrompts[0]).toContain("ADVERSARIAL WALKTHROUGH FINDINGS:");
      expect(revisionPrompts[1]).toContain("previous response was rejected because it was not a valid raw JSON object");
      expect(revisionPrompts[1]).toContain("do not explain");
      expect(revisionPrompts[1]).toContain("output one raw JSON object only");
      expect(result.spec).toBe(revisedSpec);
      expect(result.implementationPlan).toBe(revisedPlan);
      expect(result.trace.degradedOutputRetry).toEqual({
        attempted: true,
        reason: "degraded_structured_output",
        succeeded: true
      });
    });

    it("surfaces structured diagnostics when the final Claude revision degrades", async () => {
      const events: ProgressEvent[] = [];
      const unsubscribe = onProgress((event) => events.push(event));
      const originalProblem = "Design a task manager";
      const interviewResults = [{ question: "Scope?", answer: "Web only" }];
      const finalApproachHandoff = "Use React + Node";
      const reviewedSpec = "# Reviewed Spec\n\nShip the task manager";
      const reviewedPlan = "# Reviewed Plan\n\n1. Build the task manager";
      const gapReport = "1. **Section 2**: Missing rollback behavior\n   Fix: Add rollback steps";
      const revisionPeerDraft = [
        reviewedSpec,
        "",
        "---",
        "",
        "IMPLEMENTATION PLAN:",
        reviewedPlan,
        "",
        "---",
        "",
        "ADVERSARIAL WALKTHROUGH FINDINGS:",
        "Both models independently simulated executing this spec and found the following operational gaps.",
        "Incorporate the fixes below into the spec and plan. Do NOT simply acknowledge them — actually modify the relevant sections.",
        "",
        gapReport
      ].join("\n");
      const interviewTranscript = interviewResults.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n");
      const wrappedRevisionResponse = [
        "Here is the JSON you requested:",
        JSON.stringify({
          actor: "claude",
          rawText: "Revision raw response body",
          summary: "Revision summary",
          newInsights: [],
          assumptions: [],
          disagreements: [],
          questionsForPeer: [],
          questionsForHuman: [],
          proposedSpecDelta: "Revised spec content",
          milestoneReached: "implementation_plan_ready",
          implementationPlan: "Revised plan",
          proposedQuestions: null,
          synthesizedQuestions: null,
          followUpQuestions: null,
          sufficientContext: null,
          walkthroughGaps: null,
          degraded: true
        }),
        "Thanks."
      ].join("\n");

      const gpt: ProviderAdapter = {
        name: "gpt",
        async *sendTurn(input: ProviderTurnInput) {
          const isWalkthrough = input.phase === "walkthrough";
          const turn: ModelTurn = {
            actor: "gpt",
            rawText: isWalkthrough ? "GPT found rollback gaps" : "GPT draft",
            summary: isWalkthrough ? "GPT walkthrough" : "GPT draft summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: isWalkthrough ? "" : "Draft spec content",
            milestoneReached: isWalkthrough ? null : "implementation_plan_ready",
            implementationPlan: isWalkthrough ? null : "Draft implementation plan",
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: isWalkthrough
              ? [{ location: "Section 2", issue: "Missing rollback behavior", fix: "Add rollback steps" }]
              : null,
            degraded: false
          };
          yield { type: "structured_turn", actor: "gpt", turn, rawResponse: JSON.stringify(turn) } as const;
          yield { type: "done" } as const;
        },
        async healthCheck() {
          return { ok: true, detail: "ready" };
        }
      };

      const claude: ProviderAdapter = {
        name: "claude",
        async *sendTurn(input: ProviderTurnInput) {
          if (input.phase === "walkthrough") {
            const walkthroughTurn: ModelTurn = {
              actor: "claude",
              rawText: "Claude found no extra gaps",
              summary: "Claude walkthrough",
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
              walkthroughGaps: [],
              degraded: false
            };
            yield {
              type: "structured_turn",
              actor: "claude",
              turn: walkthroughTurn,
              rawResponse: JSON.stringify(walkthroughTurn)
            } as const;
            yield { type: "done" } as const;
            return;
          }

          const isRevision = input.prompt.includes("ADVERSARIAL WALKTHROUGH FINDINGS:");
          if (isRevision) {
            const degradedTurn: ModelTurn = {
              actor: "claude",
              rawText: wrappedRevisionResponse,
              summary: "Revision summary",
              newInsights: [],
              assumptions: [],
              disagreements: [],
              questionsForPeer: [],
              questionsForHuman: [],
              proposedSpecDelta: "",
              milestoneReached: "implementation_plan_ready",
              implementationPlan: null,
              proposedQuestions: null,
              synthesizedQuestions: null,
              followUpQuestions: null,
              sufficientContext: null,
              walkthroughGaps: null,
              degraded: true
            };
            yield {
              type: "structured_turn",
              actor: "claude",
              turn: degradedTurn,
              rawResponse: wrappedRevisionResponse
            } as const;
            yield { type: "done" } as const;
            return;
          }

          const reviewTurn: ModelTurn = {
            actor: "claude",
            rawText: "Claude review",
            summary: "Claude review summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: reviewedSpec,
            milestoneReached: "implementation_plan_ready",
            implementationPlan: reviewedPlan,
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: null,
            degraded: false
          };
          yield {
            type: "structured_turn",
            actor: "claude",
            turn: reviewTurn,
            rawResponse: JSON.stringify(reviewTurn)
          } as const;
          yield { type: "done" } as const;
        },
        async healthCheck() {
          return { ok: true, detail: "ready" };
        }
      };

      try {
        await createPhaseOrchestrator({ gpt, claude }).runSpecGeneration(
          "s1",
          originalProblem,
          interviewResults,
          finalApproachHandoff,
          "run_1"
        );
        throw new Error("Expected degraded Claude revision to reject");
      } catch (error) {
        const failure = error as Error & {
          diagnostics?: {
            phase?: string;
            provider?: string;
            substep?: string;
            degradedOutputRetry?: {
              attempted?: boolean;
              reason?: string | null;
              succeeded?: boolean;
            };
            rawResponsePreview?: string;
            promptLedgerSizes?: Record<string, number>;
            revisionPeerDraftChars?: number;
          };
        };

        expect(failure.message).toContain("CLAUDE spec_generation failed: degraded structured output");
        expect(failure.diagnostics).toMatchObject({
          phase: "spec_generation",
          provider: "claude",
          substep: "revision",
          degradedOutputRetry: {
            attempted: true,
            reason: "degraded_structured_output",
            succeeded: false
          },
          rawResponsePreview: expect.stringContaining("Here is the JSON you requested:"),
          promptLedgerSizes: {
            originalProblem: originalProblem.length,
            interviewResults: interviewTranscript.length,
            finalApproachHandoff: finalApproachHandoff.length,
            revisionPeerDraft: revisionPeerDraft.length
          },
          revisionPeerDraftChars: revisionPeerDraft.length
        });

        const degradedRevisionEvents = events.filter((event) =>
          event.phase === "spec_generation"
          && event.metadata?.substep === "revision"
          && event.metadata?.provider === "claude"
        );
        const degradedRevisionEvent = degradedRevisionEvents.at(-1);

        expect(degradedRevisionEvent?.metadata).toMatchObject({
          phase: "spec_generation",
          provider: "claude",
          substep: "revision",
          degradedOutputRetry: {
            attempted: true,
            reason: "degraded_structured_output",
            succeeded: false
          },
          rawResponsePreview: expect.stringContaining("Here is the JSON you requested:"),
          promptLedgerSizes: {
            originalProblem: originalProblem.length,
            interviewResults: interviewTranscript.length,
            finalApproachHandoff: finalApproachHandoff.length,
            revisionPeerDraft: revisionPeerDraft.length
          },
          revisionPeerDraftChars: revisionPeerDraft.length
        });
      } finally {
        unsubscribe();
      }
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
          "X".repeat(100_001)
        )
      ).rejects.toThrow("spec_generation_input_too_large");
    });

    it("synthesizes walkthrough gaps when only the raw revision input exceeds budget", async () => {
      const reviewedSpec = `# Reviewed Spec\n\n${"Detailed requirement.\n".repeat(9_000)}`;
      const reviewedPlan = `# Reviewed Plan\n\n${"Implementation step.\n".repeat(300)}`;
      const largeGaps = Array.from({ length: 35 }, (_, index) => ({
        location: `Section ${index + 1}`,
        issue: `Gap ${index + 1}: ${"missing operational detail ".repeat(90)}`,
        fix: `Add precise behavior for gap ${index + 1}. ${"Include acceptance criteria. ".repeat(80)}`
      }));

      const claudePrompts: Array<{ phase?: string; prompt: string }> = [];
      const synthesizedBrief = [
        "## Synthesized Walkthrough Repair Brief",
        "",
        "- RC-1 covers gaps 1-35: add a consolidated operational contract."
      ].join("\n");

      const gpt: ProviderAdapter = {
        name: "gpt",
        async *sendTurn(input: ProviderTurnInput) {
          const isWalkthrough = input.phase === "walkthrough";
          const turn: ModelTurn = {
            actor: "gpt",
            rawText: isWalkthrough ? "GPT found many gaps" : "GPT draft",
            summary: isWalkthrough ? "GPT walkthrough" : "GPT draft summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: isWalkthrough ? "" : "Small draft spec",
            milestoneReached: isWalkthrough ? null : "implementation_plan_ready",
            implementationPlan: isWalkthrough ? null : "Small draft plan",
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: isWalkthrough ? largeGaps : null,
            degraded: false
          };
          yield { type: "structured_turn", actor: "gpt", turn, rawResponse: JSON.stringify(turn) } as const;
          yield { type: "done" } as const;
        },
        async healthCheck() {
          return { ok: true, detail: "ready" };
        }
      };

      const claude: ProviderAdapter = {
        name: "claude",
        async *sendTurn(input: ProviderTurnInput) {
          claudePrompts.push({ phase: input.phase, prompt: input.prompt });
          const turn: ModelTurn = {
            actor: "claude",
            rawText: "Claude output",
            summary: "Claude summary",
            newInsights: [],
            assumptions: [],
            disagreements: [],
            questionsForPeer: [],
            questionsForHuman: [],
            proposedSpecDelta: "",
            milestoneReached: "implementation_plan_ready",
            implementationPlan: null,
            proposedQuestions: null,
            synthesizedQuestions: null,
            followUpQuestions: null,
            sufficientContext: null,
            walkthroughGaps: null,
            degraded: false
          };

          if (input.phase === "walkthrough") {
            const walkthroughTurn = {
              ...turn,
              rawText: "Claude found no additional gaps",
              summary: "Claude walkthrough",
              milestoneReached: null,
              walkthroughGaps: []
            };
            yield {
              type: "structured_turn",
              actor: "claude",
              turn: walkthroughTurn,
              rawResponse: JSON.stringify(walkthroughTurn)
            } as const;
            yield { type: "done" } as const;
            return;
          }

          if (input.phase === "gap_synthesis") {
            const synthesisTurn = {
              ...turn,
              rawText: synthesizedBrief,
              summary: "Synthesized 35 raw gaps into one repair brief",
              proposedSpecDelta: synthesizedBrief,
              implementationPlan: ""
            };
            yield {
              type: "structured_turn",
              actor: "claude",
              turn: synthesisTurn,
              rawResponse: JSON.stringify(synthesisTurn)
            } as const;
            yield { type: "done" } as const;
            return;
          }

          const isRevision = input.prompt.includes("SYNTHESIZED WALKTHROUGH REPAIR BRIEF");
          const specTurn = {
            ...turn,
            rawText: isRevision ? "Final revised spec" : "Reviewed spec",
            summary: isRevision ? "Revision complete" : "Review complete",
            proposedSpecDelta: isRevision ? "Final revised spec" : reviewedSpec,
            implementationPlan: isRevision ? "Final revised plan" : reviewedPlan
          };
          yield {
            type: "structured_turn",
            actor: "claude",
            turn: specTurn,
            rawResponse: JSON.stringify(specTurn)
          } as const;
          yield { type: "done" } as const;
        },
        async healthCheck() {
          return { ok: true, detail: "ready" };
        }
      };

      const orchestrator = createPhaseOrchestrator({ gpt, claude });

      const result = await orchestrator.runSpecGeneration(
        "s1",
        "Design a task manager",
        [{ question: "Scope?", answer: "Web only" }],
        "Use React + Node"
      );

      expect(result.spec).toBe("Final revised spec");
      expect(result.implementationPlan).toBe("Final revised plan");
      expect(result.trace.gapSynthesis).toBeDefined();
      expect(result.trace.revisionInputSynthesized).toBe(true);
      expect(claudePrompts.some((entry) => entry.phase === "gap_synthesis")).toBe(true);
      const revisionPrompt = claudePrompts.at(-1)!.prompt;
      expect(revisionPrompt).toContain("SYNTHESIZED WALKTHROUGH REPAIR BRIEF");
      expect(revisionPrompt).toContain("RC-1 covers gaps 1-35");
    });
  });

  describe("runSpecRevision", () => {
    it("digests large feedback then revises from the existing spec", async () => {
      const gpt = createCapturingProvider("gpt", () => ({
        actor: "gpt",
        rawText: "Digest raw text fallback feedback-chunk-1",
        summary: "Digest summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "Digest says update authentication. Source: feedback-chunk-1",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      }));
      const claude = createCapturingProvider("claude", () => ({
        actor: "claude",
        rawText: "Revised overview",
        summary: "Revised the existing spec using feedback",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "# Revised Spec",
        milestoneReached: "implementation_plan_ready",
        implementationPlan: "# Revised Plan",
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      }));

      const result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
        "sess_1",
        {
          originalProblem: "Original problem",
          interviewResults: [{ question: "Scope?", answer: "Web only" }],
          finalApproachHandoff: "Use the existing architecture",
          currentSpec: "# Current Spec",
          currentImplementationPlan: "# Current Plan",
          feedbackRaw: "Tighten auth. ".repeat(1_000),
          rawFeedbackBudgetChars: 500,
          excerptBudgetChars: 100_000
        },
        "run_1"
      );

      expect(result.spec).toBe("# Revised Spec");
      expect(result.implementationPlan).toBe("# Revised Plan");
      expect(result.trace.feedbackDigest).toBeDefined();
      expect(result.trace.revision).toBeDefined();
      expect(result.revisionRequest.feedbackChunks.length).toBeGreaterThan(0);
      expect(gpt.calls[0].phase).toBe("feedback_digest");
      expect(claude.calls[0].phase).toBe("spec_generation");
      expect(gpt.calls[0].prompt).toContain("PHASE: FEEDBACK DIGEST");
      expect(claude.calls[0].prompt).toContain("CURRENT SPECIFICATION:");
      expect(claude.calls[0].prompt).toContain("CURRENT IMPLEMENTATION PLAN:");
      expect(claude.calls[0].prompt).toContain("EXACT FEEDBACK EXCERPTS:");
      expect(claude.calls[0].prompt).not.toContain("HUMAN REVISION FEEDBACK:");
    });

    it("blocks when exact feedback excerpts exceed budget", async () => {
      const events: ProgressEvent[] = [];
      const unsubscribe = onProgress((event) => events.push(event));
      const gpt = createCapturingProvider("gpt", () => ({
        actor: "gpt",
        rawText: "Digest raw text fallback feedback-chunk-1",
        summary: "Digest summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "Digest requests every referenced change from feedback-chunk-1",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      }));
      const claude = createCapturingProvider("claude", () => {
        throw new Error("Claude revision should not be called");
      });

      let result: Awaited<ReturnType<ReturnType<typeof createPhaseOrchestrator>["runSpecRevision"]>>;
      try {
        result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
          "sess_1",
          {
            originalProblem: "Original problem",
            interviewResults: [],
            finalApproachHandoff: "Approach",
            currentSpec: "# Current Spec",
            currentImplementationPlan: "# Current Plan",
            feedbackRaw: "x".repeat(20_000),
            rawFeedbackBudgetChars: 500,
            excerptBudgetChars: 10
          },
          "run_1"
        );
      } finally {
        unsubscribe();
      }

      expect(result.blockedReason).toBe("feedback_input_too_large");
      expect(result.spec).toBe("# Current Spec");
      expect(result.implementationPlan).toBe("# Current Plan");
      expect(claude.calls).toHaveLength(0);
      expect(events.some((event) => event.metadata?.blockedReason === "feedback_input_too_large")).toBe(true);
    });

    it("blocks when the digest references a missing feedback chunk", async () => {
      const gpt = createCapturingProvider("gpt", () => ({
        actor: "gpt",
        rawText: "Digest references missing feedback-chunk-999",
        summary: "Digest summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "Apply the requested auth change from feedback-chunk-999",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      }));
      const claude = createCapturingProvider("claude", () => {
        throw new Error("Claude revision should not be called");
      });

      const result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
        "sess_1",
        {
          originalProblem: "Original problem",
          interviewResults: [],
          finalApproachHandoff: "Approach",
          currentSpec: "# Current Spec",
          currentImplementationPlan: "# Current Plan",
          feedbackRaw: "Tighten auth. ".repeat(1_000),
          rawFeedbackBudgetChars: 500,
          excerptBudgetChars: 10_000
        },
        "run_1"
      );

      expect(result.blockedReason).toBe("feedback_input_too_large");
      expect(result.spec).toBe("# Current Spec");
      expect(result.implementationPlan).toBe("# Current Plan");
      expect(claude.calls).toHaveLength(0);
    });

    it("blocks when a large feedback digest omits feedback chunk references", async () => {
      const gpt = createCapturingProvider("gpt", () => ({
        actor: "gpt",
        rawText: "Digest without source references",
        summary: "Digest summary",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "Apply the requested auth change",
        milestoneReached: null,
        implementationPlan: null,
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      }));
      const claude = createCapturingProvider("claude", () => {
        throw new Error("Claude revision should not be called");
      });

      const result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
        "sess_1",
        {
          originalProblem: "Original problem",
          interviewResults: [],
          finalApproachHandoff: "Approach",
          currentSpec: "# Current Spec",
          currentImplementationPlan: "# Current Plan",
          feedbackRaw: "Tighten auth. ".repeat(1_000),
          rawFeedbackBudgetChars: 500,
          excerptBudgetChars: 100_000
        },
        "run_1"
      );

      expect(result.blockedReason).toBe("feedback_input_too_large");
      expect(result.spec).toBe("# Current Spec");
      expect(result.implementationPlan).toBe("# Current Plan");
      expect(claude.calls).toHaveLength(0);
    });

    it("blocks before digesting when the feedback digest prompt exceeds budget", async () => {
      const events: ProgressEvent[] = [];
      const unsubscribe = onProgress((event) => events.push(event));
      const gpt = createCapturingProvider("gpt", () => {
        throw new Error("GPT digest should not be called");
      });
      const claude = createCapturingProvider("claude", () => {
        throw new Error("Claude revision should not be called");
      });

      let result: Awaited<ReturnType<ReturnType<typeof createPhaseOrchestrator>["runSpecRevision"]>>;
      try {
        result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
          "sess_1",
          {
            originalProblem: "Original problem",
            interviewResults: [],
            finalApproachHandoff: "Approach",
            currentSpec: "# Current Spec",
            currentImplementationPlan: "# Current Plan",
            feedbackRaw: "x".repeat(20_000),
            rawFeedbackBudgetChars: 500,
            digestPromptBudgetChars: 1_000,
            excerptBudgetChars: 10_000
          },
          "run_1"
        );
      } finally {
        unsubscribe();
      }

      expect(result.blockedReason).toBe("feedback_input_too_large");
      expect(result.revisionRequest.feedbackDigest).toBeNull();
      expect(gpt.calls).toHaveLength(0);
      expect(claude.calls).toHaveLength(0);
      expect(events.some((event) => event.metadata?.blockedReason === "feedback_input_too_large")).toBe(true);
    });

    it("skips digest for small feedback", async () => {
      const gpt = createCapturingProvider("gpt", () => {
        throw new Error("GPT digest should not be called");
      });
      const claude = createCapturingProvider("claude", () => ({
        actor: "claude",
        rawText: "Small revision overview",
        summary: "Applied small feedback",
        newInsights: [],
        assumptions: [],
        disagreements: [],
        questionsForPeer: [],
        questionsForHuman: [],
        proposedSpecDelta: "# Revised Small Spec",
        milestoneReached: "implementation_plan_ready",
        implementationPlan: "# Revised Small Plan",
        proposedQuestions: null,
        synthesizedQuestions: null,
        followUpQuestions: null,
        sufficientContext: null,
        walkthroughGaps: null,
        degraded: false
      }));
      const feedbackRaw = "Please rename setup to bootstrap.";

      const result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
        "sess_1",
        {
          originalProblem: "Original problem",
          interviewResults: [],
          finalApproachHandoff: "Approach",
          currentSpec: "# Current Spec",
          currentImplementationPlan: "# Current Plan",
          feedbackRaw,
          rawFeedbackBudgetChars: 500
        },
        "run_1"
      );

      expect(gpt.calls).toHaveLength(0);
      expect(claude.calls[0].prompt).toContain(feedbackRaw);
      expect(result.spec).toBe("# Revised Small Spec");
      expect(result.implementationPlan).toBe("# Revised Small Plan");
      expect(result.trace.revision).toBeDefined();
    });

    it("blocks small feedback when exact excerpts exceed budget", async () => {
      const gpt = createCapturingProvider("gpt", () => {
        throw new Error("GPT digest should not be called");
      });
      const claude = createCapturingProvider("claude", () => {
        throw new Error("Claude revision should not be called");
      });

      const result = await createPhaseOrchestrator({ gpt, claude }).runSpecRevision(
        "sess_1",
        {
          originalProblem: "Original problem",
          interviewResults: [],
          finalApproachHandoff: "Approach",
          currentSpec: "# Current Spec",
          currentImplementationPlan: "# Current Plan",
          feedbackRaw: "Please rename setup to bootstrap.",
          rawFeedbackBudgetChars: 500,
          excerptBudgetChars: 10
        },
        "run_1"
      );

      expect(result.blockedReason).toBe("feedback_input_too_large");
      expect(gpt.calls).toHaveLength(0);
      expect(claude.calls).toHaveLength(0);
    });
  });
});
