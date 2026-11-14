import { appendFile } from 'node:fs/promises';

export interface JobSummary {
  title: string;
  status: 'success' | 'failure';
  rows: ReadonlyArray<readonly [label: string, value: string | number]>;
  notes?: readonly string[];
}

export type SummaryWriteResult = 'written' | 'skipped' | 'failed';

export interface SummaryWriteOptions {
  env?: NodeJS.ProcessEnv;
  append?: (path: string, data: string) => Promise<void>;
}

function escapeMarkdown(value: string | number): string {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\|<>`]/g, (character) => `\\${character}`);
}

export function renderJobSummary(summary: JobSummary): string {
  const lines = [
    `## ${escapeMarkdown(summary.title)}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Status | ${summary.status === 'success' ? 'Succeeded' : 'Failed'} |`,
    ...summary.rows.map(([label, value]) => `| ${escapeMarkdown(label)} | ${escapeMarkdown(value)} |`),
  ];
  for (const note of summary.notes ?? []) {
    lines.push('', escapeMarkdown(note));
  }
  return `${lines.join('\n')}\n`;
}

/** Appends a summary to GITHUB_STEP_SUMMARY. Does nothing outside GitHub Actions and never throws. */
export async function writeJobSummary(
  summary: JobSummary,
  options: SummaryWriteOptions = {},
): Promise<SummaryWriteResult> {
  const path = (options.env ?? process.env).GITHUB_STEP_SUMMARY;
  if (!path) {
    return 'skipped';
  }
  try {
    await (options.append ?? ((file, data) => appendFile(file, data, 'utf8')))(path, renderJobSummary(summary));
    return 'written';
  } catch {
    return 'failed';
  }
}
