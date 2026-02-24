import { Logger } from '../logger';

export interface PublishOptions {
  type: string;
  name: string;
  port: number;
  txt?: Record<string, string>;
}

export class MdnsPublisher {
  private bonjour: any;
  private service: any;

  public constructor(private readonly logger: Logger) {}

  public start(options: PublishOptions): void {
    if (this.service) {
      return;
    }

    const createBonjour = require('bonjour') as () => any;
    this.bonjour = createBonjour();
    this.service = this.bonjour.publish({
      type: options.type,
      name: options.name,
      port: options.port,
      txt: options.txt ?? {},
    });

    this.logger.info('mDNS service published', {
      type: options.type,
      name: options.name,
      port: options.port,
    });
  }

  public stop(): void {
    if (this.service) {
      this.service.stop();
      this.service = null;
    }

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    this.logger.info('mDNS publisher stopped');
  }
}
