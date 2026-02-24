export type PlatformKind = 'windows' | 'mac';

export interface ProcessStatus {
  name: string;
  running: boolean;
  count: number;
  pids: number[];
}

export type ConnectionLifecycleState =
  | 'DISCONNECTED'
  | 'DISCOVERING'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'PAUSED'
  | 'RECONNECTING';

export interface ConnectionState {
  lifecycle: ConnectionLifecycleState;
  hostId: string | null;
  hostName: string | null;
  lastHeartbeatAt: string | null;
  lastTransitionAt: string;
}

export interface WorkspaceState {
  projectName: string;
  projectPath: string;
  openFiles: string[];
  recentlyModifiedFiles: string[];
  processes: ProcessStatus[];
  activeProcess: boolean;
  hostDevice: string;
  connection: ConnectionState;
  lastEvent: string;
}

export interface AgentHello {
  agentId: string;
  name: string;
  platform: PlatformKind;
}

export type ConnectionStatus = ConnectionLifecycleState;

export interface MessageEnvelope<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: TPayload;
  sentAt: string;
}

export type BridgeMessage =
  | MessageEnvelope<'bridge:hello', AgentHello>
  | MessageEnvelope<'bridge:ping', { timestamp: string; hostId?: string }>
  | MessageEnvelope<'bridge:pong', { timestamp: string; hostId?: string }>
  | MessageEnvelope<'workspace:state', WorkspaceState>;

export interface BridgeServiceRecord {
  id: string;
  identity: string;
  name: string;
  host: string;
  port: number;
  addresses: string[];
  txt: Record<string, string>;
}

export interface UiStatusSnapshot {
  connectionStatus: ConnectionStatus;
  hostDevice: string | null;
  activeProject: string | null;
  projectPath: string | null;
  lastEvent: string | null;
}

export type UiActionType =
  | 'reconnect'
  | 'pause'
  | 'resume'
  | 'open-project'
  | 'resume-workspace';

export type UiBridgeMessage =
  | MessageEnvelope<'ui:status', UiStatusSnapshot>
  | MessageEnvelope<'ui:action', { action: UiActionType }>;
