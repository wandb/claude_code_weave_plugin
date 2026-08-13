// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ATTR } from '../src/genaiSpans.ts';
import { flushWeave, initWeaveInMemory, makeGenaiDaemon } from './helpers.ts';

const SUMMARY = 'The user asked for a refactor; we edited three files and ran the suite.';

function transcript(t: TestContext, sessionId: string): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.weave-compaction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: 'user', message: { role: 'user', content: 'go' },
  }) + '\n');
  return file;
}

test('PostCompact records the compaction summary on the turn', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'compaction-summary';
  const file = transcript(t, sessionId);
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: file };

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', ...base, source: 'startup', cwd: '/x',
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', ...base, prompt: 'go', prompt_id: 'p1',
  });
  // Exactly the SDK payloads: PreCompact knows no summary yet, PostCompact does.
  await daemon.routeEvent({
    hook_event_name: 'PreCompact', ...base, prompt_id: 'p1',
    trigger: 'auto', custom_instructions: null,
  });
  await daemon.routeEvent({
    hook_event_name: 'PostCompact', ...base, prompt_id: 'p1',
    trigger: 'auto', compact_summary: SUMMARY,
  });
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base, prompt_id: 'p1' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await flushWeave();

  const turns = exporter.getFinishedSpans()
    .filter(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
  console.log('  compaction summary on turns:',
    turns.map(s => s.attributes[ATTR.COMPACTION_SUMMARY]));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].attributes[ATTR.COMPACTION_SUMMARY], SUMMARY);
});

test('a PostCompact before any turn attaches to the next one', async (t) => {
  const exporter = await initWeaveInMemory();
  exporter.reset();
  const sessionId = 'compaction-buffered';
  const file = transcript(t, sessionId);
  const daemon = makeGenaiDaemon();
  const base = { session_id: sessionId, transcript_path: file };

  await daemon.routeEvent({
    hook_event_name: 'SessionStart', ...base, source: 'startup', cwd: '/x',
  });
  // Auto-compaction can land between turns, with no open turn to attach to.
  await daemon.routeEvent({
    hook_event_name: 'PostCompact', ...base, trigger: 'auto', compact_summary: SUMMARY,
  });
  await daemon.routeEvent({
    hook_event_name: 'UserPromptSubmit', ...base, prompt: 'go', prompt_id: 'p1',
  });
  await daemon.routeEvent({ hook_event_name: 'Stop', ...base, prompt_id: 'p1' });
  await daemon.routeEvent({ hook_event_name: 'SessionEnd', ...base, reason: 'clear' });
  await flushWeave();

  const turns = exporter.getFinishedSpans()
    .filter(s => s.attributes[ATTR.OPERATION_NAME] === 'invoke_agent');
  console.log('  buffered summary on turns:',
    turns.map(s => s.attributes[ATTR.COMPACTION_SUMMARY]));
  assert.equal(turns[0]?.attributes[ATTR.COMPACTION_SUMMARY], SUMMARY);
});

test('the plugin forwards PostCompact hooks to the daemon', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'),
  ) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  const commands = manifest.hooks?.['PostCompact']
    ?.flatMap(group => group.hooks ?? [])
    .map(hook => hook.command);

  assert.ok(commands?.some(command => command?.includes('/hooks/hook-handler.sh')));
});
