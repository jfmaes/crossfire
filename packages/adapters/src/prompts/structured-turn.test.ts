import { describe, expect, it } from "vitest";
import {
  buildAnalysisPrompt,
  buildQuestionDebatePrompt,
  buildSpecPrompt,
  buildWalkthroughPrompt
} from "./phase-prompts";
import { buildStructuredTurnPrompt } from "./structured-turn";

describe("buildStructuredTurnPrompt", () => {
  it("uses the full persona and context on first-turn prompts", () => {
    const prompt = buildStructuredTurnPrompt({
      role: "gpt",
      originalProblem: "Design a dual-model planning system",
      turnNumber: 1,
      totalTurns: 4
    });

    expect(prompt).toContain("You are Dr. Chen, a principal systems architect");
    expect(prompt).toContain("ORIGINAL PROBLEM STATEMENT:");
    expect(prompt).toContain("Design a dual-model planning system");
    expect(prompt).not.toContain("Continue as Dr. Chen.");
    expect(prompt).not.toContain("actor");
    expect(prompt).not.toContain("degraded");
  });

  it("uses the compact persona reminder when omitting conversation context", () => {
    const prompt = buildStructuredTurnPrompt({
      role: "gpt",
      originalProblem: "Design a dual-model planning system",
      peerResponse: "Peer response excerpt",
      turnNumber: 3,
      totalTurns: 4,
      omitContext: true
    });

    expect(prompt).toContain("Continue as Dr. Chen.");
    expect(prompt).toContain("PEER'S LATEST RESPONSE");
    expect(prompt).toContain("Peer response excerpt");
    expect(prompt).not.toContain("You are Dr. Chen, a principal systems architect");
    expect(prompt).not.toContain("ORIGINAL PROBLEM STATEMENT:");
    expect(prompt).not.toContain("Design a dual-model planning system");
    expect(prompt).not.toContain("actor");
    expect(prompt).not.toContain("degraded");
  });

  it("embeds the canonical response shape directly in the prompt", () => {
    const prompt = buildStructuredTurnPrompt({
      role: "gpt",
      originalProblem: "Design a dual-model planning system",
      turnNumber: 1,
      totalTurns: 4
    });

    expect(prompt).toContain("The object must match this exact response shape:");
    expect(prompt).toContain('"rawText": "full human-readable reasoning"');
    expect(prompt).toContain('"milestoneReached": null');
    expect(prompt).toContain("No markdown fences.");
  });
});

describe("phase prompt contracts", () => {
  it("keeps the question-debate contract narrow and reserves questionsForHuman for clarification blockers", () => {
    const prompt = buildQuestionDebatePrompt({
      role: "gpt",
      originalProblem: "Design a dual-model planning system",
      gptAnalysis: "GPT analysis",
      claudeAnalysis: "Claude analysis",
      allQuestions: [
        {
          text: "Which platforms must v1 support?",
          priority: 1,
          rationale: "Platform scope changes architecture and testing needs.",
          proposedBy: "gpt"
        }
      ],
      peerResponse: "I want to drop the platform-scope question.",
      turnNumber: 2,
      totalTurns: 4
    });

    expect(prompt).toContain("QUESTION-DEBATE CONTRACT:");
    expect(prompt).toContain("synthesizedQuestions: your current proposed consensus list for the interview.");
    expect(prompt).toContain("leave this empty ONLY when you fully endorse that list as-is.");
    expect(prompt).toContain("questionsForHuman: use ONLY when the debate cannot continue without clarification from the human.");
    expect(prompt).toContain("Each synthesized question must include plain-English context plus Crossfire's current recommendation and why.");
    expect(prompt).toContain("Stay on unresolved question-selection issues only. Do NOT restart broad problem analysis.");
    expect(prompt).toContain('"questionsForHuman": ["clarification needed before debate can continue"]');
    expect(prompt).toContain('"synthesizedQuestions": [');
    expect(prompt).toContain('"context": "what this means in practice, in plain English"');
    expect(prompt).toContain('"recommendation": "Crossfire\'s best current recommendation"');
    expect(prompt).toContain('"recommendationReasoning": "why this is the current best recommendation and when it might change"');
    expect(prompt).not.toContain('"proposedQuestions"');
    expect(prompt).not.toContain('"questionsForPeer"');
    expect(prompt).not.toContain('"proposedSpecDelta"');
    expect(prompt).not.toContain('"milestoneReached"');
    expect(prompt).not.toContain('"implementationPlan"');
    expect(prompt).not.toContain('"walkthroughGaps"');
    expect(prompt).not.toContain('"actor"');
    expect(prompt).not.toContain('"degraded"');
  });

  it("keeps phase-specific prompt examples trimmed to their required fields", () => {
    const analysisPrompt = buildAnalysisPrompt({
      role: "gpt",
      originalProblem: "Design a dual-model planning system"
    });
    expect(analysisPrompt).toContain('"proposedQuestions": [');
    expect(analysisPrompt).toContain('"questionsForHuman": ["question1", ...]');
    expect(analysisPrompt).toContain('"context": "what this means in practice, in plain English"');
    expect(analysisPrompt).toContain('"recommendation": "Crossfire\'s best current recommendation"');
    expect(analysisPrompt).not.toContain('"synthesizedQuestions"');
    expect(analysisPrompt).not.toContain('"proposedSpecDelta"');
    expect(analysisPrompt).not.toContain('"actor"');
    expect(analysisPrompt).not.toContain('"degraded"');

    const specPrompt = buildSpecPrompt({
      role: "claude",
      originalProblem: "Design a dual-model planning system",
      interviewResults: [
        {
          question: "Which platforms must v1 support?",
          answer: "Web only"
        }
      ],
      approachResult: "Ship a web-first system."
    });
    expect(specPrompt).toContain('"implementationPlan": "DOCUMENT 2 (the full implementation plan in markdown)"');
    expect(specPrompt).not.toContain('"newInsights"');
    expect(specPrompt).not.toContain('"assumptions"');
    expect(specPrompt).not.toContain('"walkthroughGaps"');
    expect(specPrompt).not.toContain('"actor"');
    expect(specPrompt).not.toContain('"degraded"');

    const walkthroughPrompt = buildWalkthroughPrompt({
      role: "gpt",
      originalProblem: "Design a dual-model planning system",
      spec: "Spec body",
      implementationPlan: "Implementation plan body"
    });
    expect(walkthroughPrompt).toContain('"walkthroughGaps": [');
    expect(walkthroughPrompt).not.toContain('"questionsForHuman"');
    expect(walkthroughPrompt).not.toContain('"proposedSpecDelta"');
    expect(walkthroughPrompt).not.toContain('"actor"');
    expect(walkthroughPrompt).not.toContain('"degraded"');
  });
});
