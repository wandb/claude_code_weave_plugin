// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import * as fs from 'fs';
import * as path from 'path';
import type {
  HookInput,
  InstructionsLoadedHookInput,
  PreToolUseHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import * as weave from 'weave';
import type {
  JsonObject,
  JsonValue,
  ToolCall,
  ToolResult,
} from './callLifecycle.js';
import type { CompactionAttrs } from './genaiSpans.js';
import { snippet } from './genaiSpans.js';
import { Session } from './session.js';
import { TranscriptFile } from './transcriptFile.js';

type TraceLog = (level: 'DEBUG' | 'INFO' | 'ERROR', message: string) => void;

type HookInputFor<Event extends HookInput['hook_event_name']> = Extract<
  HookInput,
  { hook_event_name: Event }
>;
type PostToolResultHookInput = HookInputFor<'PostToolUse' | 'PostToolUseFailure'>;

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : isJsonObject(value);
    default:
      return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null)
    && Object.values(value).every(isJsonValue);
}

function parseHookInput(payload: unknown): HookInput | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const input = payload as Record<string, unknown>;
  return typeof input['hook_event_name'] === 'string'
    && typeof input['session_id'] === 'string'
    ? input as HookInput
    : undefined;
}

export class HookHandler {
  private readonly sessions = new Map<string, Session>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  /** InstructionsLoaded can arrive before SessionStart. */
  private readonly pendingInstructions = new Map<string, Map<string, string>>();

  constructor(
    private readonly agentName: string,
    private readonly log: TraceLog,
  ) {}

  async handle(payload: unknown): Promise<void> {
    const input = parseHookInput(payload);
    if (!input) {
      this.log('ERROR', 'Invalid hook payload');
      return;
    }

    const sessionId = input.session_id;
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.route(input));
    this.sessionQueues.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.sessionQueues.get(sessionId) === next) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  private async route(input: HookInput): Promise<void> {
    const sessionId = input.session_id;
    this.log(
      'INFO',
      `${input.hook_event_name} session=${sessionId}${input.agent_id ? ` agent=${input.agent_id}` : ''}`,
    );
    try {
      await weave.runIsolated(() => this.dispatchEvent(input));
    } catch (err) {
      this.log('ERROR', `Error handling ${input.hook_event_name}: ${err}`);
    }
  }

  private async dispatchEvent(input: HookInput): Promise<void> {
    const sessionId = input.session_id;
    switch (input.hook_event_name) {
      case 'SessionStart':
        await this.handleSessionStart(sessionId, input);
        return;
      case 'InstructionsLoaded':
        this.handleInstructionsLoaded(sessionId, input);
        return;
      case 'UserPromptSubmit':
        await this.handleUserPromptSubmit(sessionId, input);
        return;
      case 'PreToolUse':
        await this.handlePreToolUse(sessionId, input);
        return;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        await this.handlePostToolResult(sessionId, input);
        return;
      case 'PreCompact':
        this.handlePreCompact(sessionId, input);
        return;
      case 'Stop':
        await this.handleStop(sessionId, input);
        return;
      case 'SessionEnd':
        await this.handleSessionEnd(sessionId, input);
        return;
      default:
        return;
    }
  }

  private async createSession(
    sessionId: string,
    transcript: TranscriptFile,
    options: { source: string; cwd: string; initialRequestModel?: string },
  ): Promise<Session> {
    const session = await Session.create({
      sessionId,
      transcript,
      cwd: options.cwd,
      source: options.source,
      initialRequestModel: options.initialRequestModel,
      agentName: this.agentName,
      log: this.log,
    });
    this.sessions.set(sessionId, session);
    this.drainPendingInstructions(session);
    return session;
  }

  private async handleSessionStart(
    sessionId: string,
    input: SessionStartHookInput,
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return;

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(input.transcript_path);
    } catch (err) {
      this.log('ERROR', `Invalid transcript_path for session ${sessionId}: ${err}`);
      return;
    }

    const session = await this.createSession(sessionId, transcript, {
      source: input.source,
      cwd: input.cwd,
      initialRequestModel: input.model,
    });
    const resumed = session.conversationId !== sessionId;
    this.log(
      'INFO',
      `Session created: ${sessionId}${resumed ? ` (resumed; conversation=${session.conversationId})` : ''}`,
    );
    this.log(
      'DEBUG',
      `SessionStart details: session=${sessionId} conversation=${session.conversationId} source=${session.source} model=${session.initialRequestModel ?? 'unknown'} cwd=${session.cwd || '(empty)'} transcript_path=${session.transcriptPath} transcript_file=${path.basename(session.transcriptPath)} active_sessions=${this.sessions.size}`,
    );
  }

  private async getOrReconstructSession(
    sessionId: string,
    input: HookInput,
  ): Promise<Session | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    if (!input.transcript_path) return undefined;

    let transcript: TranscriptFile;
    try {
      transcript = new TranscriptFile(input.transcript_path);
    } catch (err) {
      this.log('ERROR', `Cannot reconstruct session ${sessionId}: invalid transcript_path: ${err}`);
      return undefined;
    }

    const raw = input as Record<string, unknown>;
    const session = await this.createSession(sessionId, transcript, {
      source: raw['source'] as string | undefined ?? 'reconstructed',
      cwd: input.cwd,
      initialRequestModel: raw['model'] as string | undefined,
    });
    this.log(
      'INFO',
      `Session reconstructed after restart: ${sessionId} (conversation=${session.conversationId})`,
    );
    return session;
  }

  private handleInstructionsLoaded(
    sessionId: string,
    input: InstructionsLoadedHookInput,
  ): void {
    let content: string;
    try {
      content = fs.readFileSync(input.file_path, 'utf8');
    } catch (err) {
      this.log('DEBUG', `InstructionsLoaded: unreadable ${input.file_path}: ${err}`);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.setInstruction(input.file_path, content);
    } else {
      const pending = this.pendingInstructions.get(sessionId) ?? new Map();
      pending.set(input.file_path, content);
      this.pendingInstructions.set(sessionId, pending);
    }
    this.log(
      'DEBUG',
      `InstructionsLoaded: session=${sessionId} reason=${input.load_reason} file=${path.basename(input.file_path)} bytes=${content.length}${session ? '' : ' (buffered)'}`,
    );
  }

  private drainPendingInstructions(session: Session): void {
    const pending = this.pendingInstructions.get(session.sessionId);
    this.pendingInstructions.delete(session.sessionId);
    if (!pending) return;
    for (const [filePath, content] of pending) {
      session.setInstruction(filePath, content);
    }
    this.log(
      'DEBUG',
      `Drained ${pending.size} buffered instruction file(s) into session ${session.sessionId}`,
    );
  }

  private async handleUserPromptSubmit(
    sessionId: string,
    input: UserPromptSubmitHookInput,
  ): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) {
      this.log('ERROR', `Unknown session (no transcript_path to reconstruct): ${sessionId}`);
      return;
    }

    const result = session.submitPrompt(input.prompt_id, input.prompt);
    if (!result.created) return;
    this.log(
      'DEBUG',
      `UserPromptSubmit: session=${sessionId} current_turn=${result.replacedOpenTurn ? 'open' : 'none'} prompt=${snippet(input.prompt, 120)}`,
    );
    this.log('INFO', 'Created turn span');
  }

  private handlePreCompact(sessionId: string, input: PreCompactHookInput): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Claude Code sends compaction fields that are absent from the SDK type.
    const raw = input as Record<string, unknown>;
    const attrs: CompactionAttrs = {
      summary: (raw['summary'] ?? raw['compaction_summary']) as string | undefined,
      itemsBefore: raw['items_before'] as number | undefined,
      itemsAfter: raw['items_after'] as number | undefined,
    };
    if (session.setCompaction(input.prompt_id, attrs)) {
      this.log('INFO', `PreCompact attached to active turn (session ${sessionId})`);
    } else {
      this.log('INFO', `PreCompact buffered; will attach to next turn (session ${sessionId})`);
    }
  }

  private async handlePreToolUse(
    sessionId: string,
    input: PreToolUseHookInput,
  ): Promise<void> {
    if (input.tool_name === 'Agent' || input.agent_id) return;
    const call = this.toolCall(input);
    if (!call) return;
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;
    session.startTool(input.prompt_id, call);
  }

  private async handlePostToolResult(
    sessionId: string,
    input: PostToolResultHookInput,
  ): Promise<void> {
    if (input.tool_name === 'Agent' || input.agent_id) return;
    const call = this.toolCall(input);
    const result = this.toolResult(input);
    if (!call || !result) return;
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;
    session.finishTool(input.prompt_id, call, result);
  }

  private toolCall(
    input: Pick<PreToolUseHookInput, 'tool_use_id' | 'tool_name' | 'tool_input'>,
  ): ToolCall | undefined {
    if (
      typeof input.tool_use_id !== 'string'
      || typeof input.tool_name !== 'string'
      || !isJsonObject(input.tool_input)
    ) {
      this.log('ERROR', 'Invalid tool hook payload');
      return undefined;
    }
    return {
      toolUseId: input.tool_use_id,
      name: input.tool_name,
      input: input.tool_input,
    };
  }

  private toolResult(input: PostToolResultHookInput): ToolResult | undefined {
    if (input.hook_event_name === 'PostToolUse') {
      if (!isJsonValue(input.tool_response)) {
        this.log('ERROR', 'Invalid tool result payload');
        return undefined;
      }
      return { ok: true, output: input.tool_response };
    }
    if (typeof input.error !== 'string') {
      this.log('ERROR', 'Invalid tool result payload');
      return undefined;
    }
    return { ok: false, error: input.error };
  }

  private async handleStop(sessionId: string, input: StopHookInput): Promise<void> {
    const session = await this.getOrReconstructSession(sessionId, input);
    if (!session) return;

    const snapshot = await session.snapshotStop(
      input.prompt_id,
      input.last_assistant_message,
    );
    this.log(
      'DEBUG',
      `Stop: session=${sessionId} transcript_path=${session.transcriptPath} responses=${snapshot.responseCount} model=${snapshot.model ?? 'unknown'} last_assistant_message_present=${Boolean(input.last_assistant_message)}`,
    );
    this.log('INFO', 'Recorded turn stop snapshot');
  }

  private async handleSessionEnd(
    sessionId: string,
    input: SessionEndHookInput,
  ): Promise<void> {
    this.pendingInstructions.delete(sessionId);
    const session = this.sessions.get(sessionId)
      ?? await this.getOrReconstructSession(sessionId, input);
    if (!session) return;

    const turnCount = session.finishAtSessionEnd(input.prompt_id);
    this.log(
      'DEBUG',
      `SessionEnd: session=${sessionId} reason=${input.reason} transcript_path=${session.transcriptPath} turns=${turnCount}`,
    );
    this.sessions.delete(sessionId);
    session.close();
    this.log('INFO', `Finished session ${sessionId}`);
  }

  hasInFlightWork(): boolean {
    for (const session of this.sessions.values()) {
      if (session.hasInFlightWork()) return true;
    }
    return false;
  }

  finalizeForShutdown(): void {
    for (const session of this.sessions.values()) {
      try {
        session.finishOpenTurns('daemon_shutdown');
      } catch (err) {
        this.log('ERROR', `Error finalizing session ${session.sessionId} at shutdown: ${err}`);
      }
    }
  }

  closeTranscripts(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
  }
}
