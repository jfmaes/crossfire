export interface FeedbackChunk {
  id: string;
  index: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface RequestedFeedbackChange {
  summary: string;
  sourceChunkIds: string[];
}

export interface FeedbackExcerptSelectionResult {
  blocked: boolean;
  text: string;
  selectedChunkIds: string[];
  missingChunkIds: string[];
}

export interface RevisionBudgetLedger {
  feedbackRawChars: number;
  feedbackDigestChars: number;
  feedbackExcerptsChars: number;
  currentSpecChars: number;
  currentPlanChars: number;
}

export function chunkFeedback(
  raw: string,
  options: { chunkSize?: number; overlap?: number } = {}
): FeedbackChunk[] {
  const chunkSize = options.chunkSize ?? 4_000;
  const overlap = options.overlap ?? 300;

  if (!Number.isSafeInteger(chunkSize)) {
    throw new Error("chunkSize must be a safe integer");
  }
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0");
  }
  if (!Number.isSafeInteger(overlap)) {
    throw new Error("overlap must be a safe integer");
  }
  if (overlap < 0) {
    throw new Error("overlap must be greater than or equal to 0");
  }
  if (overlap >= chunkSize) {
    throw new Error("overlap must be less than chunkSize");
  }

  const chunks: FeedbackChunk[] = [];
  let start = 0;

  while (start < raw.length) {
    const end = Math.min(raw.length, start + chunkSize);
    chunks.push({
      id: `feedback-chunk-${chunks.length + 1}`,
      index: chunks.length,
      startOffset: start,
      endOffset: end,
      text: raw.slice(start, end)
    });
    if (end === raw.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function selectFeedbackExcerpts(input: {
  chunks: FeedbackChunk[];
  requestedChanges: RequestedFeedbackChange[];
  budgetChars: number;
}): FeedbackExcerptSelectionResult {
  if (!Number.isSafeInteger(input.budgetChars) || input.budgetChars < 0) {
    throw new Error("budgetChars must be a non-negative safe integer");
  }

  const requested = new Set(input.requestedChanges.flatMap((change) => change.sourceChunkIds));
  const available = new Set(input.chunks.map((chunk) => chunk.id));
  const missingChunkIds = Array.from(requested).filter((chunkId) => !available.has(chunkId));
  const selected = input.chunks.filter((chunk) => requested.has(chunk.id));
  const text = selected
    .map((chunk) => `### ${chunk.id} [${chunk.startOffset}-${chunk.endOffset}]\n${chunk.text}`)
    .join("\n\n");

  return {
    blocked: missingChunkIds.length > 0 || text.length > input.budgetChars,
    text,
    selectedChunkIds: selected.map((chunk) => chunk.id),
    missingChunkIds
  };
}

export function buildRevisionBudgetLedger(input: {
  feedbackRaw: string;
  feedbackDigest: string;
  feedbackExcerpts: string;
  currentSpec: string;
  currentPlan: string;
}): RevisionBudgetLedger {
  return {
    feedbackRawChars: input.feedbackRaw.length,
    feedbackDigestChars: input.feedbackDigest.length,
    feedbackExcerptsChars: input.feedbackExcerpts.length,
    currentSpecChars: input.currentSpec.length,
    currentPlanChars: input.currentPlan.length
  };
}
