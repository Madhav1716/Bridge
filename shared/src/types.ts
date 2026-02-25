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

export interface CommandRunRequest {
  requestId: string;
  command: string;
  args: string[];
  cwd?: string;
}

export interface CommandCancelRequest {
  requestId: string;
}

export interface CommandStartedEvent {
  requestId: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
}

export interface CommandOutputEvent {
  requestId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
  at: string;
}

export interface CommandCompletedEvent {
  requestId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  completedAt: string;
}

export interface CommandErrorEvent {
  requestId: string;
  message: string;
  at: string;
}

export type BridgeMessage =
  | MessageEnvelope<'bridge:hello', AgentHello>
  | MessageEnvelope<'bridge:ping', { timestamp: string; hostId?: string }>
  | MessageEnvelope<'bridge:pong', { timestamp: string; hostId?: string }>
  | MessageEnvelope<'workspace:state', WorkspaceState>
  | MessageEnvelope<'command:run', CommandRunRequest>
  | MessageEnvelope<'command:cancel', CommandCancelRequest>
  | MessageEnvelope<'command:started', CommandStartedEvent>
  | MessageEnvelope<'command:output', CommandOutputEvent>
  | MessageEnvelope<'command:completed', CommandCompletedEvent>
  | MessageEnvelope<'command:error', CommandErrorEvent>;

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
  commandState?: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  activeCommand?: string | null;
  activeCommandRequestId?: string | null;
  commandExitCode?: number | null;
  lastCommandAt?: string | null;
}

export type UiActionType =
  | 'reconnect'
  | 'pause'
  | 'resume'
  | 'open-project'
  | 'resume-workspace'
  | 'open-remote-control'
  | 'run-windows-command'
  | 'cancel-windows-command';

export type UiBridgeMessage =
  | MessageEnvelope<'ui:status', UiStatusSnapshot>
  | MessageEnvelope<'ui:action', { action: UiActionType }>;
