/**
 * no-toolcall-guard.test.ts — TDD tests for YAML-configured no-toolcall guard
 *
 * The guard is dead simple:
 *   - If assistant turn has no "substantial" tool call → block (return continuation message)
 *   - "Substantial" = tool in the whitelist (e.g. exec, read, write, edit...)
 *   - message send, cron, sessions_yield etc. do NOT count
 *   - max_retries configurable via YAML (default 1)
 *   - Hot-reloads YAML on mtime change
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import {
  NoToolcallGuard,
  type NoToolcallGuardConfig,
} from "./no-toolcall-guard.js";

describe("NoToolcallGuard", () => {
  let guard: NoToolcallGuard;
  let yamlPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), "notoolcall-"));
    yamlPath = path.join(tmpDir, "no-toolcall-guard.yaml");
  });

  afterEach(() => {
    guard?.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("basic blocking (no substantial tool call → block)", () => {
    it("blocks when assistant has no tool calls at all", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const result = guard.evaluate("session-1", { toolNames: [] });
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0].role).toBe("user");
    });

    it("blocks when assistant only called non-substantial tools (message send)", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const result = guard.evaluate("session-1", { toolNames: ["message", "cron"] });
      expect(result).not.toBeNull();
    });

    it("passes when assistant called a substantial tool (exec)", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const result = guard.evaluate("session-1", { toolNames: ["exec"] });
      expect(result).toBeNull();
    });

    it("passes when mix of substantial + non-substantial tools", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const result = guard.evaluate("session-1", { toolNames: ["message", "exec", "cron"] });
      expect(result).toBeNull();
    });

    it("returns null (pass) after max_retries exhausted for same session", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const r1 = guard.evaluate("session-1", { toolNames: [] });
      expect(r1).not.toBeNull();
      const r2 = guard.evaluate("session-1", { toolNames: [] });
      expect(r2).toBeNull();
    });

    it("resets counter when substantial tool call happens", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      guard.evaluate("session-1", { toolNames: [] });
      guard.evaluate("session-1", { toolNames: ["read"] });
      const r = guard.evaluate("session-1", { toolNames: [] });
      expect(r).not.toBeNull();
    });
  });

  describe("max_retries configuration", () => {
    it("defaults to 1 retry", () => {
      guard = new NoToolcallGuard();
      const r1 = guard.evaluate("s1", { toolNames: [] });
      expect(r1).not.toBeNull();
      const r2 = guard.evaluate("s1", { toolNames: [] });
      expect(r2).toBeNull();
    });

    it("respects max_retries=3", () => {
      guard = new NoToolcallGuard({ maxRetries: 3 });
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).toBeNull();
    });

    it("respects max_retries=0 (disabled)", () => {
      guard = new NoToolcallGuard({ maxRetries: 0 });
      const r = guard.evaluate("s1", { toolNames: [] });
      expect(r).toBeNull();
    });
  });

  describe("substantial_tools whitelist", () => {
    it("uses default whitelist (exec, read, write, edit, feishu_doc, feishu_sheet, feishu_bitable)", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      // Default substantial tools should include these
      expect(guard.evaluate("s1", { toolNames: ["exec"] })).toBeNull();
      expect(guard.evaluate("s2", { toolNames: ["read"] })).toBeNull();
      expect(guard.evaluate("s3", { toolNames: ["write"] })).toBeNull();
      expect(guard.evaluate("s4", { toolNames: ["edit"] })).toBeNull();
      expect(guard.evaluate("s5", { toolNames: ["feishu_doc"] })).toBeNull();
      expect(guard.evaluate("s6", { toolNames: ["feishu_sheet"] })).toBeNull();
      expect(guard.evaluate("s7", { toolNames: ["feishu_bitable"] })).toBeNull();
    });

    it("non-substantial tools do not pass", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      expect(guard.evaluate("s1", { toolNames: ["message"] })).not.toBeNull();
      expect(guard.evaluate("s2", { toolNames: ["cron"] })).not.toBeNull();
      expect(guard.evaluate("s3", { toolNames: ["sessions_yield"] })).not.toBeNull();
      expect(guard.evaluate("s4", { toolNames: ["sessions_spawn"] })).not.toBeNull();
      expect(guard.evaluate("s5", { toolNames: ["memory_search"] })).not.toBeNull();
      expect(guard.evaluate("s6", { toolNames: ["feishu_search"] })).not.toBeNull();
    });

    it("custom substantial_tools from config", () => {
      guard = new NoToolcallGuard({
        maxRetries: 1,
        substantialTools: ["my_custom_tool", "special_action"],
      });
      expect(guard.evaluate("s1", { toolNames: ["exec"] })).not.toBeNull(); // not in custom list
      expect(guard.evaluate("s2", { toolNames: ["my_custom_tool"] })).toBeNull(); // in custom list
    });
  });

  describe("custom message template", () => {
    it("uses default message when none configured", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const r = guard.evaluate("s1", { toolNames: [] });
      expect(r![0].content).toContain("tool");
    });

    it("uses custom message from config", () => {
      guard = new NoToolcallGuard({
        maxRetries: 1,
        message: "DO YOUR JOB! Call a tool now!",
      });
      const r = guard.evaluate("s1", { toolNames: [] });
      expect(r![0].content).toBe("DO YOUR JOB! Call a tool now!");
    });
  });

  describe("per-session isolation", () => {
    it("tracks retries independently per session", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      expect(guard.evaluate("session-1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("session-1", { toolNames: [] })).toBeNull();
      expect(guard.evaluate("session-2", { toolNames: [] })).not.toBeNull();
    });
  });

  describe("YAML hot-reload", () => {
    it("loads config from YAML file", () => {
      fs.writeFileSync(yamlPath, [
        "max_retries: 2",
        "message: 'custom msg'",
        "substantial_tools:",
        "  - exec",
        "  - read",
        "",
      ].join("\n"));
      guard = NoToolcallGuard.fromYaml(yamlPath);
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).toBeNull();
    });

    it("hot-reloads when YAML mtime changes", async () => {
      fs.writeFileSync(yamlPath, "max_retries: 1\n");
      guard = NoToolcallGuard.fromYaml(yamlPath, { pollIntervalMs: 50 });

      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).toBeNull();

      await new Promise(r => setTimeout(r, 60));
      fs.writeFileSync(yamlPath, "max_retries: 3\n");
      await new Promise(r => setTimeout(r, 120));

      expect(guard.evaluate("s2", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s2", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s2", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s2", { toolNames: [] })).toBeNull();
    });

    it("hot-reloads substantial_tools list", async () => {
      fs.writeFileSync(yamlPath, [
        "max_retries: 1",
        "substantial_tools:",
        "  - exec",
        "",
      ].join("\n"));
      guard = NoToolcallGuard.fromYaml(yamlPath, { pollIntervalMs: 50 });

      // "read" is NOT in whitelist initially
      expect(guard.evaluate("s1", { toolNames: ["read"] })).not.toBeNull();

      await new Promise(r => setTimeout(r, 60));
      fs.writeFileSync(yamlPath, [
        "max_retries: 1",
        "substantial_tools:",
        "  - exec",
        "  - read",
        "",
      ].join("\n"));
      await new Promise(r => setTimeout(r, 120));

      // Now "read" should pass
      expect(guard.evaluate("s2", { toolNames: ["read"] })).toBeNull();
    });

    it("survives missing YAML (uses defaults)", () => {
      guard = NoToolcallGuard.fromYaml("/nonexistent/path.yaml");
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).toBeNull();
    });

    it("survives malformed YAML (keeps last good config)", async () => {
      fs.writeFileSync(yamlPath, "max_retries: 5\n");
      guard = NoToolcallGuard.fromYaml(yamlPath, { pollIntervalMs: 50 });

      await new Promise(r => setTimeout(r, 60));
      fs.writeFileSync(yamlPath, "max_retries: [[[broken\n");
      await new Promise(r => setTimeout(r, 120));

      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
      expect(guard.evaluate("s1", { toolNames: [] })).not.toBeNull();
    });
  });

  describe("getFollowUpMessages integration", () => {
    it("returns a compatible getFollowUpMessages function", () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const fn = guard.createGetFollowUpMessages();
      expect(typeof fn).toBe("function");
    });

    it("getFollowUpMessages blocks on no substantial tool", async () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      guard.setLastTurnContext("s1", { toolNames: ["message"] });
      const fn = guard.createGetFollowUpMessages();
      const msgs = await fn("s1");
      expect(msgs.length).toBe(1);
      expect(msgs[0].role).toBe("user");
    });

    it("getFollowUpMessages passes on substantial tool", async () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      guard.setLastTurnContext("s1", { toolNames: ["exec"] });
      const fn = guard.createGetFollowUpMessages();
      const msgs = await fn("s1");
      expect(msgs).toEqual([]);
    });

    it("getFollowUpMessages returns [] when no context set", async () => {
      guard = new NoToolcallGuard({ maxRetries: 1 });
      const fn = guard.createGetFollowUpMessages();
      const msgs = await fn("unknown-session");
      expect(msgs).toEqual([]);
    });
  });
});
