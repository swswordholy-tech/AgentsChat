// Unit tests for redactSecrets (src/redact.ts) — the last line of defense
// against leaking ac_ keys / JWTs into channel content. Run with `bun test`.
import { test, expect } from "bun:test";
import { isHumanPiiHandle, redactParticipantPii, redactSecrets } from "../src/redact.ts";

test("masks an ac_ API key of 16+ chars", () => {
  expect(redactSecrets("my key is ac_Dor5zPhpIKxj5JRhmgyIuA4u ok")).toBe(
    "my key is ac_***REDACTED*** ok",
  );
});

test("leaves an ac_ token shorter than 16 chars intact (documents the {16,} bound)", () => {
  const short = "ac_" + "a".repeat(15); // 15 < 16 → not matched
  expect(redactSecrets(short)).toBe(short);
});

test("redacts multiple ac_ keys in one string (global flag)", () => {
  const two = "ac_" + "A".repeat(20) + " and ac_" + "B".repeat(20);
  expect(redactSecrets(two)).toBe("ac_***REDACTED*** and ac_***REDACTED***");
});

test("masks a JWT including base64url - and _ chars", () => {
  const jwt = "eyJ" + "a".repeat(20) + ".eyJab-c_d.sig-nature_";
  expect(redactSecrets("token=" + jwt)).toBe("token=***JWT_REDACTED***");
});

test("redacts an ac_ key and a JWT present together", () => {
  const jwt = "eyJ" + "x".repeat(20) + ".payload.signature";
  const s = "ac_" + "Z".repeat(18) + " " + jwt;
  expect(redactSecrets(s)).toBe("ac_***REDACTED*** ***JWT_REDACTED***");
});

test("masks an ac_ token containing base64url - and _ chars", () => {
  const tok = "ac_" + "aB3-dE5_fG7hI9jK1lM3"; // 20 chars incl - and _
  expect(redactSecrets("key " + tok)).toBe("key ac_***REDACTED***");
});

test("leaves ordinary text (including a bare 'ac_' with too few chars) untouched", () => {
  expect(redactSecrets("hello world, ac_short, no secrets")).toBe(
    "hello world, ac_short, no secrets",
  );
});

test("preserves ac_ keys when preserveAcKeys=true (same-owner DM) while still redacting JWTs", () => {
  const jwt = "eyJ" + "x".repeat(20) + ".payload.signature";
  const key = "ac_Dor5zPhpIKxj5JRhmgyIuA4u";
  expect(redactSecrets(`key=${key} jwt=${jwt}`, { preserveAcKeys: true })).toBe(
    `key=${key} jwt=***JWT_REDACTED***`,
  );
});

test("isHumanPiiHandle detects emails and phone numbers while leaving agent IDs false", () => {
  expect(isHumanPiiHandle("swswordholy@gmail.com")).toBe(true);
  expect(isHumanPiiHandle("+86 138-0013-8000")).toBe(true);
  expect(isHumanPiiHandle("13800138000")).toBe(true);
  expect(isHumanPiiHandle("knobbly-tangy-beacon")).toBe(false);
  expect(isHumanPiiHandle("claude-code-live")).toBe(false);
  expect(isHumanPiiHandle("")).toBe(false);
});

test("redactParticipantPii preserves human emails and full agent IDs while masking phone numbers", () => {
  expect(redactParticipantPii("swswordholy@gmail.com")).toBe("swswordholy@gmail.com");
  expect(redactParticipantPii("A@example.org")).toBe("A@example.org");
  expect(redactParticipantPii("+86 138-0013-8099")).toBe("user:phone_***99");
  expect(redactParticipantPii("knobbly-tangy-beacon")).toBe("knobbly-tangy-beacon");
  expect(redactParticipantPii("spinning-midnight-tunicate")).toBe("spinning-midnight-tunicate");
  // Short digit/hyphen strings (<7 digits) and non-string redactSecrets inputs do not false-positive or throw
  expect(isHumanPiiHandle("100-20")).toBe(false);
  expect(redactParticipantPii("100-20")).toBe("100-20");
  expect(redactSecrets(undefined as any)).toBe("");
});

test("Campaign #116: redactSecrets masks MCP OAuth access/refresh/code tokens even when preserveAcKeys=true, and redactParticipantPii strips control chars", () => {
  const at = "mcp_at_" + "A".repeat(43);
  const rt = "mcp_rt_" + "B".repeat(43);
  const code = "mcp_code_" + "C".repeat(43);
  const ac = "ac_" + "D".repeat(24);
  expect(redactSecrets(`${at} ${rt} ${code}`)).toBe(
    "mcp_***REDACTED*** mcp_***REDACTED*** mcp_***REDACTED***",
  );
  expect(redactSecrets(`${ac} ${at}`, { preserveAcKeys: true })).toBe(
    `${ac} mcp_***REDACTED***`,
  );
  expect(redactParticipantPii("agent\r\n\u0000name")).toBe("agentname");
  expect(redactParticipantPii("\r\n\u0000")).toBe("unknown");
});
