import { GPT_PERSONA, CLAUDE_PERSONA, ANTI_SYCOPHANCY } from "./structured-turn";

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
    `3. For each question, explain it in plain human language, not builder jargon`,
    `4. For each question, give your current best recommendation so the human can either decide for themselves or let Crossfire decide`,
    "",
    `Respond ONLY with a JSON object matching this schema:`,
    `{`,
    `  "rawText": "your full analysis as readable text",`,
    `  "summary": "one paragraph summary",`,
    `  "newInsights": ["insight1", ...],`,
    `  "assumptions": ["assumption1", ...],`,
    `  "questionsForHuman": ["question1", ...],`,
    `  "proposedQuestions": [`,
    `    {`,
    `      "text": "question in plain human language",`,
    `      "priority": 1,`,
    `      "rationale": "why this decision matters to the design",`,
    `      "context": "what this means in practice, in plain English",`,
    `      "recommendation": "Crossfire's best current recommendation",`,
    `      "recommendationReasoning": "why this is the current best recommendation and when it might change"`,
    `    }`,
    `  ]`,
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
  allQuestions: Array<{
    text: string;
    priority: number;
    rationale: string;
    context?: string | null;
    recommendation?: string | null;
    recommendationReasoning?: string | null;
    proposedBy: string;
  }>;
  peerResponse?: string;
  turnNumber: number;
  totalTurns: number;
}): string {
  const questionList = input.allQuestions
    .map((q, i) => [
      `  ${i + 1}. [Priority ${q.priority}] (${q.proposedBy}) ${q.text}`,
      `     Why it matters: ${q.rationale}`,
      q.context ? `     Plain-English context: ${q.context}` : null,
      q.recommendation ? `     Current recommendation: ${q.recommendation}` : null,
      q.recommendationReasoning ? `     Recommendation reasoning: ${q.recommendationReasoning}` : null
    ].filter(Boolean).join("\n"))
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
    `This debate stops only on consensus, explicit clarification blocking, or the turn cap.`,
    `There is no fixed cap on the number of questions — include as many as are genuinely necessary, but not more.`,
    `Every final interview question must help a human who may prefer Crossfire's recommendation over making the decision manually.`,
    "",
    `QUESTION-DEBATE CONTRACT:`,
    `- synthesizedQuestions: your current proposed consensus list for the interview.`,
    `- disagreements: specific objections to the peer's latest proposed list; leave this empty ONLY when you fully endorse that list as-is.`,
    `- questionsForHuman: use ONLY when the debate cannot continue without clarification from the human. Do NOT put normal interview questions there.`,
    `- Each synthesized question must include plain-English context plus Crossfire's current recommendation and why.`,
    "",
    isFirstTurn
      ? [
          `This is the FIRST turn. Both you and your peer independently analyzed the problem and proposed questions.`,
          `Start from the combined proposed list from both analyses.`,
          `Your job now:`,
          `1. Review ALL proposed questions critically — challenge each one.`,
          `2. Remove questions that are redundant, low-value, or answerable from the problem statement.`,
          `3. Merge semantically similar questions into a single, well-phrased question.`,
          `4. Add a question only if a critical design decision would otherwise remain under-specified.`,
          `5. Put your best current proposed consensus list in "synthesizedQuestions".`,
          `6. Translate each final question into plain human language and include a recommendation the human can adopt if they want Crossfire to decide.`,
          `7. Use "disagreements" for the specific changes you want from the combined starting list.`,
          `8. Leave "questionsForHuman" empty unless the debate is blocked on missing human clarification.`,
        ].join("\n")
      : [
          `Your peer has responded with their critique and latest proposed list.`,
          `Stay on unresolved question-selection issues only. Do NOT restart broad problem analysis.`,
          `Address their specific objections:`,
          `1. If they challenged a question you support — DEFEND it with evidence or CONCEDE and remove it.`,
          `2. If they proposed a question you think is weak, redundant, or already answered — explain specifically why.`,
          `3. Merge semantically similar questions into a single, well-phrased question before finalizing your list.`,
          `4. Put YOUR current proposed consensus list in "synthesizedQuestions" (it may still differ from your peer's).`,
          `5. Preserve plain-English context and a concrete recommendation for every final question.`,
          `6. "disagreements" must list ONLY remaining specific objections to the peer's latest proposed list. Leave it empty ONLY if you fully endorse that list as-is.`,
          `7. Put items in "questionsForHuman" ONLY when the debate cannot continue without clarification from the human; do not move ordinary interview questions there.`,
        ].join("\n"),
    "",
    `Before finalizing your list, merge any questions that ask for the same information in different words into a single, well-phrased question. Do not include multiple questions that differ only in wording or framing.`,
    `If you request clarification, still provide your best current "synthesizedQuestions" list alongside the blocker in "questionsForHuman".`,
    "",
    `Respond ONLY with a JSON object:`,
    `{`,
    `  "rawText": "your full reasoning about which questions to keep, add, or remove",`,
    `  "summary": "one paragraph summary of your position",`,
    `  "newInsights": [...],`,
    `  "assumptions": [...],`,
    `  "disagreements": ["specific objections to the peer's latest proposed list — EMPTY only on full endorsement"],`,
    `  "questionsForHuman": ["clarification needed before debate can continue"],`,
    `  "synthesizedQuestions": [`,
    `    {`,
    `      "text": "question in plain human language",`,
    `      "priority": 1,`,
    `      "rationale": "why this decision matters to the design",`,
    `      "context": "what this means in practice, in plain English",`,
    `      "recommendation": "Crossfire's best current recommendation",`,
    `      "recommendationReasoning": "why this is the current best recommendation and when it might change"`,
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
    `  "rawText": "brief overview of both documents",`,
    `  "summary": "one paragraph summary",`,
    `  "proposedSpecDelta": "DOCUMENT 1 (the full specification in markdown)",`,
    `  "milestoneReached": "implementation_plan_ready",`,
    `  "implementationPlan": "DOCUMENT 2 (the full implementation plan in markdown)"`,
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
    `If multiple issues stem from the same root cause, merge them into a single gap entry.`,
    `Reference all affected sections in the location field, and propose one fix that addresses the root cause rather than listing each symptom separately.`,
    "",
    `The \`walkthroughGaps\` array is the canonical machine-readable output.`,
    `Every actionable issue mentioned in \`rawText\` MUST also appear in \`walkthroughGaps\`.`,
    `Do NOT leave \`walkthroughGaps\` empty unless you genuinely found zero operational gaps.`,
    "",
    `If you find no gaps, say so — but be skeptical. A spec this complex almost certainly has execution-time issues that document review missed.`,
    "",
    `Respond ONLY with a JSON object:`,
    `{`,
    `  "rawText": "your full walkthrough with all gaps found",`,
    `  "summary": "one paragraph summary of findings",`,
    `  "newInsights": ["insight1", ...],`,
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
