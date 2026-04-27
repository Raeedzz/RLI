import { invoke } from "@tauri-apps/api/core";

export type ConnectionKind = "skill" | "mcp";
export type ConnectionSource = "user" | "project" | "plugin";

export interface Connection {
  kind: ConnectionKind;
  name: string;
  description: string | null;
  source: ConnectionSource;
  path: string;
  command: string | null;
}

export const connections = {
  scan: (projectPath?: string) =>
    invoke<Connection[]>("connections_scan", {
      projectPath: projectPath,
    }),
};
