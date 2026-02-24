import { Logger } from '@bridge/shared';

export async function ensureAutoStartPrepared(logger: Logger): Promise<void> {
  // MVP scope: this marks where LaunchAgent registration is wired in.
  logger.info(
    'Autostart setup is prepared as a placeholder. Configure LaunchAgent in production deployment.',
  );
}
