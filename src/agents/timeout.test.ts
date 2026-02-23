import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentTimeoutMs, resolveAgentTimeoutSeconds } from "./timeout.js";

describe("resolveAgentTimeoutSeconds", () => {
  it("allows a zero default timeout to represent no timeout", () => {
    const cfg = {
      agents: {
        defaults: {
          timeoutSeconds: 0,
        },
      },
    } as OpenClawConfig;

    expect(resolveAgentTimeoutSeconds(cfg)).toBe(0);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("maps a zero default timeout to the timer-safe no-timeout sentinel", () => {
    const cfg = {
      agents: {
        defaults: {
          timeoutSeconds: 0,
        },
      },
    } as OpenClawConfig;

    expect(resolveAgentTimeoutMs({ cfg })).toBe(2_147_000_000);
  });
});
