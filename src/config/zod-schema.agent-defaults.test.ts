import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";

describe("AgentDefaultsSchema", () => {
  it("accepts timeoutSeconds=0 for no-timeout agent defaults", () => {
    const parsed = AgentDefaultsSchema.parse({ timeoutSeconds: 0 });
    expect(parsed?.timeoutSeconds).toBe(0);
  });

  it("rejects negative timeoutSeconds", () => {
    expect(() => AgentDefaultsSchema.parse({ timeoutSeconds: -1 })).toThrow();
  });
});
