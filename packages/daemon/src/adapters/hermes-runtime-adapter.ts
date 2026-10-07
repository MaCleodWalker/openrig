import nodePath from "node:path";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type {
  RuntimeAdapter,
  NodeBinding,
  ResolvedStartupFile,
  InstalledResource,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  HarnessLaunchResult,
  ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface HermesAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

export class HermesRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "hermes";

  constructor(private readonly deps: {
    tmux: TmuxAdapter;
    fsOps: HermesAdapterFsOps;
    seatLaunchEnvironment?: SeatLaunchEnvironment;
  }) {}

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    const warnings: string[] = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding, warnings)) projected.push(entry.effectiveId);
        else {
          skipped.push(entry.effectiveId);
          warnings.push(`Hermes has no managed projection target for ${entry.category} "${entry.effectiveId}"`);
        }
      } catch (error) {
        failed.push({ effectiveId: entry.effectiveId, error: (error as Error).message });
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];
    const warnings: string[] = [];

    for (const file of files) {
      try {
        const content = this.deps.fsOps.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        if (hint === "guidance_merge") {
          if (!this.mergeGuidance(nodePath.join(binding.cwd, "AGENTS.md"), file.path, content, warnings)) continue;
        } else if (hint === "skill_install") {
          throw new Error("Hermes skill installation is not supported; Hermes skills are configured in the user profile");
        } else if (binding.tmuxSession) {
          const sent = await this.deps.tmux.sendText(binding.tmuxSession, content);
          if (!sent.ok) throw new Error(sent.message);
          const submitted = await this.deps.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
          if (!submitted.ok) throw new Error(submitted.message);
        }
        delivered++;
      } catch (error) {
        if (file.required) failed.push({ path: file.path, error: (error as Error).message });
      }
    }

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound — cannot launch the Hermes harness" };
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.forkSource) {
      return { ok: false, error: "Hermes runtime has no native fork primitive; remove session_source for Hermes members" };
    }

    const args = ["hermes", "--tui"];
    if (opts.resumeToken) args.push("--resume", opts.resumeToken);
    const command = args.map(shellQuote).join(" ");
    const launchCommand = this.deps.seatLaunchEnvironment
      ? await this.deps.seatLaunchEnvironment.command(binding.tmuxSession, command, {
        nodeId: binding.nodeId,
        generation: binding.launchGeneration,
        runtime: this.runtime,
      })
      : command;
    const result = await this.deps.tmux.sendShellCommand(binding.tmuxSession, launchCommand, undefined, {
      stageIfLong: true,
      execInScript: true,
    });
    if (!result.ok) return { ok: false, error: `Failed to send Hermes launch command: ${result.message}` };
    return { ok: true };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!await this.deps.tmux.hasSession(binding.tmuxSession)) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    const command = (await this.deps.tmux.getPaneCommand(binding.tmuxSession) ?? "").replace(/^-/, "");
    if (!command || SHELL_COMMANDS.has(nodePath.basename(command))) {
      return { ready: false, reason: "Hermes is not running in the seat pane", code: "awaiting_runtime" };
    }
    return { ready: true };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding, warnings: string[]): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      return this.mergeGuidance(
        nodePath.join(binding.cwd, "AGENTS.md"),
        entry.effectiveId,
        this.deps.fsOps.readFile(entry.absolutePath),
        warnings,
      );
    }
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[]): boolean {
    if (blockId === "rig-role") return false;
    mergeManagedBlock(this.deps.fsOps, targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
