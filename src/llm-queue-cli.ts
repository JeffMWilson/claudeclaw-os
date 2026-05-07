#!/usr/bin/env node
/**
 * ClaudeClaw Local LLM Queue CLI
 *
 * Submit tasks to the local Gemma 4 background worker, check results, and manage the queue.
 *
 * Usage:
 *   node --env-file=.env dist/llm-queue-cli.js submit "prompt text"
 *   node --env-file=.env dist/llm-queue-cli.js submit --type research --priority 8 --max-tokens 320 --title "Label" "prompt"
 *   node --env-file=.env dist/llm-queue-cli.js list [--status queued|running|completed|failed]
 *   node --env-file=.env dist/llm-queue-cli.js result <id>
 *   node --env-file=.env dist/llm-queue-cli.js cancel <id>
 *   node --env-file=.env dist/llm-queue-cli.js stats
 */

import { randomBytes } from 'crypto';

import {
  cancelLocalLlmTask,
  createLocalLlmTask,
  getLocalLlmStats,
  getLocalLlmTask,
  getLocalLlmTasks,
  initDatabase,
} from './db.js';

initDatabase();

// ── Flag parsing ─────────────────────────────────────────────────────

function extractFlag(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1]!;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const taskType = extractFlag('--type') ?? 'general';
const title = extractFlag('--title') ?? '';
const priority = parseInt(extractFlag('--priority') ?? '5', 10);
const model = extractFlag('--model') ?? process.env.LLM_DEFAULT_MODEL ?? 'gemma4:26b';
const numCtx = parseInt(extractFlag('--ctx') ?? process.env.LLM_DEFAULT_CTX ?? '2048', 10);
const maxTokens = parseInt(extractFlag('--max-tokens') ?? process.env.LLM_DEFAULT_MAX_TOKENS ?? '0', 10);
const statusFilter = extractFlag('--status') ?? undefined;
const createdBy = process.env.CLAUDECLAW_AGENT_ID ?? 'manual';

// Remove all flags and their values from argv for clean positional parsing
const flagNames = ['--type', '--title', '--priority', '--model', '--ctx', '--max-tokens', '--status'];
const flagIndices = new Set<number>();
for (const f of flagNames) {
  const idx = process.argv.indexOf(f);
  if (idx !== -1) {
    flagIndices.add(idx);
    flagIndices.add(idx + 1);
  }
}
const cleanedArgv = process.argv.filter((_, i) => !flagIndices.has(i));
const [, , command, ...rest] = cleanedArgv;

// ── Helpers ──────────────────────────────────────────────────────────

function formatDate(unix: number | null): string {
  if (!unix) return '-';
  return new Date(unix * 1000).toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' });
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 3) + '...';
}

// ── Commands ─────────────────────────────────────────────────────────

switch (command) {
  case 'submit': {
    const prompt = rest[0];
    if (!prompt) {
      console.error('Usage: llm-queue-cli submit [--type TYPE] [--priority N] [--max-tokens N] [--title LABEL] "prompt"');
      process.exit(1);
    }
    const id = randomBytes(8).toString('hex');
    createLocalLlmTask(id, taskType, prompt, title, priority, model, numCtx, maxTokens, createdBy);
    console.log(`Task queued: ${id}`);
    console.log(`  Type: ${taskType} | Priority: ${priority} | Model: ${model} | Context: ${numCtx} | Max tokens: ${maxTokens > 0 ? maxTokens : 'worker-default'}`);
    if (title) console.log(`  Title: ${title}`);
    break;
  }

  case 'list': {
    const tasks = getLocalLlmTasks(statusFilter, 30);
    if (tasks.length === 0) {
      console.log(statusFilter ? `No ${statusFilter} tasks.` : 'Queue is empty.');
      break;
    }
    console.log(`${'ID'.padEnd(18)} ${'Type'.padEnd(12)} ${'Status'.padEnd(10)} ${'Pri'.padEnd(4)} ${'Title'.padEnd(25)} ${'Created'.padEnd(20)}`);
    console.log('-'.repeat(95));
    for (const t of tasks) {
      console.log(
        `${t.id.padEnd(18)} ${t.task_type.padEnd(12)} ${t.status.padEnd(10)} ${String(t.priority).padEnd(4)} ${truncate(t.title || '(untitled)', 25).padEnd(25)} ${formatDate(t.created_at).padEnd(20)}`,
      );
    }
    console.log(`\nTotal: ${tasks.length} tasks shown`);
    break;
  }

  case 'result': {
    const id = rest[0];
    if (!id) {
      console.error('Usage: llm-queue-cli result <task-id>');
      process.exit(1);
    }
    const task = getLocalLlmTask(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
    console.log(`Task: ${task.id}`);
    console.log(`Type: ${task.task_type} | Status: ${task.status} | Priority: ${task.priority}`);
    console.log(`Model: ${task.model} | Context: ${task.num_ctx} | Max tokens: ${task.num_predict > 0 ? task.num_predict : 'worker-default'}`);
    console.log(`Created: ${formatDate(task.created_at)} by ${task.created_by}`);
    if (task.started_at) console.log(`Started: ${formatDate(task.started_at)}`);
    if (task.completed_at) console.log(`Completed: ${formatDate(task.completed_at)}`);
    if (task.tokens_out) {
      const speed = task.tokens_out / (task.duration_ms / 1000);
      console.log(`Tokens: ${task.tokens_in} in / ${task.tokens_out} out | ${(task.duration_ms / 1000).toFixed(1)}s | ${speed.toFixed(1)} tok/s`);
    }
    if (task.error) console.log(`\nError: ${task.error}`);
    if (task.output) {
      console.log('\n--- Output ---');
      console.log(task.output);
    } else if (task.status === 'queued') {
      console.log('\n(Task is still queued, no output yet)');
    } else if (task.status === 'running') {
      console.log('\n(Task is currently running...)');
    }
    break;
  }

  case 'cancel': {
    const id = rest[0];
    if (!id) {
      console.error('Usage: llm-queue-cli cancel <task-id>');
      process.exit(1);
    }
    const success = cancelLocalLlmTask(id);
    console.log(success ? `Cancelled: ${id}` : `Could not cancel ${id} (already completed or not found)`);
    break;
  }

  case 'stats': {
    const hours = parseInt(rest[0] ?? '24', 10);
    const s = getLocalLlmStats(hours);
    console.log(`Local LLM Queue Stats (last ${hours}h):`);
    console.log(`  Queued:    ${s.queued}`);
    console.log(`  Running:   ${s.running}`);
    console.log(`  Completed: ${s.completed}`);
    console.log(`  Failed:    ${s.failed}`);
    console.log(`  Total:     ${s.total}`);
    if (s.totalTokensOut > 0) {
      console.log(`  Tokens generated: ${s.totalTokensOut.toLocaleString()}`);
      console.log(`  Total inference time: ${(s.totalDurationMs / 1000 / 60).toFixed(1)} minutes`);
      const avgSpeed = s.totalTokensOut / (s.totalDurationMs / 1000);
      console.log(`  Avg speed: ${avgSpeed.toFixed(1)} tok/s`);
    }
    break;
  }

  default:
    console.log(`ClaudeClaw Local LLM Queue CLI

Commands:
  submit "prompt"           Queue a task for local Gemma processing
    --type <type>           Task type (research, content, prospect, general)
    --title "label"         Short label for the task
    --priority <0-10>       Priority (default 5, higher = first)
    --model <name>          Ollama model (default env LLM_DEFAULT_MODEL or gemma4:26b)
    --ctx <size>            Context window size (default env LLM_DEFAULT_CTX or 2048)
    --max-tokens <n>        Per-task output cap (0 = use worker default)

  list [--status <status>]  List tasks (queued, running, completed, failed)
  result <id>               Get full output of a completed task
  cancel <id>               Cancel a queued or running task
  stats [hours]             Show queue statistics (default last 24h)
`);
    break;
}
