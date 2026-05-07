#!/usr/bin/env node

import { initDatabase } from './db.js';
import {
  buildPlanningResearchPrompt,
  enqueuePlanningResearchTask,
  loadDocumentationFiles,
} from './planning-research.js';

interface ParsedArgs {
  command: 'enqueue' | 'preview' | 'help';
  title?: string;
  objective?: string;
  files: string[];
  urls: string[];
  focusAreas: string[];
  priority: number;
  model: string;
  numCtx: number;
  maxTokens: number;
}

function usage(): void {
  console.log(`Usage:
  node --env-file=.env dist/planning-research-cli.js enqueue --file docs/claude.txt --file docs/codex.txt [options]
  node --env-file=.env dist/planning-research-cli.js preview --file docs/claude.txt --file docs/codex.txt [options]

Options:
  --file <path>          Documentation excerpt file (repeatable, required)
  --url <url>            Source URL for citation context (repeatable)
  --focus <items>        Comma-separated focus areas
  --objective <text>     Specific research objective
  --title <text>         Queue task title
  --priority <0-10>      Queue priority (default 8)
  --model <name>         Ollama model (default env LLM_DEFAULT_MODEL or gemma4:26b)
  --ctx <size>           Context window (default env LLM_DEFAULT_CTX or 4096)
  --max-tokens <n>       Per-task output cap (default env LLM_DEFAULT_MAX_TOKENS or 700)
`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const files: string[] = [];
  const urls: string[] = [];
  const focusAreas: string[] = [];
  let title: string | undefined;
  let objective: string | undefined;
  let priority = 8;
  let model = process.env.LLM_DEFAULT_MODEL ?? 'gemma4:26b';
  let numCtx = parseInt(process.env.LLM_DEFAULT_CTX ?? '4096', 10);
  let maxTokens = parseInt(process.env.LLM_DEFAULT_MAX_TOKENS ?? '700', 10);

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    switch (arg) {
      case '--file':
        if (!next) throw new Error('--file requires a value');
        files.push(next);
        i++;
        break;
      case '--url':
        if (!next) throw new Error('--url requires a value');
        urls.push(next);
        i++;
        break;
      case '--focus':
        if (!next) throw new Error('--focus requires a value');
        focusAreas.push(...next.split(',').map((s) => s.trim()).filter(Boolean));
        i++;
        break;
      case '--objective':
        if (!next) throw new Error('--objective requires a value');
        objective = next;
        i++;
        break;
      case '--title':
        if (!next) throw new Error('--title requires a value');
        title = next;
        i++;
        break;
      case '--priority':
        if (!next) throw new Error('--priority requires a value');
        priority = parseInt(next, 10);
        i++;
        break;
      case '--model':
        if (!next) throw new Error('--model requires a value');
        model = next;
        i++;
        break;
      case '--ctx':
        if (!next) throw new Error('--ctx requires a value');
        numCtx = parseInt(next, 10);
        i++;
        break;
      case '--max-tokens':
        if (!next) throw new Error('--max-tokens requires a value');
        maxTokens = parseInt(next, 10);
        i++;
        break;
      case '--help':
      case '-h':
        return {
          command: 'help',
          files: [],
          urls: [],
          focusAreas: [],
          priority,
          model,
          numCtx,
          maxTokens,
        };
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  const commandRaw = positional[0] ?? 'enqueue';
  const command = commandRaw === 'preview' ? 'preview' : commandRaw === 'help' ? 'help' : 'enqueue';

  return {
    command,
    title,
    objective,
    files,
    urls,
    focusAreas,
    priority,
    model,
    numCtx,
    maxTokens,
  };
}

function validate(args: ParsedArgs): void {
  if (args.command === 'help') return;
  if (args.files.length === 0) {
    throw new Error('At least one --file path is required.');
  }
  if (Number.isNaN(args.priority) || args.priority < 0 || args.priority > 10) {
    throw new Error('--priority must be between 0 and 10.');
  }
  if (Number.isNaN(args.numCtx) || args.numCtx <= 0) {
    throw new Error('--ctx must be a positive integer.');
  }
  if (Number.isNaN(args.maxTokens) || args.maxTokens < 0) {
    throw new Error('--max-tokens must be >= 0.');
  }
}

function main(): void {
  try {
    const args = parseArgs(process.argv);
    validate(args);

    if (args.command === 'help') {
      usage();
      return;
    }

    if (args.command === 'preview') {
      const sources = loadDocumentationFiles(args.files);
      const prompt = buildPlanningResearchPrompt(
        args.objective ?? '',
        args.focusAreas,
        sources,
        args.urls,
      );
      console.log(prompt);
      return;
    }

    initDatabase();
    const result = enqueuePlanningResearchTask({
      title: args.title,
      objective: args.objective,
      focusAreas: args.focusAreas,
      documentationFiles: args.files,
      documentationUrls: args.urls,
      priority: args.priority,
      model: args.model,
      numCtx: args.numCtx,
      maxTokens: args.maxTokens,
      createdBy: process.env.CLAUDECLAW_AGENT_ID ?? 'manual',
    });

    console.log(`Queued planning research task: ${result.taskId}`);
    console.log(`  Type: ${result.taskType}`);
    console.log(`  Title: ${result.title}`);
    console.log(`  Sources: ${result.sourceCount}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
    process.exit(1);
  }
}

main();
