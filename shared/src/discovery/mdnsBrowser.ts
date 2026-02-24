import { EventEmitter } from 'node:events';
import { BridgeServiceRecord } from '../types';
import { Logger } from '../logger';

interface BrowserEvents {
  serviceUp: (service: BridgeServiceRecord) => void;
  serviceDown: (service: BridgeServiceRecord) => void;
}

export class MdnsBrowser extends EventEmitter {
  private bonjour: any;
  private browser: any;

  public constructor(private readonly logger: Logger) {
    super();
  }

  public on<EventKey extends keyof BrowserEvents>(
    eventName: EventKey,
    listener: BrowserEvents[EventKey],
  ): this {
    return super.on(eventName, listener);
  }

  public start(type: string): void {
    if (this.browser) {
      return;
    }

    const createBonjour = require('bonjour') as () => any;
    this.bonjour = createBonjour();
    this.browser = this.bonjour.find({ type });

    this.browser.on('up', (service: any) => {
      const mapped = this.mapService(service);
      this.logger.info('mDNS service discovered', {
        id: mapped.id,
        name: mapped.name,
        host: mapped.host,
      });
      this.emit('serviceUp', mapped);
    });

    this.browser.on('down', (service: any) => {
      const mapped = this.mapService(service);
      this.logger.info('mDNS service went down', {
        id: mapped.id,
        name: mapped.name,
      });
      this.emit('serviceDown', mapped);
    });
  }

  public stop(): void {
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    this.logger.info('mDNS browser stopped');
  }

  private mapService(service: any): BridgeServiceRecord {
    const addresses = Array.isArray(service?.addresses)
      ? service.addresses.filter((address: string) => !address.startsWith('127.'))
      : [];

    const host = addresses[0] ?? service?.referer?.address ?? '127.0.0.1';

    return {
      id: service.fqdn ?? `${service.name}:${service.port}`,
      identity:
        (service.txt as Record<string, string> | undefined)?.hostId ??
        service.fqdn ??
        `${service.name}:${service.port}`,
      name: service.name ?? 'bridge-host',
      host,
      port: service.port ?? 0,
      addresses,
      txt: (service.txt as Record<string, string>) ?? {},
    };
  }
}
