import chokidar, { FSWatcher } from 'chokidar';
import path from 'node:path';
import { Logger } from '../logger';

export class ProjectFileWatcher {
  private watcher: FSWatcher | null = null;

  public constructor(
    private readonly logger: Logger,
    private readonly projectPath: string,
    private readonly onChange: (filePath: string) => void,
  ) {}

  public start(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.projectPath, {
      ignoreInitial: true,
      ignored: [
        `${this.projectPath}/**/node_modules/**`,
        `${this.projectPath}/**/.git/**`,
      ],
    });

    this.watcher.on('all', (eventName, absolutePath) => {
      if (!['add', 'change', 'unlink'].includes(eventName)) {
        return;
      }

      const relativePath = path.relative(this.projectPath, absolutePath);
      this.onChange(relativePath);
    });

    this.watcher.on('error', (error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Unknown watcher error';
      this.logger.error('Filesystem watcher error', { error: message });
    });

    this.logger.info('Filesystem watcher started', {
      projectPath: this.projectPath,
    });
  }

  public async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }

    await this.watcher.close();
    this.watcher = null;
    this.logger.info('Filesystem watcher stopped');
  }
}
