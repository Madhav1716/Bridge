import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { Logger } from '../logger';
import { MessageEnvelope, UiActionType, UiStatusSnapshot } from '../types';
import { createEnvelope, parseEnvelope } from '../networking/wsProtocol';

interface UiBridgeEvents {
  action: (action: UiActionType) => void;
}

export class UiBridgeServer extends EventEmitter {
  private readonly clients = new Set<WebSocket>();
  private server: WebSocketServer | null = null;
  private status: UiStatusSnapshot;

  public constructor(
    private readonly logger: Logger,
    initialStatus: UiStatusSnapshot,
  ) {
    super();
    this.status = initialStatus;
  }

  public on<EventKey extends keyof UiBridgeEvents>(
    eventName: EventKey,
    listener: UiBridgeEvents[EventKey],
  ): this {
    return super.on(eventName, listener);
  }

  public start(port: number): void {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({ host: '127.0.0.1', port });

    this.server.on('connection', (socket) => {
      this.clients.add(socket);
      this.pushStatus(socket);

      socket.on('message', (raw) => {
        const message = parseEnvelope(raw.toString());
        if (!message || message.type !== 'ui:action') {
          return;
        }

        const action = (message.payload as { action?: UiActionType }).action;
        if (!action) {
          return;
        }

        this.emit('action', action);
      });

      socket.on('close', () => {
        this.clients.delete(socket);
      });

      socket.on('error', (error) => {
        this.logger.error('UI bridge socket error', { error: error.message });
      });
    });

    this.server.on('error', (error) => {
      this.logger.error('UI bridge server error', { error: error.message });
    });

    this.logger.info('UI bridge started', { port });
  }

  public updateStatus(partial: Partial<UiStatusSnapshot>): void {
    const nextStatus = {
      ...this.status,
      ...partial,
    };

    if (JSON.stringify(nextStatus) === JSON.stringify(this.status)) {
      return;
    }

    this.status = nextStatus;
    this.broadcast(createEnvelope('ui:status', this.status));
  }

  public getStatus(): UiStatusSnapshot {
    return { ...this.status };
  }

  public stop(): void {
    if (!this.server) {
      return;
    }

    for (const socket of this.clients) {
      socket.close();
    }

    this.clients.clear();
    this.server.close();
    this.server = null;
  }

  private pushStatus(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const statusMessage = createEnvelope('ui:status', this.status);
    socket.send(JSON.stringify(statusMessage));
  }

  private broadcast(message: MessageEnvelope): void {
    const payload = JSON.stringify(message);
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }
}
