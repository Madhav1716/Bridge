type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

interface EventLogContext {
  component: string;
  event: string;
  state?: string;
  hostId?: string;
}

export class Logger {
  public constructor(private readonly scope: string) {}

  public info(message: string, details?: unknown): void {
    this.write('INFO', message, details);
  }

  public warn(message: string, details?: unknown): void {
    this.write('WARN', message, details);
  }

  public error(message: string, details?: unknown): void {
    this.write('ERROR', message, details);
  }

  public debug(message: string, details?: unknown): void {
    if (process.env.BRIDGE_LOG_LEVEL !== 'debug') {
      return;
    }

    this.write('DEBUG', message, details);
  }

  public event(context: EventLogContext, details?: unknown): void {
    const stateSuffix = context.state ? ` state=${context.state}` : '';
    const hostSuffix = context.hostId ? ` host=${context.hostId}` : '';
    const message = `[${context.component}][${context.event}]${stateSuffix}${hostSuffix}`;
    this.write('INFO', message, details);
  }

  private write(level: LogLevel, message: string, details?: unknown): void {
    const timestamp = new Date().toISOString();
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    // Console logging is intentional for background daemons in this MVP.
    console.log(`[${timestamp}] [${this.scope}] [${level}] ${message}${suffix}`);
  }
}
