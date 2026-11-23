import { describe, expect, test } from "bun:test";
import {
  buildBotMarketQuery,
  formatRentalIsolationPrefix,
  isSafeRentalTargetId,
} from "../src/rental-banner.ts";
import { TOOL_ANNOTATIONS } from "../src/tool-annotations.ts";

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

  test("matches secondary rented bot in multi-bot group meta.rental.leases array", () => {
    const multiMeta = {
      lease_id: "lease_primary",
      agent_id: "bot-a",
      pricing_mode: "per_reply",
      zero_trust_isolation: true,
      leases: [
        {
          lease_id: "lease_primary",
          agent_id: "bot-a",
          pricing_mode: "per_reply",
          zero_trust_isolation: true,
        },
        {
          lease_id: "lease_secondary",
          agent_id: "bot-b",
          pricing_mode: "time_pass",
          zero_trust_isolation: true,
          public_role_prompt: "Bot B public persona",
        },
      ],
    };
    const prefixB = formatRentalIsolationPrefix(multiMeta, "bot-b");
    expect(prefixB).toContain("lease=lease_secondary | mode=time_pass");
    expect(prefixB).toContain("Public rental persona: Bot B public persona");
    expect(formatRentalIsolationPrefix(multiMeta, "bot-c")).toBe("");
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

  test("buildBotMarketQuery and isSafeRentalTargetId validate discovery params and mark tools read-only", () => {
    expect(
      buildBotMarketQuery({
        q: "swift\nconcurrency",
        category: "CODING",
        pricing_mode: "per_reply",
        online_only: true,
        sort: "rating",
        limit: 999,
      }),
    ).toBe("?q=swift+concurrency&category=coding&pricing_mode=per_reply&online_only=1&sort=rating&limit=50");
    expect(buildBotMarketQuery({ category: "invalid", sort: "drop_table" })).toBe("");

    expect(isSafeRentalTargetId("swift-pro-bot")).toBe(true);
    expect(isSafeRentalTargetId("../etc/passwd")).toBe(false);
    expect(isSafeRentalTargetId("bot..evil")).toBe(false);

    for (const toolName of ["browse_bot_market", "get_bot_rental_listing", "channel_rental_status"]) {
      expect(TOOL_ANNOTATIONS[toolName]?.readOnlyHint).toBe(true);
      expect(TOOL_ANNOTATIONS[toolName]?.destructiveHint).toBeUndefined();
    }
  });
});
