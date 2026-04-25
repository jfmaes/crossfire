import {
  applyModelTurn,
  createSessionState,
} from "@council/core";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter } from "@council/adapters";
import { emitProgress, summarizeProgressText } from "./progress";
import { debugLogPrompt, debugLogResponse } from "./debug-log";
import { validatePhaseTurn } from "./phase-validation";

interface OrchestratorInput {
  gpt: ProviderAdapter;
  claude: ProviderAdapter;
}

interface RunRoundOptions {
  sessionId: string;
  prompt: string;
  runId?: string;
  /** Maximum turns before forcing a stop. Default: 14. */
  maxTurns?: number;
}

/**
 * Check if the last two turns (one from each model) show consensus:
 * both have zero disagreements.
 *
 * Requires at least 4 turns (2 full exchanges) before consensus can be
 * declared — the first exchange always has empty disagreements on the
 * opening turn because there is no peer to disagree with yet.
 */
function hasReachedConsensus(turns: ModelTurn[]): boolean {
  const latest = turns.at(-1);
  if (!latest) return false;

  // Need at least 4 turns (2 full exchanges) to assess genuine consensus.
  // The first turn always has empty disagreements because there's no peer yet,
  // so checking after only 2 turns would always false-positive.
  if (turns.length < 4) return false;

  const previous = turns.at(-2)!;

  // Both models have no remaining disagreements
  const latestClean = latest.disagreements.length === 0;
  const previousClean = previous.disagreements.length === 0;

  return latestClean && previousClean;
}

function extractJsonFromText(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function toStructuredRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function collectFinalDisagreements(turns: Array<Pick<ModelTurn, "disagreements">>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const turn of turns) {
    for (const disagreement of turn.disagreements) {
      const normalized = disagreement.toLowerCase().trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(disagreement);
    }
  }

  return result;
}

export function createOrchestrator(input: OrchestratorInput) {
  const providers = [input.gpt, input.claude];

  return {
    async runRound({ sessionId, prompt, runId, maxTurns = 14 }: RunRoundOptions) {
      let state = createSessionState();
      let peerResponse: string | undefined;
      let stopReason: "consensus" | "questions_for_human" | "max_turns" = "max_turns";

      emitProgress({ sessionId, runId, type: "info", message: `Debate: up to ${maxTurns} turns, stopping on consensus` });

      for (let i = 0; i < maxTurns; i++) {
        const provider = providers[i % 2];
        const turnNumber = i + 1;
        const model = provider.name.toUpperCase();
        const turnStart = Date.now();
        let providerError: string | null = null;
        let completedTurn: ModelTurn | null = null;
        let conversationReused = false;
        let rawResponse = "";
        emitProgress({ sessionId, runId, type: "model_start", model: provider.name as "gpt" | "claude", turnNumber, message: `Turn ${turnNumber}...` });

        const actualPrompt = peerResponse ?? prompt;
        debugLogPrompt({
          sessionId,
          phase: "approach_debate",
          model: provider.name as "gpt" | "claude",
          prompt: actualPrompt,
          turnNumber
        });

        for await (const event of provider.sendTurn({
          sessionId,
          prompt: actualPrompt,
          originalProblem: prompt,
          peerResponse,
          turnNumber,
          totalTurns: maxTurns
        })) {
          if (event.type === "stderr") {
            emitProgress({
              sessionId,
              runId,
              type: "model_stream",
              model: provider.name as "gpt" | "claude",
              turnNumber,
              message: summarizeProgressText(event.text)
            });
            continue;
          }

          if (event.type === "progress") {
            emitProgress({
              sessionId,
              runId,
              type: "model_progress",
              model: provider.name as "gpt" | "claude",
              turnNumber,
              message: summarizeProgressText(event.text)
            });
            continue;
          }

          if (event.type === "error") {
            providerError = event.message;
            continue;
          }

          if (event.type === "structured_turn") {
            completedTurn = event.turn;
            conversationReused = event.conversationReused ?? false;
            rawResponse = event.rawResponse;
          }
        }

        const turnElapsedMs = Date.now() - turnStart;
        const turnElapsed = (turnElapsedMs / 1000).toFixed(1);

        if (providerError || !completedTurn) {
          const errorMessage = providerError ?? `${model} returned no output`;
          emitProgress({
            sessionId,
            runId,
            type: "info",
            model: provider.name as "gpt" | "claude",
            turnNumber,
            elapsedMs: turnElapsedMs,
            metadata: {
              outputStatus: "provider_error",
              conversationReused
            },
            message: `Turn ${turnNumber} failed in ${turnElapsed}s — ${errorMessage}`
          });

          debugLogResponse({
            sessionId,
            phase: "approach_debate",
            model: provider.name as "gpt" | "claude",
            rawText: completedTurn?.rawText ?? "",
            parsed: { error: errorMessage },
            turnNumber,
            elapsedMs: turnElapsedMs
          });

          throw new Error(`${model} approach_debate failed on turn ${turnNumber}: ${errorMessage}`);
        }

        if (completedTurn.degraded) {
          emitProgress({
            sessionId,
            runId,
            type: "info",
            model: provider.name as "gpt" | "claude",
            turnNumber,
            elapsedMs: turnElapsedMs,
            metadata: {
              outputStatus: "degraded",
              stopReason: "phase_invalid_turn",
              conversationReused
            },
            message: `Debate stopped on turn ${turnNumber} — degraded structured output`
          });

          debugLogResponse({
            sessionId,
            phase: "approach_debate",
            model: provider.name as "gpt" | "claude",
            rawText: completedTurn.rawText,
            parsed: {
              actor: completedTurn.actor,
              summary: completedTurn.summary,
              disagreements: completedTurn.disagreements,
              questionsForHuman: completedTurn.questionsForHuman,
              milestoneReached: completedTurn.milestoneReached,
              degraded: true
            },
            turnNumber,
            elapsedMs: turnElapsedMs
          });

          throw new Error(`${model} approach_debate failed on turn ${turnNumber}: degraded structured output`);
        }

        const validation = validatePhaseTurn(
          "approach_debate",
          rawResponse ? extractJsonFromText(rawResponse) : toStructuredRecord(completedTurn)
        );

        if (!validation.ok) {
          emitProgress({
            sessionId,
            runId,
            type: "info",
            model: provider.name as "gpt" | "claude",
            turnNumber,
            elapsedMs: turnElapsedMs,
            metadata: {
              outputStatus: "phase_invalid",
              missingFields: validation.missingFields,
              stopReason: "phase_invalid_turn",
              conversationReused
            },
            message: `Debate stopped on turn ${turnNumber} — phase-invalid structured output (${validation.missingFields.join(", ")})`
          });

          throw new Error(`${model} approach_debate failed on turn ${turnNumber}: missing required fields: ${validation.missingFields.join(", ")}`);
        }

        peerResponse = completedTurn.rawText || completedTurn.summary;

        if (completedTurn.proposedSpecDelta) {
          peerResponse = `${peerResponse}\n\nProposed spec delta:\n${completedTurn.proposedSpecDelta}`;
        }

        state = applyModelTurn(state, completedTurn);

        const latest = state.turns.at(-1);
        const disagreementCount = latest?.disagreements.length ?? 0;
        const milestone = latest?.milestoneReached;
        emitProgress({
          sessionId,
          runId,
          type: "model_done",
          model: provider.name as "gpt" | "claude",
          turnNumber,
          disagreements: disagreementCount,
          elapsedMs: turnElapsedMs,
          metadata: {
            outputStatus: "ok",
            missingFields: validation.missingFields,
            conversationReused,
            stopReason: null
          },
          message: `Turn ${turnNumber} done in ${turnElapsed}s — ${disagreementCount} disagreements${milestone ? `, milestone: ${milestone}` : ""}`
        });

        if (latest) {
          debugLogResponse({
            sessionId,
            phase: "approach_debate",
            model: provider.name as "gpt" | "claude",
            rawText: latest.rawText,
            parsed: {
              actor: latest.actor,
              summary: latest.summary,
              disagreements: latest.disagreements,
              questionsForHuman: latest.questionsForHuman,
              milestoneReached: latest.milestoneReached,
              newInsights: latest.newInsights,
              assumptions: latest.assumptions
            },
            turnNumber,
            elapsedMs: turnElapsedMs
          });
        }

        // Check for human questions that need escalation
        if (latest && latest.questionsForHuman.length > 0) {
          stopReason = "questions_for_human";
          emitProgress({
            sessionId,
            runId,
            type: "info",
            metadata: {
              stopReason
            },
            message: `Debate stopped: model has ${latest.questionsForHuman.length} question(s) for human`
          });
          break;
        }

        // Check for consensus
        if (hasReachedConsensus(state.turns)) {
          stopReason = "consensus";
          emitProgress({
            sessionId,
            runId,
            type: "consensus",
            metadata: {
              stopReason
            },
            message: `Debate stopped: consensus reached after ${turnNumber} turns`
          });
          break;
        }
      }

      if (stopReason === "max_turns" && state.exchangeCount >= maxTurns) {
        stopReason = "max_turns";
        emitProgress({
          sessionId,
          runId,
          type: "info",
          metadata: {
            stopReason
          },
          message: `Debate stopped: safety cap at ${maxTurns} turns`
        });
      }

      const finalDisagreements = collectFinalDisagreements(state.turns.slice(-2));
      emitProgress({
        sessionId,
        runId,
        type: "info",
        metadata: {
          stopReason,
          totalTurns: state.turns.length,
          finalDisagreementCount: finalDisagreements.length,
          finalDisagreements
        },
        message: `Debate finished after ${state.turns.length} turn(s) — ${stopReason.replaceAll("_", " ")}`
      });

      return { shouldCheckpoint: true, state, stopReason };
    }
  };
}
