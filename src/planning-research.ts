import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import { createLocalLlmTask } from './db.js';

const DEFAULT_SOURCE_URLS = [
  'https://docs.anthropic.com/en/docs/claude-code',
  'https://developers.openai.com/codex',
];

export interface PlanningResearchSource {
  path: string;
  preview: string;
  charCount: number;
}

export interface PlanningResearchRequest {
  title?: string;
  objective?: string;
  focusAreas: string[];
  documentationFiles: string[];
  documentationUrls: string[];
  priority: number;
  model: string;
  numCtx: number;
  maxTokens: number;
  createdBy: string;
}

export interface PlanningResearchEnqueueResult {
  taskId: string;
  taskType: string;
  title: string;
  sourceCount: number;
}

export function loadDocumentationFiles(filePaths: string[], maxCharsPerFile = 20_000): PlanningResearchSource[] {
  const out: PlanningResearchSource[] = [];
  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Documentation file not found: ${resolved}`);
    }
    const text = fs.readFileSync(resolved, 'utf8');
    const normalized = text.replace(/\r\n/g, '\n').trim();
    out.push({
      path: resolved,
      charCount: normalized.length,
      preview: normalized.slice(0, maxCharsPerFile),
    });
  }
  return out;
}

export function buildPlanningResearchPrompt(
  objective: string,
  focusAreas: string[],
  fileSources: PlanningResearchSource[],
  urls: string[],
): string {
  const objectiveLine = objective.trim().length > 0
    ? objective.trim()
    : 'Extract planning principles from Claude Code and Codex docs and propose actionable improvements for a multi-agent runtime.';

  const focusLine = focusAreas.length > 0
    ? focusAreas.join(', ')
    : 'task decomposition, planning checkpoints, error recovery, execution safety, and verification loops';

  const urlBlock = urls.length > 0
    ? urls.map((u) => `- ${u}`).join('\n')
    : '- (none provided)';

  const fileBlock = fileSources.length > 0
    ? fileSources.map((src, idx) => {
      return [
        `### Source ${idx + 1}: ${src.path}`,
        `Characters: ${src.charCount}`,
        src.preview,
      ].join('\n');
    }).join('\n\n')
    : 'No local documentation excerpts were provided.';

  return [
    'You are a research analyst improving planning quality for a multi-agent coding system.',
    '',
    '## Objective',
    objectiveLine,
    '',
    '## Focus Areas',
    focusLine,
    '',
    '## Source URLs',
    urlBlock,
    '',
    '## Documentation Excerpts',
    fileBlock,
    '',
    '## Required Output (JSON only)',
    '{',
    '  "executive_summary": "string",',
    '  "planning_principles": [',
    '    {',
    '      "name": "string",',
    '      "source": "claude|codex|both",',
    '      "why_it_matters": "string",',
    '      "operational_rule": "string"',
    '    }',
    '  ],',
    '  "workflow_improvements": [',
    '    {',
    '      "change": "string",',
    '      "impact": "string",',
    '      "risk": "string"',
    '    }',
    '  ],',
    '  "prompting_changes": [',
    '    {',
    '      "target": "system|agent|task",',
    '      "before": "string",',
    '      "after": "string"',
    '    }',
    '  ],',
    '  "implementation_plan": [',
    '    {',
    '      "step": "string",',
    '      "owner": "string",',
    '      "effort": "S|M|L"',
    '    }',
    '  ],',
    '  "quick_wins_24h": ["string"],',
    '  "validation_checks": ["string"]',
    '}',
    '',
    'Use only information grounded in the provided excerpts and URLs. Keep the response concise but specific.',
  ].join('\n');
}

export function enqueuePlanningResearchTask(request: PlanningResearchRequest): PlanningResearchEnqueueResult {
  const fileSources = loadDocumentationFiles(request.documentationFiles);
  const urls = request.documentationUrls.length > 0
    ? request.documentationUrls
    : DEFAULT_SOURCE_URLS;
  const prompt = buildPlanningResearchPrompt(
    request.objective ?? '',
    request.focusAreas,
    fileSources,
    urls,
  );

  const id = randomBytes(8).toString('hex');
  const title = request.title?.trim().length
    ? request.title.trim()
    : 'Planning research: Claude Code + Codex';
  const taskType = 'planning_research';

  createLocalLlmTask(
    id,
    taskType,
    prompt,
    title,
    request.priority,
    request.model,
    request.numCtx,
    request.maxTokens,
    request.createdBy,
  );

  return {
    taskId: id,
    taskType,
    title,
    sourceCount: fileSources.length,
  };
}
