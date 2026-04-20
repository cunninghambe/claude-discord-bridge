import { createBot } from './bot.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { openSessionStore } from './sessions.js';
import { startWatchdog } from './watchdog.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const store = openSessionStore(config.SESSIONS_DB_PATH);
  const bot = createBot({ config, store, logger });

  await bot.start();

  const stopWatchdog = startWatchdog({
    intervalMs: config.POLL_INTERVAL_MS,
    claudeBin: config.CLAUDE_BIN,
    oauthToken: config.CLAUDE_CODE_OAUTH_TOKEN,
    logger,
    onEvent: (event) => {
      if (event.kind === 'died') {
        bot.alertAuthDead(event.reason).catch((err: unknown) => {
          logger.error({ err }, 'failed to DM auth-dead alert');
        });
      } else {
        bot.alertAuthRecovered().catch((err: unknown) => {
          logger.error({ err }, 'failed to DM auth-recovered alert');
        });
      }
    },
  });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down');
    stopWatchdog();
    try {
      await bot.stop();
    } catch (err) {
      logger.error({ err }, 'bot stop failed');
    }
    try {
      store.close();
    } catch (err) {
      logger.error({ err }, 'store close failed');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
