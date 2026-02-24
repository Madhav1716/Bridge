import { EventEmitter } from 'node:events';
import { Logger } from '../logger';
import { BridgeWebSocketClient } from '../networking/webSocketClient';
import { createEnvelope } from '../networking/wsProtocol';
import { UiActionType, UiStatusSnapshot } from '../types';

interface UiClientEvents {
  status: (status: UiStatusSnapshot) => void;
}

export class UiBridgeClient extends EventEmitter {
  private readonly wsClient: BridgeWebSocketClient;

  public constructor(private readonly logger: Logger) {
    super();
    this.wsClient = new BridgeWebSocketClient(this.logger, {
      reconnectBaseMs: 1000,
      reconnectMaxMs: 8000,
    });

    this.wsClient.on('message', (message) => {
      if (message.type !== 'ui:status') {
        return;
      }

      this.emit('status', message.payload as UiStatusSnapshot);
    });
  }

  public on<EventKey extends keyof UiClientEvents>(
    eventName: EventKey,
    listener: UiClientEvents[EventKey],
  ): this {
    return super.on(eventName, listener);
  }

  public connect(port: number): void {
    this.wsClient.connect(`ws://127.0.0.1:${port}`);
  }

  public disconnect(): void {
    this.wsClient.disconnect();
  }

  public sendAction(action: UiActionType): void {
    this.wsClient.send(createEnvelope('ui:action', { action }));
  }
}
