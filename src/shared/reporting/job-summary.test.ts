import assert from 'node:assert/strict';
import test from 'node:test';
import { renderJobSummary, writeJobSummary, type JobSummary } from './job-summary.ts';

const summary: JobSummary = {
  title: 'S3 copy',
  status: 'success',
  rows: [['Source bucket', 'a|b'], ['Objects copied', 3]],
  notes: ['Encryption verification: not performed.'],
};

test('renders a markdown table and escapes cell content', () => {
  const text = renderJobSummary(summary);
  assert.match(text, /\| Status \| Succeeded \|/);
  assert.match(text, /\| Source bucket \| a\\\|b \|/);
  assert.match(text, /\| Objects copied \| 3 \|/);
  assert.match(text, /not performed/);
});

test('skips outside GitHub Actions and never throws on write errors', async () => {
  assert.equal(await writeJobSummary(summary, { env: {} }), 'skipped');
  const written: string[] = [];
  assert.equal(await writeJobSummary(summary, {
    env: { GITHUB_STEP_SUMMARY: '/tmp/s' },
    append: async (path, data) => { written.push(path, data); },
  }), 'written');
  assert.equal(written[0], '/tmp/s');
  assert.equal(await writeJobSummary(summary, {
    env: { GITHUB_STEP_SUMMARY: '/tmp/s' },
    append: async () => { throw new Error('disk'); },
  }), 'failed');
});
