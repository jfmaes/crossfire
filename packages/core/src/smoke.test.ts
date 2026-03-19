import { describe, expect, it } from "vitest";
import { workspaceName } from "./index";

describe("workspace bootstrap", () => {
  it("exports the project name", () => {
    expect(workspaceName).toBe("the-council");
  });
});
