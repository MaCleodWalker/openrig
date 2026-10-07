import { describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { HermesRuntimeAdapter } from "../src/adapters/hermes-runtime-adapter.js";

function makeAdapter(overrides: Record<string, unknown> = {}) {
  const tmux = {
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "hermes"),
    ...overrides,
  } as unknown as TmuxAdapter;
  const files: Record<string, string> = {};
  const adapter = new HermesRuntimeAdapter({
    tmux,
    fsOps: {
      readFile: (path) => files[path] ?? "",
      writeFile: (path, content) => { files[path] = content; },
      exists: (path) => path in files,
      mkdirp: () => {},
    },
  });
  return { adapter, tmux, files };
}

const binding = { tmuxSession: "impl@rig", cwd: "/work", nodeId: "node-1" } as NodeBinding;

describe("HermesRuntimeAdapter", () => {
  it("launches Hermes in its interactive TUI and safely quotes resume tokens", async () => {
    const { adapter, tmux } = makeAdapter();
    expect(await adapter.launchHarness(binding, { name: "impl" })).toEqual({ ok: true });
    expect(tmux.sendShellCommand).toHaveBeenCalledWith(
      "impl@rig",
      "'hermes' '--tui'",
      undefined,
      { stageIfLong: true, execInScript: true },
    );

    await adapter.launchHarness(binding, { name: "impl", resumeToken: "session's title" });
    expect(tmux.sendShellCommand).toHaveBeenLastCalledWith(
      "impl@rig",
      "'hermes' '--tui' '--resume' 'session'\"'\"'s title'",
      undefined,
      { stageIfLong: true, execInScript: true },
    );
  });

  it("refuses unsupported forks and conflicting resume/fork requests", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.launchHarness(binding, { name: "impl", forkSource: { kind: "native_id", value: "s" } }))
      .toMatchObject({ ok: false, error: expect.stringContaining("no native fork") });
    expect(await adapter.launchHarness(binding, {
      name: "impl", resumeToken: "s", forkSource: { kind: "native_id", value: "parent" },
    })).toMatchObject({ ok: false, error: expect.stringContaining("mutually exclusive") });
  });

  it("requires a live Hermes foreground process for readiness", async () => {
    const { adapter, tmux } = makeAdapter({ getPaneCommand: vi.fn(async () => "bash") });
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "awaiting_runtime" });
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("hermes");
    expect(await adapter.checkReady(binding)).toEqual({ ready: true });
    (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false });
  });
});
