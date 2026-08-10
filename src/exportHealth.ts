// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

/**
 * Tracks OTLP exports the trace server rejected. The daemon can capture hooks
 * and log happily while every span is dropped (a rotated API key, a project the
 * key cannot write), so `status` needs a signal for it.
 *
 * Only failures are observable: OTel surfaces exporter problems through the
 * `diag` logger and the Weave SDK owns the exporter, so there is no success
 * callback to clear this state with. Counts are per daemon process.
 */
export type ExportErrorSnapshot = {
  /** HTTP status from the exporter payload, null when it did not carry one. */
  code: string | null;
  message: string;
  /** ISO timestamp of the most recent rejection. */
  at: string;
  /** Rejections since this daemon started. */
  count: number;
};

/**
 * Pull the status code and reason out of an exporter failure line. Returns null
 * for anything that is not an export rejection, since `diag` also carries
 * unrelated OTel internals that must not read as dropped spans.
 */
export function parseExportError(raw: string): { code: string | null; message: string } | null {
  if (!raw.includes('OTLPExporterError')) return null;
  const code = /"code"\s*:\s*"?(\d{3})"?/.exec(raw)?.[1] ?? null;
  // The JSON payload carries `message`; the flush path logs the Error itself.
  const message =
    /"message"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ??
    /OTLPExporterError:\s*([^\n"\\]+)/.exec(raw)?.[1]?.trim() ??
    'export rejected';
  return { code, message };
}

export class ExportHealth {
  private last: ExportErrorSnapshot | null = null;

  /** Record a candidate failure line; non-export input is ignored. */
  record(raw: string): void {
    const parsed = parseExportError(raw);
    if (!parsed) return;
    this.last = {
      ...parsed,
      at: new Date().toISOString(),
      count: (this.last?.count ?? 0) + 1,
    };
  }

  snapshot(): ExportErrorSnapshot | null {
    return this.last;
  }
}
