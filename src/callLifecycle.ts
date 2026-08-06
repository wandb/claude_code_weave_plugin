// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import type { Tool } from 'weave';
import { ATTR, jsonStr } from './genaiSpans.js';
import type { TurnTrace } from './session.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = Record<string, JsonValue>;

export type ToolCall = {
  toolUseId: string;
  name: string;
  input: JsonObject;
};

export type ToolResult =
  | { ok: true; output: JsonValue }
  | { ok: false; error: string };

type OpenTool = {
  span: Tool;
  turn: TurnTrace;
  toolUseId: string;
};

/** Owns the exact hook identities for ordinary tools in one session. */
export class ToolLifecycle {
  private readonly openById = new Map<string, OpenTool>();
  private readonly openIdsByTurn = new Map<TurnTrace, Set<string>>();
  private readonly tombstones = new Set<string>();

  start(turn: TurnTrace, call: ToolCall): boolean {
    return Boolean(this.open(turn, call));
  }

  private open(turn: TurnTrace, call: ToolCall): OpenTool | undefined {
    if (this.openById.has(call.toolUseId) || this.tombstones.has(call.toolUseId)) {
      return undefined;
    }

    const span = turn.span.startTool({
      name: call.name,
      args: jsonStr(call.input),
      toolCallId: call.toolUseId,
    });
    const open = { span, turn, toolUseId: call.toolUseId };
    const openIds = this.openIdsByTurn.get(turn) ?? new Set<string>();
    openIds.add(call.toolUseId);
    this.openIdsByTurn.set(turn, openIds);
    this.openById.set(call.toolUseId, open);
    return open;
  }

  /** A terminal hook may be the first hook observed after a daemon restart. */
  finishOrRecover(
    turn: () => TurnTrace,
    call: ToolCall,
    result: ToolResult,
  ): boolean {
    if (this.tombstones.has(call.toolUseId)) return false;
    const open = this.openById.get(call.toolUseId) ?? this.open(turn(), call);
    if (!open) return false;

    if (result.ok) {
      open.span.result = jsonStr(result.output);
      open.span.end();
    } else {
      const error = result.error;
      open.span.result = error;
      open.span.setAttributes({ [ATTR.ERROR_TYPE]: errorType(error) });
      open.span.end({ error: new Error(error) });
    }
    this.complete(call.toolUseId, open);
    return true;
  }

  /** End every unfinished child before its owning turn. */
  finalizeChildren(turn: TurnTrace, reason: string): string[] {
    const closed: string[] = [];
    for (const toolUseId of [...(this.openIdsByTurn.get(turn) ?? [])].reverse()) {
      const open = this.openById.get(toolUseId);
      if (!open) continue;
      open.span.setAttributes({ [ATTR.WEAVE_ORPHAN_REASON]: reason });
      open.span.end({ error: new Error(`call did not complete (${reason})`) });
      this.complete(toolUseId, open);
      closed.push(toolUseId);
    }
    return closed;
  }

  hasOpenTools(turn?: TurnTrace): boolean {
    return turn
      ? Boolean(this.openIdsByTurn.get(turn)?.size)
      : this.openById.size > 0;
  }

  private complete(toolUseId: string, open: OpenTool): void {
    const openIds = this.openIdsByTurn.get(open.turn);
    openIds?.delete(toolUseId);
    if (openIds?.size === 0) this.openIdsByTurn.delete(open.turn);
    this.openById.delete(toolUseId);
    this.tombstones.add(toolUseId);
  }
}

function errorType(error: string): string {
  return error.trim().match(/^[A-Z][A-Za-z_]*Error/)?.[0] ?? 'tool_error';
}
