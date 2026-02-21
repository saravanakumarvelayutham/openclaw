import { describe, expect, it } from "vitest";
import { shouldClearStoredDeviceTokenOnConnectError } from "../../ui/src/ui/gateway.ts";

describe("shouldClearStoredDeviceTokenOnConnectError", () => {
  it("returns true when shared-token fallback is available", () => {
    expect(
      shouldClearStoredDeviceTokenOnConnectError({
        err: new Error("anything"),
        canFallbackToShared: true,
        usedStoredDeviceToken: false,
      }),
    ).toBe(true);
  });

  it("returns true when a stored device token was used", () => {
    expect(
      shouldClearStoredDeviceTokenOnConnectError({
        err: new Error("connect failed"),
        canFallbackToShared: false,
        usedStoredDeviceToken: true,
      }),
    ).toBe(true);
  });

  it("returns true on device token mismatch without shared fallback", () => {
    expect(
      shouldClearStoredDeviceTokenOnConnectError({
        err: new Error("unauthorized: device token mismatch (rotate/reissue device token)"),
        canFallbackToShared: false,
        usedStoredDeviceToken: false,
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors when no shared fallback exists", () => {
    expect(
      shouldClearStoredDeviceTokenOnConnectError({
        err: new Error("timeout"),
        canFallbackToShared: false,
        usedStoredDeviceToken: false,
      }),
    ).toBe(false);
  });
});
