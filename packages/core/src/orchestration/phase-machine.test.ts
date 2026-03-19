import { describe, expect, it } from "vitest";
import {
  nextPhase,
  phaseRequiresHumanInput,
  phaseIndex,
  PHASE_COUNT
} from "./phase-machine";

describe("phase-machine", () => {
  describe("nextPhase", () => {
    it("transitions from analysis to interview", () => {
      expect(nextPhase("analysis")).toBe("interview");
    });

    it("transitions from interview to approach_debate", () => {
      expect(nextPhase("interview")).toBe("approach_debate");
    });

    it("transitions from approach_debate to spec_generation", () => {
      expect(nextPhase("approach_debate")).toBe("spec_generation");
    });

    it("returns null from spec_generation (terminal)", () => {
      expect(nextPhase("spec_generation")).toBeNull();
    });
  });

  describe("phaseRequiresHumanInput", () => {
    it("returns true for interview", () => {
      expect(phaseRequiresHumanInput("interview")).toBe(true);
    });

    it("returns false for non-interview phases", () => {
      expect(phaseRequiresHumanInput("analysis")).toBe(false);
      expect(phaseRequiresHumanInput("approach_debate")).toBe(false);
      expect(phaseRequiresHumanInput("spec_generation")).toBe(false);
    });
  });

  describe("phaseIndex", () => {
    it("returns 0 for analysis", () => {
      expect(phaseIndex("analysis")).toBe(0);
    });

    it("returns 3 for spec_generation", () => {
      expect(phaseIndex("spec_generation")).toBe(3);
    });
  });

  it("has 4 phases", () => {
    expect(PHASE_COUNT).toBe(4);
  });
});
