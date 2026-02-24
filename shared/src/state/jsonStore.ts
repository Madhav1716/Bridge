import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore<TData> {
  public constructor(private readonly filePath: string) {}

  public async read(): Promise<TData | null> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      return JSON.parse(content) as TData;
    } catch (error) {
      const typed = error as NodeJS.ErrnoException;
      if (typed.code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }

  public async write(data: TData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }
}
