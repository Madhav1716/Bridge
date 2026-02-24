import psList from 'ps-list';
import { Logger } from '../logger';
import { ProcessStatus } from '../types';

const DEFAULT_DEV_KEYWORDS = [
  'node',
  'npm',
  'pnpm',
  'yarn',
  'vite',
  'webpack',
  'tsc',
  'next',
  'nuxt',
  'python',
  'dotnet',
  'cargo',
  'go',
];

export class DevProcessTracker {
  public constructor(
    private readonly logger: Logger,
    private readonly keywords: string[] = DEFAULT_DEV_KEYWORDS,
  ) {}

  public async snapshot(): Promise<ProcessStatus[]> {
    try {
      const processes = await psList();

      return this.keywords.map((keyword) => {
        const matches = processes.filter((processInfo) => {
          const name = processInfo.name.toLowerCase();
          const command = processInfo.cmd?.toLowerCase() ?? '';
          return name.includes(keyword) || command.includes(keyword);
        });

        return {
          name: keyword,
          running: matches.length > 0,
          count: matches.length,
          pids: matches.map((match) => match.pid),
        };
      });
    } catch (error) {
      const typed = error as Error;
      this.logger.error('Failed to snapshot processes', {
        error: typed.message,
      });

      return this.keywords.map((keyword) => ({
        name: keyword,
        running: false,
        count: 0,
        pids: [],
      }));
    }
  }
}
