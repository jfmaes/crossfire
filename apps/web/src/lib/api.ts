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
  artifactPath?: string | null;
  phaseResult?: unknown;
  interviewState?: InterviewState;
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

export async function createSession(input: {
  title: string;
  prompt: string;
  token: string;
  groundingRoot?: string;
  baseUrl?: string;
}) {
  const body: Record<string, string> = {
    title: input.title,
    prompt: input.prompt
  };
  if (input.groundingRoot) {
    body.groundingRoot = input.groundingRoot;
  }

  const response = await fetch(`${input.baseUrl ?? ""}/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-council-token": input.token
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`);
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
    throw new Error(`Failed to continue session: ${response.status}`);
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
    throw new Error(`Failed to list sessions: ${response.status}`);
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
    throw new Error(`Failed to get session: ${response.status}`);
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
    throw new Error(`Failed to restart session: ${response.status}`);
  }

  return (await response.json()) as SessionPayload;
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
    throw new Error(`Failed to delete session: ${response.status}`);
  }
}

export async function getHealth(baseUrl = "") {
  const response = await fetch(`${baseUrl}/health`, {
    headers: {
      "x-council-token": getToken()
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load health: ${response.status}`);
  }

  return (await response.json()) as RuntimeStatus;
}
