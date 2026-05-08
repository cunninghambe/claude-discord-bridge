import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';
import { downloadAttachments, formatManifest, sweepOldAttachments } from './attachments.js';
import { chunkForDiscord } from './chunking.js';
import { runClaude } from './claude.js';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import type { SessionStore } from './sessions.js';

export type Bot = {
  start(): Promise<void>;
  stop(): Promise<void>;
  dmOwner(text: string): Promise<void>;
  alertAuthDead(reason: string): Promise<void>;
  alertAuthRecovered(): Promise<void>;
};

type Deps = {
  config: Config;
  store: SessionStore;
  logger: Logger;
};

export function createBot(deps: Deps): Bot {
  const { config, store, logger } = deps;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const activeCount = new Map<string, number>();
  const queueChain = new Map<string, Promise<void>>();
  let lastAuthDeadAlertAt = 0;

  function enqueue(userId: string, work: () => Promise<void>): boolean {
    const count = activeCount.get(userId) ?? 0;
    if (count >= config.MAX_QUEUE_DEPTH_PER_USER) return false;
    activeCount.set(userId, count + 1);
    const prior = queueChain.get(userId) ?? Promise.resolve();
    const next = prior
      .then(() => work())
      .finally(() => {
        const remaining = (activeCount.get(userId) ?? 1) - 1;
        if (remaining <= 0) {
          activeCount.delete(userId);
          queueChain.delete(userId);
        } else {
          activeCount.set(userId, remaining);
        }
      });
    queueChain.set(
      userId,
      next.catch(() => {
        // swallow so chain survives
      }),
    );
    return true;
  }

  async function sendChunked(
    send: (payload: string | { files: AttachmentBuilder[] }) => Promise<unknown>,
    text: string,
  ): Promise<void> {
    for (const c of chunkForDiscord(text)) {
      if (c.kind === 'text') {
        await send(c.content);
      } else {
        const buf = Buffer.from(c.content, 'utf8');
        await send({ files: [new AttachmentBuilder(buf, { name: c.filename })] });
      }
    }
  }

  async function processPrompt(msg: Message): Promise<void> {
    const userId = msg.author.id;
    const existing = store.get(userId);

    if ('sendTyping' in msg.channel) {
      msg.channel.sendTyping().catch((err) => {
        logger.debug({ err }, 'initial sendTyping failed');
      });
    }
    const typingTimer = setInterval(() => {
      if ('sendTyping' in msg.channel) {
        msg.channel.sendTyping().catch(() => {
          // non-fatal
        });
      }
    }, 8_000);

    const download = await downloadAttachments({
      messageId: msg.id,
      attachments: Array.from(msg.attachments.values()).map((a) => ({
        id: a.id,
        url: a.url,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
      })),
    });
    if (download.files.length > 0) {
      logger.info(
        {
          messageId: msg.id,
          attachmentCount: download.files.length,
          successes: download.files.filter((f) => f.ok).length,
        },
        'downloaded discord attachments',
      );
    }
    const prompt = formatManifest(download) + msg.content;

    try {
      const result = await runClaude({
        prompt,
        sessionId: existing?.claudeSessionId ?? null,
        timeoutMs: config.CLAUDE_TIMEOUT_MS,
        claudeBin: config.CLAUDE_BIN,
        oauthToken: config.CLAUDE_CODE_OAUTH_TOKEN,
        logger,
      });

      if (result.ok) {
        store.upsert({
          discordUserId: userId,
          claudeSessionId: result.sessionId,
          createdAt: existing?.createdAt ?? new Date(),
          lastUsedAt: new Date(),
        });
        await sendChunked((p) => msg.reply(p as never), result.output);
        return;
      }

      if (result.kind === 'auth_dead') {
        logger.warn({ detail: result.detail }, 'auth dead during handling');
        await msg.reply('Claude auth is dead. DMing recovery steps.');
        await alertAuthDead(result.detail);
        return;
      }

      if (result.kind === 'timeout') {
        const secs = Math.round(result.elapsedMs / 1000);
        await msg.reply(`Timed out after ${secs}s. Try again, or send a smaller prompt.`);
        return;
      }

      logger.error({ detail: result.detail, exitCode: result.exitCode }, 'claude process_error');
      await msg.reply(
        `Claude failed (exit ${result.exitCode ?? '?'}). ${result.detail.slice(0, 400)}`,
      );
    } finally {
      clearInterval(typingTimer);
    }
  }

  async function handleMessage(msg: Message): Promise<void> {
    logger.info(
      {
        authorId: msg.author.id,
        bot: msg.author.bot,
        isDM: msg.guildId === null,
        contentLen: msg.content.length,
      },
      'message received',
    );
    if (msg.author.bot) return;
    if (msg.guildId !== null) return;
    if (msg.author.id !== config.OWNER_DISCORD_ID) {
      logger.warn({ userId: msg.author.id }, 'ignoring non-owner DM');
      return;
    }

    const content = msg.content.trim();
    if (content === '/reset' || content === '/new') {
      store.clear(msg.author.id);
      await msg.reply('Session cleared. Next message starts a fresh Claude conversation.');
      return;
    }
    if (content.length === 0) return;

    const accepted = enqueue(msg.author.id, () => processPrompt(msg));
    if (!accepted) {
      await msg.reply(
        'Still working on your previous messages — dropping this one. Try again in a moment.',
      );
    }
  }

  async function dmOwner(text: string): Promise<void> {
    const user = await client.users.fetch(config.OWNER_DISCORD_ID);
    await sendChunked((p) => user.send(p as never), text);
  }

  async function alertAuthDead(reason: string): Promise<void> {
    const now = Date.now();
    if (now - lastAuthDeadAlertAt < config.AUTH_ALERT_DEDUPE_MS) {
      logger.debug('suppressing deduped auth-dead alert');
      return;
    }
    lastAuthDeadAlertAt = now;
    const text = [
      'Claude auth is dead.',
      `Reason: ${reason.slice(0, 300)}`,
      '',
      'To recover:',
      '1. Run `claude setup-token` on any device with a browser',
      '2. Copy the new 1-year token',
      '3. Update `CLAUDE_CODE_OAUTH_TOKEN` in:',
      '   - `/root/.claude-token.env` (for interactive shells)',
      '   - `/root/claude-discord-bridge/.env` (for this bot)',
      '4. `pm2 restart claude-discord-bridge`',
    ].join('\n');
    await dmOwner(text);
  }

  async function alertAuthRecovered(): Promise<void> {
    lastAuthDeadAlertAt = 0;
    await dmOwner('Claude auth recovered.');
  }

  const ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const ATTACHMENT_BASE_DIR = '/root/claude-bridge-data/attachments';

  return {
    async start() {
      sweepOldAttachments(ATTACHMENT_BASE_DIR, ATTACHMENT_TTL_MS)
        .then((r) =>
          logger.info(
            { removed: r.removedDirs.length, kept: r.kept, baseDir: ATTACHMENT_BASE_DIR },
            'swept old attachment dirs',
          ),
        )
        .catch((err: unknown) =>
          logger.warn({ err }, 'attachment sweep failed; continuing'),
        );

      client.on(Events.MessageCreate, (msg) => {
        handleMessage(msg as Message).catch((err: unknown) => {
          logger.error({ err }, 'message handler failed');
        });
      });
      client.once(Events.ClientReady, (c) => {
        logger.info(
          { tag: c.user.tag, ownerId: config.OWNER_DISCORD_ID },
          'discord gateway ready',
        );
        dmOwner('bridge-online self-test').then(
          () => logger.info('startup self-test DM delivered'),
          (err: unknown) =>
            logger.error({ err: String(err) }, 'startup self-test DM FAILED'),
        );
      });
      client.on(Events.Error, (err) => {
        logger.error({ err }, 'discord client error');
      });
      client.on(Events.Warn, (info) => {
        logger.warn({ info }, 'discord warn');
      });
      await client.login(config.DISCORD_BOT_TOKEN);
    },
    async stop() {
      await client.destroy();
    },
    dmOwner,
    alertAuthDead,
    alertAuthRecovered,
  };
}
