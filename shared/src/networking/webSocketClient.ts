import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Logger } from '../logger';
import { ConnectionStatus, MessageEnvelope } from '../types';
import { parseEnvelope } from './wsProtocol';

interface ClientEvents {
  status: (status: ConnectionStatus) => void;
  message: (message: MessageEnvelope) => void;
}

interface ClientOptions {
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class BridgeWebSocketClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private status: ConnectionStatus = 'DISCONNECTED';
  private targetUrl: string | null = null;
  private activeUrl: string | null = null;
  private paused = false;
  private explicitDisconnect = false;

  public constructor(
    private readonly logger: Logger,
    private readonly options: ClientOptions = {},
  ) {
    super();
  }

  public on<EventKey extends keyof ClientEvents>(
    eventName: EventKey,
    listener: ClientEvents[EventKey],
  ): this {
    return super.on(eventName, listener);
  }

  public connect(url: string): void {
    this.targetUrl = url;
    this.explicitDisconnect = false;

    if (this.paused) {
      this.setStatus('PAUSED');
      return;
    }

    if (
      this.socket &&
      this.activeUrl === url &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      this.logger.event(
        {
          component: 'ws-client',
          event: 'duplicate-connect-ignored',
          state: this.status,
          hostId: this.extractHostId(url),
        },
        { url },
      );
      return;
    }

    this.clearReconnectTimer();
    this.openSocket(url);
  }

  public disconnect(): void {
    this.explicitDisconnect = true;
    this.clearReconnectTimer();

    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      this.activeUrl = null;
      socket.close();
    }

    this.setStatus(this.paused ? 'PAUSED' : 'DISCONNECTED');
  }

  public reconnectNow(): void {
    if (!this.targetUrl || this.paused) {
      return;
    }

    this.logger.event(
      {
        component: 'ws-client',
        event: 'manual-reconnect',
        state: this.status,
        hostId: this.extractHostId(this.targetUrl),
      },
      { targetUrl: this.targetUrl },
    );

    this.explicitDisconnect = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.terminate();
      this.socket = null;
      this.activeUrl = null;
    }

    this.setStatus('RECONNECTING');
    this.scheduleReconnect(0);
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;

    if (paused) {
      this.disconnect();
      this.setStatus('PAUSED');
      return;
    }

    this.explicitDisconnect = false;
    this.setStatus('DISCONNECTED');

    if (this.targetUrl) {
      this.connect(this.targetUrl);
    }
  }

  public send(message: MessageEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  private openSocket(url: string): void {
    if (this.paused) {
      this.setStatus('PAUSED');
      return;
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.setStatus('CONNECTING');
    this.logger.event(
      {
        component: 'ws-client',
        event: 'connect-attempt',
        state: 'CONNECTING',
        hostId: this.extractHostId(url),
      },
      { url },
    );

    const socket = new WebSocket(url);
    this.socket = socket;
    this.activeUrl = url;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.setStatus('CONNECTED');
    });

    socket.on('message', (data) => {
      const parsed = parseEnvelope(data.toString());
      if (!parsed) {
        this.logger.warn('Dropped invalid websocket payload from server');
        return;
      }

      this.emit('message', parsed);
    });

    socket.on('close', () => {
      this.socket = null;
      this.activeUrl = null;

      if (this.paused) {
        this.setStatus('PAUSED');
        return;
      }

      if (this.explicitDisconnect) {
        this.setStatus('DISCONNECTED');
        return;
      }

      this.setStatus('RECONNECTING');
      this.scheduleReconnect();
    });

    socket.on('error', (error) => {
      this.logger.error('WebSocket client error', { error: error.message });
    });
  }

  private scheduleReconnect(delayOverrideMs?: number): void {
    if (!this.targetUrl || this.paused) {
      return;
    }

    this.clearReconnectTimer();
    this.reconnectAttempt += 1;

    const base = this.options.reconnectBaseMs ?? 1000;
    const max = this.options.reconnectMaxMs ?? 15000;
    const computedDelay = Math.min(base * 2 ** (this.reconnectAttempt - 1), max);
    const delay = delayOverrideMs ?? computedDelay;

    this.logger.event(
      {
        component: 'ws-client',
        event: 'reconnect-scheduled',
        state: 'RECONNECTING',
        hostId: this.extractHostId(this.targetUrl),
      },
      { delayMs: delay, attempt: this.reconnectAttempt },
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.targetUrl) {
        this.openSocket(this.targetUrl);
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(nextStatus: ConnectionStatus): void {
    if (this.status === nextStatus) {
      return;
    }

    this.status = nextStatus;
    this.emit('status', nextStatus);
    this.logger.event(
      {
        component: 'ws-client',
        event: 'status-changed',
        state: nextStatus,
        hostId: this.extractHostId(this.targetUrl),
      },
      { targetUrl: this.targetUrl },
    );
  }

  private extractHostId(url: string | null): string | undefined {
    if (!url) {
      return undefined;
    }

    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
}
