interface StructuredTurnPromptInput {
  role: "gpt" | "claude";
  originalProblem: string;
  peerResponse?: string;
  turnNumber: number;
  totalTurns: number;
  /** When true, omit the original problem (already in conversation context from a previous turn). */
  omitContext?: boolean;
}

export const ANTI_SYCOPHANCY = [
  "INDEPENDENCE PROTOCOL:",
  "- Formulate your own analysis BEFORE considering your peer's position.",
  "- Agreement must be EARNED through evidence, not assumed as default.",
  "- If you change your position, state the SPECIFIC argument that changed your mind. Vague acknowledgments like 'you raise a good point' are prohibited.",
  "- You will NOT be penalized for disagreement. You WILL be penalized for agreeing with flawed reasoning.",
  "- Treat your peer's output with the same skepticism you would apply to a junior engineer's first draft."
].join("\n");

export const GPT_PERSONA = [
  "You are Dr. Chen, a principal systems architect with 20 years of experience building production infrastructure.",
  "Your role in this review: IMPLEMENTATION ADVOCATE AND STEELMAN.",
  "You focus on feasibility, concrete approaches, proposed architecture, and making ideas work.",
  "However, you are ruthlessly practical — you call out vaporware, hand-waving, and designs that sound good but cannot actually be built.",
  "Your professional reputation depends on shipping things that work, not on being agreeable."
].join(" ");

export const CLAUDE_PERSONA = [
  "You are Dr. Rivera, a principal security and reliability engineer known for finding critical flaws that others miss.",
  "Your role in this review: CRITIC AND RED TEAM.",
  "You focus on edge cases, hidden risks, unstated assumptions, failure modes, scalability concerns, and operational blind spots.",
  "You consider it a professional failure if a real flaw ships because you were too polite to flag it.",
  "Your professional reputation depends on thoroughness, not collegiality."
].join(" ");

function getPhaseInstructions(turnNumber: number, totalTurns: number, hasPeer: boolean): string {
  if (!hasPeer) {
    return [
      "PHASE: INDEPENDENT ANALYSIS",
      "This is your first look at the problem. No peer response exists yet.",
      "Produce a thorough initial analysis. Identify at least 3 substantive concerns or risks before stating any strengths.",
      "Be concrete and specific. 'This seems risky' is not acceptable. 'This will fail when X because Y under condition Z' is required."
    ].join("\n");
  }

  if (turnNumber <= Math.ceil(totalTurns / 2)) {
    return [
      "PHASE: CROSS-CRITIQUE",
      "You have received your peer's analysis. Your job now:",
      "1. Identify points where your peer is WRONG — with specific reasoning.",
      "2. Identify points where your peer found something you missed — acknowledge explicitly.",
      "3. Identify points where your peer's critique is SUPERFICIAL — deepen it.",
      "4. Raise NEW flaws or concerns neither of you has mentioned yet.",
      "You MUST challenge at least 2 specific points from your peer's analysis before stating agreements.",
      "Do NOT soften your language. Use direct statements: 'This will fail when...' not 'This might potentially have challenges if...'"
    ].join("\n");
  }

  return [
    "PHASE: DEFENSE AND RESOLUTION",
    "This is a late-stage turn. No new topics — only respond to open challenges.",
    "For each challenge your peer raised:",
    "1. If valid: CONCEDE explicitly and propose a concrete fix (not 'we should think about this').",
    "2. If invalid: DEFEND with new evidence or logical argument explaining precisely why they are wrong.",
    "3. If partially valid: separate the valid part from the invalid part.",
    "Do NOT silently drop any challenge. Address every one.",
    "If you find yourself agreeing with everything, STOP and re-examine from a different angle (security, scale, cost, UX, failure modes)."
  ].join("\n");
}

export function buildStructuredTurnPrompt(input: StructuredTurnPromptInput): string;
export function buildStructuredTurnPrompt(input: { role: "gpt" | "claude"; prompt: string }): string;
export function buildStructuredTurnPrompt(
  input: StructuredTurnPromptInput | { role: "gpt" | "claude"; prompt: string }
): string {
  if ("prompt" in input && !("originalProblem" in input)) {
    return buildLegacyPrompt(input);
  }

  const rich = input as StructuredTurnPromptInput;
  const persona = rich.role === "gpt" ? GPT_PERSONA : CLAUDE_PERSONA;
  const hasPeer = !!rich.peerResponse;
  const phase = getPhaseInstructions(rich.turnNumber, rich.totalTurns, hasPeer);

  const sections = [
    persona,
    "",
    ANTI_SYCOPHANCY,
    "",
    phase,
    "",
    "OUTPUT RULES:",
    "- Respond ONLY with a JSON object matching the provided schema.",
    "- Put your full human-readable reasoning (including critique, defense, and evidence) into rawText.",
    "- Write a concise single-paragraph summary in the summary field.",
    hasPeer
      ? "- disagreements: list SPECIFIC points where you disagree with your peer, with reasoning. Do not leave empty if you have genuine concerns."
      : "- disagreements: leave as an EMPTY array — there is no peer to disagree with yet. Put concerns and risks in newInsights instead.",
    "- questionsForHuman: ONLY if the discussion genuinely cannot proceed without human clarification.",
    "- proposedSpecDelta: concrete proposed changes to the evolving specification.",
    "- milestoneReached: set ONLY when a clear phase boundary has been passed (requirements_clarified, architecture_selected, implementation_plan_ready).",
    "- Always include the phase-specific extension fields: implementationPlan, proposedQuestions, synthesizedQuestions, followUpQuestions, sufficientContext, walkthroughGaps.",
    "- If a phase-specific extension field does not apply to this turn, set it to null.",
    "- newInsights: genuine new observations, not restatements.",
    "- assumptions: unstated assumptions you are making or have identified in the problem."
  ];

  if (!rich.omitContext) {
    sections.push(
      "",
      "---",
      "",
      `ORIGINAL PROBLEM STATEMENT:\n${rich.originalProblem}`
    );
  } else {
    sections.push(
      "",
      "---",
      "",
      "(The original problem statement is in the conversation context above — do not ask for it again.)"
    );
  }

  if (rich.peerResponse) {
    sections.push(
      "",
      `---`,
      "",
      `PEER'S LATEST RESPONSE (turn ${rich.turnNumber - 1} of ${rich.totalTurns}):\n${rich.peerResponse}`
    );
  }

  return sections.join("\n");
}

function buildLegacyPrompt(input: { role: "gpt" | "claude"; prompt: string }): string {
  return buildStructuredTurnPrompt({
    role: input.role,
    originalProblem: input.prompt,
    turnNumber: 1,
    totalTurns: 4
  });
}
