import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend wrapper around the Rust-side Gemini commands.
 * See src-tauri/src/gemini.rs for the implementation.
 *
 * v1 is non-streaming. If highlight-and-ask ever feels laggy, swap to
 * a streaming variant (events from Rust, partial deltas).
 */

export interface GenerateArgs {
  prompt: string;
  /** Optional system instruction — terse role/format directive. */
  system?: string;
  /** Cap output length. Default: model's default. */
  maxTokens?: number;
  /** 0–1, default 1.0. Lower for deterministic outputs (commit msgs). */
  temperature?: number;
}

export const gemini = {
  setKey: (key: string) => invoke<void>("gemini_set_key", { key }),
  clearKey: () => invoke<void>("gemini_clear_key"),
  keyStatus: () => invoke<boolean>("gemini_key_status"),
  /**
   * Returns the model's text response. Throws on API/parse error.
   * Snake-case the field names since Rust's `GenerateArgs` uses snake_case.
   */
  generate: ({ prompt, system, maxTokens, temperature }: GenerateArgs) =>
    invoke<string>("gemini_generate", {
      args: {
        prompt,
        system,
        max_tokens: maxTokens,
        temperature,
      },
    }),
  /** Returns a 768-dim embedding vector. */
  embed: (text: string) => invoke<number[]>("gemini_embed", { text }),
};
