import {
  applyModelTurn,
  createSessionState,
} from "@council/core";
import type { ModelTurn } from "@council/core";
import type { ProviderAdapter } from "@council/adapters";
import { emitProgress } from "./progress";
import { debugLogPrompt, debugLogResponse } from "./debug-log";

interface OrchestratorInput {
  gpt: ProviderAdapter;
  claude: ProviderAdapter;
}

interface RunRoundOptions {
  sessionId: string;
  prompt: string;
  /** Maximum turns before forcing a stop. Default: 14. */
  maxTurns?: number;
}

/**
 * Check if the last two turns (one from each model) show consensus:
 * both have zero disagreements, or the latest turn declares a milestone.
 *
 * Requires at least 4 turns (2 full exchanges) before consensus can be
 * declared — the first exchange always has empty disagreements on the
 * opening turn because there is no peer to disagree with yet.
 */
function hasReachedConsensus(turns: ModelTurn[]): boolean {
  const latest = turns.at(-1);
  if (!latest) return false;

  // Milestone reached = explicit convergence signal (still requires 2+ turns)
  if (latest.milestoneReached && turns.length >= 2) return true;

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

export function createOrchestrator(input: OrchestratorInput) {
  const providers = [input.gpt, input.claude];

  return {
    async runRound({ sessionId, prompt, maxTurns = 14 }: RunRoundOptions) {
      let state = createSessionState();
      let peerResponse: string | undefined;

      emitProgress({ sessionId, type: "info", message: `Debate: up to ${maxTurns} turns, stopping on consensus` });

      for (let i = 0; i < maxTurns; i++) {
        const provider = providers[i % 2];
        const turnNumber = i + 1;
        const model = provider.name.toUpperCase();
        const turnStart = Date.now();
        emitProgress({ sessionId, type: "model_start", model: provider.name as "gpt" | "claude", turnNumber, message: `Turn ${turnNumber}...` });

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
          if (event.type === "structured_turn") {
            peerResponse = event.turn.rawText || event.turn.summary;

            if (event.turn.proposedSpecDelta) {
              peerResponse = `${peerResponse}\n\nProposed spec delta:\n${event.turn.proposedSpecDelta}`;
            }

            state = applyModelTurn(state, event.turn);
          }
        }

        const turnElapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
        const latest = state.turns.at(-1);
        const disagreementCount = latest?.disagreements.length ?? 0;
        const milestone = latest?.milestoneReached;
        const turnElapsedMs = Date.now() - turnStart;
        emitProgress({ sessionId, type: "model_done", model: provider.name as "gpt" | "claude", turnNumber, disagreements: disagreementCount, elapsedMs: turnElapsedMs, message: `Turn ${turnNumber} done in ${turnElapsed}s — ${disagreementCount} disagreements${milestone ? `, milestone: ${milestone}` : ""}` });

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
          emitProgress({ sessionId, type: "info", message: `Pausing: model has ${latest.questionsForHuman.length} questions for human` });
          break;
        }

        // Check for consensus
        if (hasReachedConsensus(state.turns)) {
          emitProgress({ sessionId, type: "consensus", message: `Consensus reached after ${turnNumber} turns` });
          break;
        }

        // Minimum 4 turns before stopping (give both models at least 2 exchanges)
        if (i >= 3 && disagreementCount === 0) {
          emitProgress({ sessionId, type: "consensus", message: `No disagreements after ${turnNumber} turns — converged` });
          break;
        }
      }

      if (state.exchangeCount >= maxTurns) {
        emitProgress({ sessionId, type: "info", message: `Safety cap: stopped at ${maxTurns} turns` });
      }

      return { shouldCheckpoint: true, state };
    }
  };
}
