import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database";
import { SessionRepository } from "./session-repository";

describe("SessionRepository — phase/interview extensions", () => {
  function createRepo() {
    return new SessionRepository(createInMemoryDatabase());
  }

  it("creates a session with phase", () => {
    const repo = createRepo();
    repo.create({
      id: "s1",
      title: "Test",
      status: "debating",
      phase: "analysis"
    });

    const session = repo.findById("s1");
    expect(session).toBeDefined();
    expect(session!.phase).toBe("analysis");
  });

  it("defaults phase to null when not specified", () => {
    const repo = createRepo();
    repo.create({ id: "s2", title: "Session", status: "draft" });

    const session = repo.findById("s2");
    expect(session!.phase).toBeNull();
  });

  it("updates the phase", () => {
    const repo = createRepo();
    repo.create({ id: "s3", title: "Test", status: "debating", phase: "analysis" });
    repo.updatePhase({ id: "s3", phase: "interview" });

    expect(repo.findById("s3")!.phase).toBe("interview");
  });

  describe("interview questions", () => {
    it("saves and retrieves interview questions", () => {
      const repo = createRepo();
      repo.create({ id: "s1", title: "Test", status: "debating" });

      repo.saveInterviewQuestions([
        {
          id: "q1",
          sessionId: "s1",
          text: "What is the scope?",
          priority: 1,
          rationale: "Defines boundaries",
          proposedBy: "gpt",
          answer: null,
          sortOrder: 0
        },
        {
          id: "q2",
          sessionId: "s1",
          text: "What is the tech stack?",
          priority: 2,
          rationale: "Constrains implementation",
          proposedBy: "claude",
          answer: null,
          sortOrder: 1
        }
      ]);

      const questions = repo.findInterviewQuestions("s1");
      expect(questions).toHaveLength(2);
      expect(questions[0].text).toBe("What is the scope?");
      expect(questions[1].text).toBe("What is the tech stack?");
    });

    it("updates an interview answer", () => {
      const repo = createRepo();
      repo.create({ id: "s1", title: "Test", status: "debating" });

      repo.saveInterviewQuestions([{
        id: "q1",
        sessionId: "s1",
        text: "What is the scope?",
        priority: 1,
        rationale: "Defines boundaries",
        proposedBy: "gpt",
        answer: null,
        sortOrder: 0
      }]);

      repo.updateInterviewAnswer({ id: "q1", answer: "Web only, no mobile" });

      const questions = repo.findInterviewQuestions("s1");
      expect(questions[0].answer).toBe("Web only, no mobile");
    });

    it("upserts questions on conflict", () => {
      const repo = createRepo();
      repo.create({ id: "s1", title: "Test", status: "debating" });

      repo.saveInterviewQuestions([{
        id: "q1",
        sessionId: "s1",
        text: "Original question",
        priority: 1,
        rationale: "Original rationale",
        proposedBy: "gpt",
        answer: null,
        sortOrder: 0
      }]);

      repo.saveInterviewQuestions([{
        id: "q1",
        sessionId: "s1",
        text: "Updated question",
        priority: 2,
        rationale: "Updated rationale",
        proposedBy: "synthesized",
        answer: null,
        sortOrder: 0
      }]);

      const questions = repo.findInterviewQuestions("s1");
      expect(questions).toHaveLength(1);
      expect(questions[0].text).toBe("Updated question");
    });
  });

  describe("phase results", () => {
    it("saves and retrieves a phase result", () => {
      const repo = createRepo();
      repo.create({ id: "s1", title: "Test", status: "debating" });

      const data = { gptAnalysis: "analysis1", claudeAnalysis: "analysis2" };
      repo.savePhaseResult({
        sessionId: "s1",
        phase: "analysis",
        resultJson: JSON.stringify(data)
      });

      const result = repo.findPhaseResult("s1", "analysis");
      expect(result).toBeDefined();
      expect(JSON.parse(result!.resultJson)).toEqual(data);
    });

    it("upserts phase results on conflict", () => {
      const repo = createRepo();
      repo.create({ id: "s1", title: "Test", status: "debating" });

      repo.savePhaseResult({
        sessionId: "s1",
        phase: "analysis",
        resultJson: JSON.stringify({ version: 1 })
      });

      repo.savePhaseResult({
        sessionId: "s1",
        phase: "analysis",
        resultJson: JSON.stringify({ version: 2 })
      });

      const result = repo.findPhaseResult("s1", "analysis");
      expect(JSON.parse(result!.resultJson)).toEqual({ version: 2 });
    });

    it("returns undefined for nonexistent phase result", () => {
      const repo = createRepo();
      expect(repo.findPhaseResult("s1", "interview")).toBeUndefined();
    });
  });
});
