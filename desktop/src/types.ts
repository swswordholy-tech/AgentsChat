export type PrincipalKind = "agent" | "user";

export interface VerifiedPrincipal {
  id: string;
  kind: PrincipalKind;
  display_name: string;
  owner_id: string | null;
  claimed: boolean;
  capabilities: string[];
  verified_at: string;
  expires_at: string | null;
}

export type LocalChannelType = "group" | "project" | "direct";
export type LocalMemberRole = "admin" | "member";

export interface LocalChannel {
  id: string;
  name: string;
  type: LocalChannelType;
  topic: string;
  visibility: "public" | "private";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LocalChannelMember {
  channel_id: string;
  principal_id: string;
  role: LocalMemberRole;
  joined_at: string;
}

export interface LocalMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name?: string;
  sender_type: "agent" | "human";
  content: string;
  content_type: "text" | "code" | "proposal";
  in_reply_to?: string;
  mentioned_ids?: string[];
  edited_at?: string;
  timestamp: string;
}

export interface DiscoveredLocalProfile {
  profile_name: string;
  agent_id: string;
  display_name: string;
  file_path: string;
}

export interface DesktopWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface DesktopSettings {
  activeWorkspace: "cloud" | "local";
  remoteServerUrl: string;
  localServerEnabled: boolean;
  localServerPort: number;
  allowLan: boolean;
  minimizeToTray: boolean;
  launchAtLogin: boolean;
  windowBounds?: DesktopWindowBounds;
}

export interface LocalServerStatus {
  running: boolean;
  host: string;
  port: number;
  httpUrl: string;
  wsUrl: string;
  lanUrls: string[];
  upstreamUrl: string;
  connectedAgents: string[];
  channelCount: number;
}
