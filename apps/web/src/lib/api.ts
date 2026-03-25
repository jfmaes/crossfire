export interface InterviewQuestionState {
  id: string;
  text: string;
  priority: number;
  rationale: string;
  proposedBy: string;
  answer: string | null;
}

export interface InterviewState {
  questions: InterviewQuestionState[];
  currentQuestion: { id: string; text: string; rationale: string } | null;
  totalQuestions: number;
  answeredCount: number;
}

export interface SessionPayload {
  session: {
    id: string;
    title: string;
    status: string;
    phase?: string | null;
    prompt?: string | null;
  };
  summary: {
    currentUnderstanding: string;
    recommendation: string;
    changedSinceLastCheckpoint: string[];
    openRisks: string[];
    decisionsNeeded: string[];
    artifactPath?: string | null;
  };
  activeRun?: {
    id: string;
    sessionId: string;
    kind: string;
    status: string;
    phase?: string | null;
    startedAt: string;
    finishedAt?: string | null;
    errorMessage?: string | null;
  };
  recentRuns?: Array<{
    id: string;
    sessionId: string;
    kind: string;
    status: string;
    phase?: string | null;
    startedAt: string;
    finishedAt?: string | null;
    errorMessage?: string | null;
  }>;
  artifactPath?: string | null;
  phaseResult?: unknown;
  analysisResult?: {
    gptAnalysis: string;
    claudeAnalysis: string;
    proposedQuestions: Array<{
      text: string;
      priority: number;
      rationale: string;
      proposedBy: string;
    }>;
    debateSummary?: string;
  };
  interviewState?: InterviewState;
}

export interface SessionRun {
  id: string;
  sessionId: string;
  kind: string;
  status: string;
  phase?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  errorMessage?: string | null;
}

export interface SessionRunEvent {
  id: string;
  runId: string;
  sessionId: string;
  type: string;
  message: string;
  model?: string | null;
  phase?: string | null;
  turnNumber?: number | null;
  elapsedMs?: number | null;
  disagreements?: number | null;
  createdAt: string;
}

export interface RuntimeStatus {
  providerMode: string;
  providers: {
    gpt: { ok: boolean; detail: string };
    claude: { ok: boolean; detail: string };
  };
}

function getToken() {
  return localStorage.getItem("council-token") ?? "local-dev-token";
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Ignore non-JSON error bodies
  }

  return fallback;
}

export async function createSession(input: {
  title: string;
  prompt: string;
  token: string;
  baseUrl?: string;
}) {
  const body = {
    title: input.title,
    prompt: input.prompt
  };

  const response = await fetch(`${input.baseUrl ?? ""}/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-council-token": input.token
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to create session: ${response.status}`));
  }

  return (await response.json()) as SessionPayload;
}

export async function continueSession(input: {
  sessionId: string;
  humanResponse: string;
  token: string;
  baseUrl?: string;
}) {
  const response = await fetch(`${input.baseUrl ?? ""}/sessions/${input.sessionId}/continue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-council-token": input.token
    },
    body: JSON.stringify({
      humanResponse: input.humanResponse
    })
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to continue session: ${response.status}`));
  }

  return (await response.json()) as SessionPayload;
}

export interface SessionListItem {
  id: string;
  title: string;
  status: string;
  phase?: string | null;
}

export async function listSessions(baseUrl = "") {
  const response = await fetch(`${baseUrl}/sessions`, {
    headers: {
      "x-council-token": getToken()
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to list sessions: ${response.status}`));
  }

  return (await response.json()) as SessionListItem[];
}

export async function getSession(input: {
  sessionId: string;
  token: string;
  baseUrl?: string;
}) {
  const response = await fetch(`${input.baseUrl ?? ""}/sessions/${input.sessionId}`, {
    headers: {
      "x-council-token": input.token
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to get session: ${response.status}`));
  }

  return (await response.json()) as SessionPayload;
}

export async function restartSession(input: {
  sessionId: string;
  token: string;
  baseUrl?: string;
}) {
  const response = await fetch(`${input.baseUrl ?? ""}/sessions/${input.sessionId}/restart`, {
    method: "POST",
    headers: {
      "x-council-token": input.token
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to restart session: ${response.status}`));
  }

  return (await response.json()) as SessionPayload;
}

export async function getRunEvents(input: {
  runId: string;
  token: string;
  baseUrl?: string;
}) {
  const response = await fetch(`${input.baseUrl ?? ""}/runs/${input.runId}/events`, {
    headers: {
      "x-council-token": input.token
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to get run events: ${response.status}`));
  }

  return (await response.json()) as SessionRunEvent[];
}

export async function deleteSession(input: {
  sessionId: string;
  token: string;
  baseUrl?: string;
}) {
  const response = await fetch(`${input.baseUrl ?? ""}/sessions/${input.sessionId}`, {
    method: "DELETE",
    headers: {
      "x-council-token": input.token
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to delete session: ${response.status}`));
  }
}

export async function exportSession(input: {
  sessionId: string;
  token: string;
  baseUrl?: string;
}) {
  const response = await fetch(`${input.baseUrl ?? ""}/sessions/${input.sessionId}/export`, {
    headers: {
      "x-council-token": input.token
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to export session: ${response.status}`));
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  const fileNameMatch = disposition?.match(/filename="(.+)"/);
  const fileName = fileNameMatch?.[1] ?? `crossfire-session-${input.sessionId.slice(0, 8)}.json`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function getHealth(baseUrl = "") {
  const response = await fetch(`${baseUrl}/health`, {
    headers: {
      "x-council-token": getToken()
    }
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, `Failed to load health: ${response.status}`));
  }

  return (await response.json()) as RuntimeStatus;
}
