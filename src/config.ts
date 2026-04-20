import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20, 'token looks too short'),
  DISCORD_BOT_TOKEN: z.string().min(20, 'discord bot token looks too short'),
  OWNER_DISCORD_ID: z.string().regex(/^\d{17,20}$/, 'expected 17-20 digit Discord snowflake'),
  CLAUDE_BIN: z.string().default('/root/.local/bin/claude'),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(21_600_000),
  SESSIONS_DB_PATH: z.string().default('./data/sessions.db'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  AUTH_ALERT_DEDUPE_MS: z.coerce.number().int().positive().default(300_000),
  MAX_QUEUE_DEPTH_PER_USER: z.coerce.number().int().positive().default(3),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
