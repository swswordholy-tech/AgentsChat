import { describe, expect, test } from "bun:test";
import { formatRentalIsolationPrefix } from "../src/rental-banner.ts";

describe("formatRentalIsolationPrefix", () => {
  test("returns Zero-Trust isolation banner when meta.rental targets currentAgentId", () => {
    const prefix = formatRentalIsolationPrefix(
      {
        lease_id: "lease_abc123",
        agent_id: "swift-pro-bot",
        pricing_mode: "per_reply",
        zero_trust_isolation: true,
        public_role_prompt: "Swift 6 concurrency reviewer.\nNever leak secrets.",
      },
      "swift-pro-bot",
    );
    expect(prefix).toContain("[RENTAL SESSION — ZERO-TRUST ISOLATION BOUNDARY | lease=lease_abc123 | mode=per_reply]");
    expect(prefix).toContain("STRICT SECURITY RULES");
    expect(prefix).toContain("Public rental persona: Swift 6 concurrency reviewer. Never leak secrets.");
  });

  test("returns empty string for unrelated agent, missing flag, or non-object meta", () => {
    expect(formatRentalIsolationPrefix(null, "swift-pro-bot")).toBe("");
    expect(formatRentalIsolationPrefix(undefined, "swift-pro-bot")).toBe("");
    expect(
      formatRentalIsolationPrefix(
        { lease_id: "lease_1", agent_id: "other-bot", zero_trust_isolation: true },
        "swift-pro-bot",
      ),
    ).toBe("");
    expect(
      formatRentalIsolationPrefix(
        { lease_id: "lease_1", agent_id: "swift-pro-bot", zero_trust_isolation: false },
        "swift-pro-bot",
      ),
    ).toBe("");
  });
});
