import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  const isTTY = Boolean(process.stdout.isTTY);
  if (isTTY) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      },
    });
  }
  return pino({ level });
}
