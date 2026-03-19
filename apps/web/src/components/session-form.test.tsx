// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionForm } from "./session-form";

describe("SessionForm", () => {
  it("submits a problem statement and forwards it to the session creator", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);

    render(<SessionForm onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "Help me design a dual-model spec app" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Help me design a dual-model spec app", undefined);
    });
  });
});
