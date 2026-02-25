import { EventEmitter } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { Logger } from '../logger';
import { MessageEnvelope } from '../types';
import { parseEnvelope } from './wsProtocol';

interface ServerEvents {
  message: (clientId: number, message: MessageEnvelope) => void;
  clientsChanged: (count: number) => void;
  clientConnected: (clientId: number) => void;
  clientDisconnected: (clientId: number) => void;
}

export class BridgeWebSocketServer extends EventEmitter {
  private readonly clients = new Map<number, WebSocket>();
  private server: WebSocketServer | null = null;
  private nextClientId = 1;

  public constructor(private readonly logger: Logger) {
    super();
  }

  public start(port: number, host = '0.0.0.0'): void {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({ host, port });

    this.server.on('connection', (socket: WebSocket) => {
      const clientId = this.nextClientId;
      this.nextClientId += 1;
      this.clients.set(clientId, socket);
      this.logger.info('WebSocket client connected', { clientId });
      this.emit('clientsChanged', this.clients.size);
      this.emit('clientConnected', clientId);

      socket.on('message', (data: Buffer | Buffer[] | string) => {
        const parsed = parseEnvelope(data.toString());
        if (!parsed) {
          this.logger.warn('Dropped invalid websocket payload', {
            clientId,
          });
          return;
        }

        this.emit('message', clientId, parsed);
      });

      socket.on('close', () => {
        this.clients.delete(clientId);
        this.logger.info('WebSocket client disconnected', { clientId });
        this.emit('clientsChanged', this.clients.size);
        this.emit('clientDisconnected', clientId);
      });

      socket.on('error', (error: Error) => {
        this.logger.error('WebSocket client error', {
          clientId,
          error: error.message,
        });
      });
    });

    this.server.on('error', (error: Error) => {
      this.logger.error('WebSocket server error', { error: error.message });
    });

    this.logger.info('WebSocket server started', { host, port });
  }

  public on<EventKey extends keyof ServerEvents>(
    eventName: EventKey,
    listener: ServerEvents[EventKey],
  ): this {
    return super.on(eventName, listener);
  }

  public broadcast(message: MessageEnvelope): void {
    const payload = JSON.stringify(message);

    for (const client of this.clients.values()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  public sendToClient(clientId: number, message: MessageEnvelope): boolean {
    const socket = this.clients.get(clientId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify(message));
    return true;
  }

  public closeClient(clientId: number): boolean {
    const socket = this.clients.get(clientId);
    if (!socket) {
      return false;
    }

    socket.close();
    return true;
  }

  public stop(): void {
    if (!this.server) {
      return;
    }

    for (const client of this.clients.values()) {
      client.close();
    }

    this.clients.clear();
    this.server.close();
    this.server = null;
  }

  public getClientCount(): number {
    return this.clients.size;
  }

  public getClientIds(): number[] {
    return [...this.clients.keys()];
  }
}
