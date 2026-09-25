import type { AgentCapability } from "./agentRuntime";

export const ALL_AGENT_CAPABILITIES: AgentCapability[] = ["filesystem", "terminal", "git", "browser", "network", "skills", "secrets"];

export interface AgentPermissionSet {
  filesystem: boolean; terminal: boolean; git: boolean; browser: boolean;
  network: boolean; skills: boolean; secrets: boolean;
}

export const DEFAULT_AGENT_PERMISSIONS: AgentPermissionSet = {
  filesystem: true, terminal: true, git: true, browser: false,
  network: false, skills: true, secrets: false,
};

export function permissionsToCapabilities(permissions: AgentPermissionSet): AgentCapability[] {
  return ALL_AGENT_CAPABILITIES.filter((capability) => permissions[capability]);
}

export function canUse(permissions: AgentPermissionSet, capability: AgentCapability): boolean {
  return permissions[capability];
}
