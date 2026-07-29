/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("uses an explicit callback URL for both the child environment and prompt", async () => {
    const previousRuntimeUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://runtime.paperclip.test:3100";
    process.env.PAPERCLIP_PUBLIC_URL = "https://public.paperclip.test";

    try {
      const { ctx } = makeCtx({ paperclipApiUrl: "http://127.0.0.1:3100" });
      await execute(ctx as any);

      const lastCall = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
      const prompt = lastCall[2][2];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3100");
      expect(prompt).toContain("API base: http://127.0.0.1:3100/api");
      expect(process.env.PAPERCLIP_PUBLIC_URL).toBe("https://public.paperclip.test");
      expect(opts.env.PAPERCLIP_PUBLIC_URL).toBe("https://public.paperclip.test");
    } finally {
      if (previousRuntimeUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
      else process.env.PAPERCLIP_RUNTIME_API_URL = previousRuntimeUrl;
      if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
      else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    }
  });

  it("falls back to the computed runtime callback URL without logging credentials", async () => {
    const previousRuntimeUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://runtime.paperclip.test:3100";
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const lastCall = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
      const prompt = lastCall[2][2];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_URL).toBe("http://runtime.paperclip.test:3100");
      expect(prompt).toContain("API base: http://runtime.paperclip.test:3100/api");
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
      expect(prompt).not.toContain("parent-process-key");
      expect(vi.mocked(ctx.onLog).mock.calls.flat().join("\n")).not.toContain("parent-process-key");
    } finally {
      if (previousRuntimeUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
      else process.env.PAPERCLIP_RUNTIME_API_URL = previousRuntimeUrl;
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("persists and resumes the session ID from Hermes non-quiet output", async () => {
    const mocked = vi.mocked(serverUtils.runChildProcess);
    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "Completed the assigned work.",
        "",
        "Resume this session with:",
        "  hermes --resume 20260729_013020_07d7ca",
        "",
        "Session:        20260729_013020_07d7ca",
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: "2026-07-29T01:30:20.000Z",
    });

    const { ctx } = makeCtx();
    const first = await execute(ctx as any);

    expect(first.sessionParams).toEqual({ sessionId: "20260729_013020_07d7ca" });
    expect(first.sessionDisplayId).toBe("20260729_013020_");

    const firstOptions = mocked.mock.calls.at(-1)![3];
    expect(firstOptions.terminalResultCleanup?.hasTerminalResult({
      stdout: "Session:        20260729_013020_07d7ca\n",
      stderr: "",
    })).toBe(true);

    mocked.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "session_id: 20260729_013020_07d7ca\n",
      stderr: "",
      pid: 124,
      startedAt: "2026-07-29T01:35:00.000Z",
    });
    (ctx.runtime as Record<string, unknown>).sessionParams = {
      sessionId: "20260729_013020_07d7ca",
    };
    await execute(ctx as any);

    expect(mocked.mock.calls.at(-1)![2]).toContain("--resume");
    expect(mocked.mock.calls.at(-1)![2]).toContain("20260729_013020_07d7ca");
  });
});
