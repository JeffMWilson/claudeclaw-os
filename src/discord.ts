import fs from 'fs';
import path from 'path';

import { Attachment, Client, GatewayIntentBits, Message } from 'discord.js';

import { runAgentWithRetry } from './agent.js';
import { buildCostFooter } from './cost-footer.js';
import {
  AGENT_ID,
  AGENT_TIMEOUT_MS,
  DISCORD_ALLOWED_CHANNEL_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_ENABLED,
  MODEL_FALLBACK_CHAIN,
  SHOW_COST_FOOTER,
  agentDefaultModel,
  agentMcpAllowlist,
  agentSystemPrompt,
} from './config.js';
import { getRecentTaskOutputs, getSession, saveCompactionEvent, saveTokenUsage, setSession } from './db.js';
import { AgentError } from './errors.js';
import { logger } from './logger.js';
import { buildMemoryContext, evaluateMemoryRelevance, saveConversationTurn } from './memory.js';
import { messageQueue } from './message-queue.js';
import { UPLOADS_DIR, downloadRemoteFile, transcribeAudio } from './voice.js';

const DISCORD_MAX_MESSAGE = 1900;
const TOOL_NOTIFY_INTERVAL_MS = 30_000;

const AUDIO_EXTENSIONS = new Set([
  '.ogg',
  '.oga',
  '.opus',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
]);

let discordClient: Client | null = null;

export function isAudioAttachmentDescriptor(contentType?: string | null, fileName?: string | null): boolean {
  if (contentType?.toLowerCase().startsWith('audio/')) return true;
  if (!fileName) return false;
  const ext = path.extname(fileName).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

export function splitDiscordMessage(text: string, maxLength = DISCORD_MAX_MESSAGE): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const chunk = remaining.slice(0, maxLength);
    const newlineIdx = chunk.lastIndexOf('\n');
    const splitAt = newlineIdx > Math.floor(maxLength * 0.5) ? newlineIdx : maxLength;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function getFirstAudioAttachment(message: Message): Attachment | null {
  for (const attachment of message.attachments.values()) {
    if (isAudioAttachmentDescriptor(attachment.contentType, attachment.name)) {
      return attachment;
    }
  }
  return null;
}

async function sendDiscordResponse(message: Message, text: string): Promise<void> {
  const parts = splitDiscordMessage(text);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      await message.reply({
        content: part,
        allowedMentions: { repliedUser: false, parse: [] },
      });
    } else {
      await message.reply({
        content: part,
        allowedMentions: { repliedUser: false, parse: [] },
      });
    }
  }
}

async function sendTyping(message: Message): Promise<void> {
  try {
    const channel = message.channel as { sendTyping?: () => Promise<unknown> };
    if (channel.sendTyping) await channel.sendTyping();
  } catch {
    // best effort
  }
}

function sendChannelStatus(message: Message, content: string): void {
  void message.reply({
    content,
    allowedMentions: { repliedUser: false, parse: [] },
  }).catch(() => {});
}

function buildDiscordUserInput(messageText: string, transcript: string | null): string {
  const trimmed = messageText.trim();
  if (!transcript) return trimmed;
  const header = '[Discord audio transcript]';
  return trimmed ? `${trimmed}\n\n${header}\n${transcript}` : `${header}\n${transcript}`;
}

async function processDiscordMessage(message: Message): Promise<void> {
  const queueKey = `discord:${message.channelId}:${message.author.id}`;
  const baseText = message.content ?? '';
  const audio = getFirstAudioAttachment(message);

  let transcript: string | null = null;
  if (audio) {
    let localPath: string | null = null;
    try {
      localPath = await downloadRemoteFile(audio.url, UPLOADS_DIR, audio.name ?? undefined);
      transcript = (await transcribeAudio(localPath)).trim();
      if (!transcript) {
        await sendDiscordResponse(message, 'I could not transcribe that audio. Please try again with a clearer clip.');
        return;
      }
    } catch (err) {
      logger.error({ err }, 'Discord audio transcription failed');
      await sendDiscordResponse(message, 'Audio transcription failed. Please try again.');
      return;
    } finally {
      if (localPath) {
        try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      }
    }
  }

  const userInput = buildDiscordUserInput(baseText, transcript);
  if (!userInput) return;

  const sessionId = getSession(queueKey, AGENT_ID);
  const { contextText: memCtx, surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext(queueKey, userInput, AGENT_ID);

  const parts: string[] = [];
  if (agentSystemPrompt && !sessionId) {
    parts.push(`[Agent role — follow these instructions]\n${agentSystemPrompt}\n[End agent role]`);
  }
  if (memCtx) parts.push(memCtx);

  const recentTasks = getRecentTaskOutputs(AGENT_ID, 30);
  if (recentTasks.length > 0) {
    const taskLines = recentTasks.map((t) => {
      const ago = Math.round((Date.now() / 1000 - t.last_run) / 60);
      return `[Scheduled task ran ${ago}m ago]\nTask: ${t.prompt}\nOutput:\n${t.last_result}`;
    });
    parts.push(`[Recent scheduled task context — the user may be replying to this]\n${taskLines.join('\n\n')}\n[End task context]`);
  }
  parts.push(userInput);
  const fullMessage = parts.join('\n\n');

  await sendTyping(message);
  let lastToolNotify = 0;
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), AGENT_TIMEOUT_MS);

  try {
    const result = await runAgentWithRetry(
      fullMessage,
      sessionId,
      () => void sendTyping(message),
      (event) => {
        if (event.type !== 'tool_active') return;
        const now = Date.now();
        if (now - lastToolNotify < TOOL_NOTIFY_INTERVAL_MS) return;
        lastToolNotify = now;
        sendChannelStatus(message, `⚙️ ${event.description}...`);
      },
      agentDefaultModel,
      abortCtrl,
      undefined,
      (attempt, error) => {
        sendChannelStatus(message, `${error.recovery.userMessage} (retry ${attempt}/2)`);
      },
      MODEL_FALLBACK_CHAIN.length > 0 ? MODEL_FALLBACK_CHAIN : undefined,
      agentMcpAllowlist,
    );

    clearTimeout(timeoutId);

    if (result.aborted) {
      await sendDiscordResponse(
        message,
        `Timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s. Try breaking the task into smaller steps.`,
      );
      return;
    }

    if (result.newSessionId) {
      setSession(queueKey, result.newSessionId, AGENT_ID);
    }

    const responseText = result.text?.trim() || 'Done.';
    saveConversationTurn(queueKey, userInput, responseText, result.newSessionId ?? sessionId, AGENT_ID);
    if (surfacedMemoryIds.length > 0) {
      void evaluateMemoryRelevance(surfacedMemoryIds, surfacedMemorySummaries, userInput, responseText).catch(() => {});
    }

    const modelLabel = agentDefaultModel ?? 'claude-opus-4-6';
    const withFooter = responseText + buildCostFooter(SHOW_COST_FOOTER, result.usage, modelLabel);
    await sendDiscordResponse(message, withFooter);

    if (result.usage) {
      const activeSessionId = result.newSessionId ?? sessionId;
      saveTokenUsage(
        queueKey,
        activeSessionId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.lastCallCacheRead,
        result.usage.lastCallCacheRead + result.usage.lastCallInputTokens,
        result.usage.totalCostUsd,
        result.usage.didCompact,
        AGENT_ID,
      );
      if (result.usage.didCompact && activeSessionId) {
        saveCompactionEvent(
          activeSessionId,
          result.usage.preCompactTokens ?? 0,
          result.usage.lastCallInputTokens,
          0,
        );
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof AgentError) {
      logger.error({ category: err.category, recovery: err.recovery }, 'Discord agent error');
      await sendDiscordResponse(message, err.recovery.userMessage);
      return;
    }
    logger.error({ err }, 'Discord message handling failed');
    await sendDiscordResponse(message, 'Something went wrong while processing your message.');
  }
}

export async function startDiscordBridge(): Promise<void> {
  if (AGENT_ID !== 'main') return;
  if (!DISCORD_ENABLED) return;

  if (!DISCORD_BOT_TOKEN) {
    logger.warn('Discord bridge enabled but DISCORD_BOT_TOKEN is missing');
    return;
  }
  if (!DISCORD_ALLOWED_CHANNEL_ID) {
    logger.warn('Discord bridge enabled but DISCORD_ALLOWED_CHANNEL_ID is missing');
    return;
  }
  if (discordClient) return;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on('ready', () => {
    logger.info({ user: client.user?.tag, channelId: DISCORD_ALLOWED_CHANNEL_ID }, 'Discord bridge connected');
  });

  client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (message.channelId !== DISCORD_ALLOWED_CHANNEL_ID) return;
    const hasAudio = !!getFirstAudioAttachment(message);
    const hasText = message.content.trim().length > 0;
    if (!hasAudio && !hasText) return;

    const queueKey = `discord:${message.channelId}:${message.author.id}`;
    messageQueue.enqueue(queueKey, () => processDiscordMessage(message));
  });

  client.on('error', (err) => {
    logger.error({ err }, 'Discord bridge client error');
  });

  await client.login(DISCORD_BOT_TOKEN);
  discordClient = client;
}

export async function stopDiscordBridge(): Promise<void> {
  if (!discordClient) return;
  try {
    discordClient.destroy();
  } catch {
    // ignore
  } finally {
    discordClient = null;
  }
}
