// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Only failures are observable: the SDK owns the exporter, so nothing signals success. Per process.
export type ExportErrorSnapshot = {
  code: string | null;
  message: string;
  at: string;
  count: number;
};

/** Null for anything that is not an export rejection; `diag` also carries unrelated OTel internals. */
export function parseExportError(raw: string): { code: string | null; message: string } | null {
  if (!raw.includes('OTLPExporterError')) return null;
  const code = /"code"\s*:\s*"?(\d{3})"?/.exec(raw)?.[1] ?? null;
  const message =
    /"message"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ??
    /OTLPExporterError:\s*([^\n"\\]+)/.exec(raw)?.[1]?.trim() ??
    'export rejected';
  return { code, message };
}

export class ExportHealth {
  private last: ExportErrorSnapshot | null = null;

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
