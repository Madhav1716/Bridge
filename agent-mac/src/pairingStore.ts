import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '@bridge/shared';

export interface PairingState {
  pairedHostId: string | null;
  pairedHostName: string | null;
  updatedAt: string | null;
}

const EMPTY_PAIRING_STATE: PairingState = {
  pairedHostId: null,
  pairedHostName: null,
  updatedAt: null,
};

function normalizePairingState(candidate: Partial<PairingState> | null): PairingState {
  if (!candidate) {
    return { ...EMPTY_PAIRING_STATE };
  }

  return {
    pairedHostId: candidate.pairedHostId ?? null,
    pairedHostName: candidate.pairedHostName ?? null,
    updatedAt: candidate.updatedAt ?? null,
  };
}

export class PairingStore {
  public constructor(
    private readonly logger: Logger,
    private readonly filePath: string,
  ) {}

  public async load(): Promise<PairingState> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PairingState>;
      return normalizePairingState(parsed);
    } catch {
      return { ...EMPTY_PAIRING_STATE };
    }
  }

  public async save(state: PairingState): Promise<void> {
    const normalized = normalizePairingState(state);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8',
    );
    this.logger.info('Saved host pairing state', {
      pairedHostId: normalized.pairedHostId,
      pairedHostName: normalized.pairedHostName,
    });
  }
}

