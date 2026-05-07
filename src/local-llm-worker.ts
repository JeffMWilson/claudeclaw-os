/**
 * Local LLM Queue Worker
 *
 * Polls the local_llm_queue table and processes tasks using Ollama (Gemma 4).
 * Runs as a standalone pm2 process alongside ClaudeClaw agents.
 *
 * Usage: node --env-file=.env dist/local-llm-worker.js
 */

import http from 'http';
import path from 'path';

import {
  claimNextLocalLlmTask,
  cleanupOldLocalLlmTasks,
  completeLocalLlmTask,
  getLocalLlmStats,
  initDatabase,
} from './db.js';
import { logger } from './logger.js';

// ── Configuration ────────────────────────────────────────────────────

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const POLL_INTERVAL_MS = parseInt(process.env.LLM_QUEUE_POLL_INTERVAL_MS ?? '2000', 10); // Check queue every 2s by default
const COOLDOWN_MS = parseInt(process.env.LLM_QUEUE_COOLDOWN_MS ?? '500', 10); // Small gap between tasks
const TASK_TIMEOUT_MS = 600_000;  // 10 minutes max per task
const CLEANUP_INTERVAL_MS = 3_600_000; // Cleanup old tasks every hour
const LLM_MAX_OUTPUT_TOKENS = parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? '512', 10); // 0 = unlimited
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '15m';
const OUTPUT_DIR = process.env.LLM_OUTPUT_DIR
  ?? path.join(process.env.HOME ?? 'C:\\Users\\JeffWilson', 'LoomView Dropbox', 'LoomView Team Folder',
    'LoomView Team - Shared Folder', 'Technology', 'ClaudeClaw', 'LLM-Output');

let running = true;
let currentTaskId: string | null = null;

// ── Ollama API ───────────────────────────────────────────────────────

interface OllamaResponse {
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

function callOllama(model: string, prompt: string, numCtx: number, numPredictOverride = 0): Promise<OllamaResponse> {
  return new Promise((resolve, reject) => {
    const numPredict = numPredictOverride > 0
      ? numPredictOverride
      : (LLM_MAX_OUTPUT_TOKENS > 0 ? LLM_MAX_OUTPUT_TOKENS : undefined);
    const url = new URL('/api/generate', OLLAMA_HOST);
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: {
        num_ctx: numCtx,
        ...(numPredict ? { num_predict: numPredict } : {}),
      },
    });

    const timeout = setTimeout(() => {
      reject(new Error(`Ollama request timed out after ${TASK_TIMEOUT_MS / 1000}s`));
    }, TASK_TIMEOUT_MS);

    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(data) as OllamaResponse;
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Failed to parse Ollama response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

function checkOllamaHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL('/api/tags', OLLAMA_HOST);
    const req = http.get(url, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

// ── Task Processing ──────────────────────────────────────────────────

async function processTask(): Promise<boolean> {
  const task = claimNextLocalLlmTask();
  if (!task) return false;

  currentTaskId = task.id;
  const startTime = Date.now();

  logger.info({
    taskId: task.id,
    taskType: task.task_type,
    title: task.title,
    model: task.model,
    maxTokens: task.num_predict > 0 ? task.num_predict : LLM_MAX_OUTPUT_TOKENS,
    priority: task.priority,
  }, 'Processing local LLM task');

  try {
    const result = await callOllama(task.model, task.input, task.num_ctx, task.num_predict ?? 0);
    const durationMs = Date.now() - startTime;
    const tokensIn = result.prompt_eval_count ?? 0;
    const tokensOut = result.eval_count ?? 0;

    completeLocalLlmTask(
      task.id,
      result.response,
      'completed',
      tokensIn,
      tokensOut,
      durationMs,
    );

    const speed = tokensOut / (durationMs / 1000);
    logger.info({
      taskId: task.id,
      tokensOut,
      durationMs,
      speed: speed.toFixed(1),
    }, 'Local LLM task completed');

    return true;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);

    completeLocalLlmTask(task.id, null, 'failed', 0, 0, durationMs, errMsg);
    logger.error({ taskId: task.id, err: errMsg, durationMs }, 'Local LLM task failed');
    return true; // Return true because we DID process a task (just failed)
  } finally {
    currentTaskId = null;
  }
}

// ── Main Loop ────────────────────────────────────────────────────────

async function mainLoop(): Promise<void> {
  logger.info({
    ollamaHost: OLLAMA_HOST,
    outputDir: OUTPUT_DIR,
    pollIntervalMs: POLL_INTERVAL_MS,
    cooldownMs: COOLDOWN_MS,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    keepAlive: OLLAMA_KEEP_ALIVE,
  }, 'Local LLM worker starting');

  // Check Ollama is reachable
  const healthy = await checkOllamaHealth();
  if (!healthy) {
    logger.error('Ollama is not reachable at ' + OLLAMA_HOST + '. Worker will retry on next poll.');
  } else {
    logger.info('Ollama connection verified');
  }

  let cleanupTimer = Date.now();

  while (running) {
    try {
      const processed = await processTask();

      if (processed) {
        // Cooldown between tasks for thermal management
        await sleep(COOLDOWN_MS);
      } else {
        // No task available, wait before polling again
        await sleep(POLL_INTERVAL_MS);
      }

      // Periodic cleanup
      if (Date.now() - cleanupTimer > CLEANUP_INTERVAL_MS) {
        const cleaned = cleanupOldLocalLlmTasks(7);
        if (cleaned > 0) {
          logger.info({ cleaned }, 'Cleaned up old local LLM tasks');
        }
        cleanupTimer = Date.now();
      }
    } catch (err) {
      logger.error({ err }, 'Worker loop error');
      await sleep(POLL_INTERVAL_MS);
    }
  }

  logger.info('Local LLM worker stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Graceful Shutdown ────────────────────────────────────────────────

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  running = false;
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  running = false;
});

// ── Startup ──────────────────────────────────────────────────────────

// Print stats on startup
initDatabase();
const stats = getLocalLlmStats(24);
logger.info({
  queued: stats.queued,
  running: stats.running,
  completedLast24h: stats.completed,
  failedLast24h: stats.failed,
}, 'Queue status on startup');

mainLoop().catch((err) => {
  logger.error({ err }, 'Worker crashed');
  process.exit(1);
});
