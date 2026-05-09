import { invoke } from "@tauri-apps/api/core";
import type { AgentCli } from "@/state/types";

/**
 * Helper-agent client. Routes to whichever CLI the user is running
 * in the active worktree (claude / codex / gemini). Backed by
 * `src-tauri/src/helper_agent.rs`.
 */

export type HelperMode =
  | "commit-message"
  | "summary"
  | "explain"
  | "pr-description";

export async function helperRun(
  cwd: string,
  cli: AgentCli,
  mode: HelperMode,
  prompt: string,
  model?: string,
): Promise<string> {
  return invoke<string>("helper_run", {
    cwd,
    cli,
    mode,
    prompt,
    model: model && model.length > 0 ? model : null,
  });
}

export async function detectAgent(command: string): Promise<AgentCli | null> {
  const result = await invoke<string | null>("detect_agent", { command });
  if (!result) return null;
  if (result === "claude" || result === "codex" || result === "gemini") {
    return result;
  }
  return null;
}
