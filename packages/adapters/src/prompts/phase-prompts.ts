import type { InterviewQuestion, SessionPhase } from "@council/core";
import { GPT_PERSONA, CLAUDE_PERSONA, ANTI_SYCOPHANCY } from "./structured-turn";

export interface PhasePromptContext {
  role: "gpt" | "claude";
  originalProblem: string;
  phase: SessionPhase;
}

function getPersona(role: "gpt" | "claude"): string {
  return role === "gpt" ? GPT_PERSONA : CLAUDE_PERSONA;
}

export function buildAnalysisPrompt(input: {
  role: "gpt" | "claude";
  originalProblem: string;
}): string {
  return [
    getPersona(input.role),
    "",
    ANTI_SYCOPHANCY,
    "",
    `PHASE: INDEPENDENT ANALYSIS`,
    `Your peer has NOT seen the problem yet — you are working in parallel.`,
    `Produce a thorough, critical analysis. Identify at least 3 substantive risks or concerns before stating strengths.`,
    "",
    `Analyze the following problem and produce:`,
    `1. A thorough breakdown of what this problem entails — be specific about what could go wrong`,
    `2. Up to 5 critical questions the human MUST answer before design can begin (fewer is better — only ask what's truly necessary)`,
    `3. For each question, rank its priority (1 = highest) and explain WHY the answer matters`,
    "",
    `Respond ONLY with a JSON object matching this schema:`,
    `{`,
    `  "actor": "${input.role}",`,
    `  "rawText": "your full analysis as readable text",`,
    `  "summary": "one paragraph summary",`,
    `  "newInsights": ["insight1", ...],`,
    `  "assumptions": ["assumption1", ...],`,
    `  "disagreements": [],`,
    `  "questionsForPeer": [],`,
    `  "questionsForHuman": ["question1", ...],`,
    `  "proposedSpecDelta": "",`,
    `  "milestoneReached": null,`,
    `  "implementationPlan": null,`,
    `  "proposedQuestions": [`,
    `    { "text": "question", "priority": 1, "rationale": "why this matters" }`,
    `  ],`,
    `  "synthesizedQuestions": null,`,
    `  "followUpQuestions": null,`,
    `  "sufficientContext": null,`,
    `  "walkthroughGaps": null,`,
    `  "degraded": false,`,
    `}`,
    "",
    `---`,
    "",
    `PROBLEM STATEMENT:`,
    input.originalProblem
  ].join("\n");
}

/**
 * Build a question debate turn prompt. Each turn in the multi-round debate gets this prompt,
 * with the peer's latest response included for rounds after the first.
 * The models debate which questions to ask the human and must reach consensus.
 */
export function buildQuestionDebatePrompt(input: {
  role: "gpt" | "claude";
  originalProblem: string;
  gptAnalysis: string;
  claudeAnalysis: string;
  allQuestions: Array<{ text: string; priority: number; rationale: string; proposedBy: string }>;
  peerResponse?: string;
  turnNumber: number;
  totalTurns: number;
}): string {
  const questionList = input.allQuestions
    .map((q, i) => `  ${i + 1}. [Priority ${q.priority}] (${q.proposedBy}) ${q.text}\n     Rationale: ${q.rationale}`)
    .join("\n");

  const isFirstTurn = !input.peerResponse;

  const sections = [
    getPersona(input.role),
    "",
    ANTI_SYCOPHANCY,
    "",
    `PHASE: QUESTION DEBATE (Turn ${input.turnNumber} of up to ${input.totalTurns})`,
    ``,
    `GOAL: Reach unanimous consensus on which interview questions to ask the human.`,
    `The questions MUST be agreed upon by both of you before they are presented.`,
    `There is no fixed cap on the number of questions — include as many as are genuinely necessary, but not more.`,
    "",
    isFirstTurn
      ? [
          `This is the FIRST turn. Both you and your peer independently analyzed the problem and proposed questions.`,
          `Your job now:`,
          `1. Review ALL proposed questions critically — challenge each one.`,
          `2. Remove questions that are redundant, low-value, or answerable from the problem statement.`,
          `3. Add questions that are MISSING but critical for design decisions.`,
          `4. Propose a revised prioritized question list.`,
          `5. List your disagreements with the current list in the "disagreements" array.`,
        ].join("\n")
      : [
          `Your peer has responded with their critique. Address their specific objections:`,
          `1. If they challenged a question you support — DEFEND it with evidence or CONCEDE and remove it.`,
          `2. If they proposed a question you think is weak — explain specifically why.`,
          `3. Produce YOUR current proposed consensus list (may differ from peer's).`,
          `4. Your "disagreements" should list ONLY remaining objections to the peer's latest list.`,
          `5. When you have ZERO disagreements, that means you FULLY ENDORSE the current list as-is.`,
        ].join("\n"),
    "",
    `Respond ONLY with a JSON object:`,
    `{`,
    `  "actor": "${input.role}",`,
    `  "rawText": "your full reasoning about which questions to keep, add, or remove",`,
    `  "summary": "one paragraph summary of your position",`,
    `  "newInsights": [...],`,
    `  "assumptions": [...],`,
    `  "disagreements": ["specific objections to current question list — EMPTY means you agree"],`,
    `  "questionsForPeer": [...],`,
    `  "questionsForHuman": [],`,
    `  "proposedSpecDelta": "",`,
    `  "milestoneReached": null,`,
    `  "implementationPlan": null,`,
    `  "proposedQuestions": null,`,
    `  "degraded": false,`,
    `  "synthesizedQuestions": [`,
    `    { "text": "question", "priority": 1, "rationale": "why this matters" }`,
    `  ],`,
    `  "followUpQuestions": null,`,
    `  "sufficientContext": null,`,
    `  "walkthroughGaps": null`,
    `}`,
    "",
    `---`,
    "",
    `ORIGINAL PROBLEM:`,
    input.originalProblem,
    "",
    `---`,
    "",
    `DR. CHEN'S ANALYSIS:`,
    input.gptAnalysis,
    "",
    `---`,
    "",
    `DR. RIVERA'S ANALYSIS:`,
    input.claudeAnalysis,
    "",
    `---`,
    "",
    `PROPOSED QUESTIONS (from independent analyses):`,
    questionList
  ];

  if (input.peerResponse) {
    sections.push(
      "",
      `---`,
      "",
      `PEER'S LATEST RESPONSE:`,
      input.peerResponse
    );
  }

  return sections.join("\n");
}

export function buildInterviewFollowUpPrompt(input: {
  role: "gpt" | "claude";
  originalProblem: string;
  questionText: string;
  questionRationale: string;
  answer: string;
  previousAnswers: Array<{ question: string; answer: string }>;
}): string {
  const previousContext = input.previousAnswers.length > 0
    ? input.previousAnswers
        .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
        .join("\n\n")
    : "None yet.";

  return [
    getPersona(input.role),
    "",
    ANTI_SYCOPHANCY,
    "",
    `PHASE: INTERVIEW EVALUATION`,
    `The human has answered an interview question. Evaluate the answer critically — do NOT accept vague or incomplete answers as sufficient.`,
    `If the answer is evasive, incomplete, or raises new concerns, say so directly and propose follow-up questions.`,
    "",
    `Respond ONLY with a JSON object:`,
    `{`,
    `  "actor": "${input.role}",`,
    `  "rawText": "your evaluation of the answer",`,
    `  "summary": "one paragraph summary",`,
    `  "newInsights": ["insights gained from this answer"],`,
    `  "assumptions": ["assumptions resolved or new ones identified"],`,
    `  "disagreements": [],`,
    `  "questionsForPeer": [],`,
    `  "questionsForHuman": [],`,
    `  "proposedSpecDelta": "",`,
    `  "milestoneReached": null,`,
    `  "implementationPlan": null,`,
    `  "proposedQuestions": null,`,
    `  "synthesizedQuestions": null,`,
    `  "degraded": false,`,
    `  "followUpQuestions": [`,
      `    { "text": "follow-up question", "priority": 1, "rationale": "why needed" }`,
    `  ],`,
    `  "sufficientContext": true/false,`,
    `  "walkthroughGaps": null`,
    `}`,
    "",
    `0-2 follow-up questions. Set sufficientContext to true if no follow-ups are needed for this topic.`,
    "",
    `---`,
    "",
    `ORIGINAL PROBLEM:`,
    input.originalProblem,
    "",
    `---`,
    "",
    `PREVIOUS Q&A:`,
    previousContext,
    "",
    `---`,
    "",
    `CURRENT QUESTION: ${input.questionText}`,
    `RATIONALE: ${input.questionRationale}`,
    `HUMAN'S ANSWER: ${input.answer}`
  ].join("\n");
}

export function buildSpecPrompt(input: {
  role: "gpt" | "claude";
  originalProblem: string;
  interviewResults: Array<{ question: string; answer: string }>;
  approachResult: string;
  peerDraft?: string;
}): string {
  const interviewContext = input.interviewResults
    .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
    .join("\n\n");

  const sections = [
    getPersona(input.role),
    "",
    ANTI_SYCOPHANCY,
    "",
    `PHASE: SPEC GENERATION`,
    input.peerDraft
      ? `Review and finalize the following drafts. Do NOT rubber-stamp them — find gaps, contradictions, and missing edge cases. Fix every issue you find. Produce TWO separate markdown documents.`
      : `Based on the converged approach, produce TWO separate markdown documents:`,
    "",
    `DOCUMENT 1 — SPECIFICATION:`,
    `- Goal: What we're building and why, with explicit non-goals`,
    `- Architecture: System design, key components, data flow`,
    `- Tech Stack: Technologies with justifications`,
    `- Key design decisions and their rationale`,
    `- Acceptance criteria`,
    `- Risks and mitigations`,
    "",
    `DOCUMENT 2 — IMPLEMENTATION PLAN:`,
    `- Tasks: Ordered, bite-sized, TDD-friendly`,
    `- Each task: what to test first, what files to create/modify, "done when" criteria`,
    `- Exact file paths where possible`,
    `- Complexity estimate (S/M/L) per task`,
    `- Dependencies between tasks`,
    `- Suggested sprint groupings`,
    "",
    `Respond ONLY with a JSON object:`,
    `{`,
    `  "actor": "${input.role}",`,
    `  "rawText": "brief overview of both documents",`,
    `  "summary": "one paragraph summary",`,
    `  "newInsights": [],`,
    `  "assumptions": [],`,
    `  "disagreements": [],`,
    `  "questionsForPeer": [],`,
    `  "questionsForHuman": [],`,
    `  "proposedSpecDelta": "DOCUMENT 1 (the full specification in markdown)",`,
    `  "milestoneReached": "implementation_plan_ready",`,
    `  "degraded": false,`,
    `  "implementationPlan": "DOCUMENT 2 (the full implementation plan in markdown)",`,
    `  "proposedQuestions": null,`,
    `  "synthesizedQuestions": null,`,
    `  "followUpQuestions": null,`,
    `  "sufficientContext": null,`,
    `  "walkthroughGaps": null`,
    `}`,
    "",
    `---`,
    "",
    `ORIGINAL PROBLEM:`,
    input.originalProblem,
    "",
    `---`,
    "",
    `INTERVIEW RESULTS:`,
    interviewContext,
    "",
    `---`,
    "",
    `CONVERGED APPROACH:`,
    input.approachResult
  ];

  if (input.peerDraft) {
    sections.push(
      "",
      `---`,
      "",
      `PEER'S DRAFTS:`,
      input.peerDraft
    );
  }

  return sections.join("\n");
}

/**
 * Build an adversarial walkthrough prompt. Both models independently simulate
 * executing the spec step-by-step against a concrete scenario, surfacing
 * operational gaps that internal-consistency review cannot catch.
 */
export function buildWalkthroughPrompt(input: {
  role: "gpt" | "claude";
  originalProblem: string;
  spec: string;
  implementationPlan: string;
}): string {
  return [
    getPersona(input.role),
    "",
    ANTI_SYCOPHANCY,
    "",
    `PHASE: ADVERSARIAL WALKTHROUGH`,
    `You have a finished spec and implementation plan. Your job is NOT to review them as documents — that has already been done.`,
    `Instead, you must SIMULATE EXECUTING the spec. Pretend you are an agent (or team of agents) who has been handed this spec and must follow it to produce the described outputs.`,
    "",
    `Walk through the spec step by step, from start to finish. At each step, ask yourself:`,
    `1. What information do I need that the spec does not tell me? (missing operational details)`,
    `2. Where must I make a judgment call because the spec is ambiguous? (underspecified behavior)`,
    `3. Where do two instructions conflict when applied simultaneously? (runtime contradictions)`,
    `4. What happens at the boundaries — when agents hand off, when phases transition, when things run concurrently?`,
    `5. Are there resource constraints (context windows, token budgets, time) that make a step infeasible as written?`,
    "",
    `For each gap you find, provide:`,
    `- WHERE in the spec the gap exists (section or quote)`,
    `- WHAT goes wrong when you try to execute it`,
    `- A CONCRETE FIX (specific text to add or change, not "consider addressing this")`,
    "",
    `The \`walkthroughGaps\` array is the canonical machine-readable output.`,
    `Every actionable issue mentioned in \`rawText\` MUST also appear in \`walkthroughGaps\`.`,
    `Do NOT leave \`walkthroughGaps\` empty unless you genuinely found zero operational gaps.`,
    "",
    `If you find no gaps, say so — but be skeptical. A spec this complex almost certainly has execution-time issues that document review missed.`,
    "",
    `Respond ONLY with a JSON object:`,
    `{`,
    `  "actor": "${input.role}",`,
    `  "rawText": "your full walkthrough with all gaps found",`,
    `  "summary": "one paragraph summary of findings",`,
    `  "newInsights": ["insight1", ...],`,
    `  "assumptions": [],`,
    `  "disagreements": [],`,
    `  "questionsForPeer": [],`,
    `  "questionsForHuman": [],`,
    `  "proposedSpecDelta": "",`,
    `  "milestoneReached": null,`,
    `  "implementationPlan": null,`,
    `  "proposedQuestions": null,`,
    `  "synthesizedQuestions": null,`,
    `  "followUpQuestions": null,`,
    `  "sufficientContext": null,`,
    `  "degraded": false,`,
    `  "walkthroughGaps": [`,
    `    {`,
    `      "location": "section or quote in the spec",`,
    `      "issue": "what goes wrong at execution time",`,
    `      "fix": "concrete change to the spec"`,
    `    }`,
    `  ]`,
    `}`,
    "",
    `---`,
    "",
    `ORIGINAL PROBLEM:`,
    input.originalProblem,
    "",
    `---`,
    "",
    `SPECIFICATION:`,
    input.spec,
    "",
    `---`,
    "",
    `IMPLEMENTATION PLAN:`,
    input.implementationPlan
  ].join("\n");
}
