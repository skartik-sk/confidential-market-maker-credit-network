import { describe, expect, test } from "bun:test";
import { buildProtocolManifest } from "./index";

describe("protocol manifest", () => {
  test("describes the Pinocchio program as the source of truth", () => {
    const manifest = buildProtocolManifest();

    expect(manifest.program.framework).toBe("pinocchio");
    expect(manifest.program.instructions).toEqual([
      "initializePool",
      "approveCreditLine",
      "drawTranche",
      "repayTranche",
      "postReceipt",
      "settleMaturity",
      "pauseLine",
    ]);
    expect(manifest.accounts.pool.bytes).toBeGreaterThan(200);
    expect(manifest.localnet.validator).toBe("surfpool");
    expect(manifest.x402Policy.coreProtocolUsesX402).toBe(false);
  });
});
