// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

// Sockets live under /tmp (macOS 104-char path cap); see stale-daemon-socket.test.ts.

import { test, suite, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ExportHealth, parseExportError } from '../src/exportHealth.ts';
import { Daemon } from '../src/daemon.ts';
import { requestFromSocket } from '../src/utils.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const EXPORT_ROW = /⚠ Export\s+/;
const STRIP = ['WEAVE_PROJECT', 'WANDB_API_KEY', 'WEAVE_AGENT_NAME', 'WANDB_BASE_URL', 'WEAVE_CLAUDE_DEBUG'];

// Verbatim daemon.log payloads from a real run against an inaccessible project.
const DIAG_403 =
  'otel: {"stack":"OTLPExporterError: Forbidden\\n    at IncomingMessage.<anonymous> (/x/http-transport-utils.js:62:31)","message":"Forbidden","name":"OTLPExporterError","code":"403"}';
const DIAG_401 =
  'otel: {"stack":"OTLPExporterError: Unauthorized\\n    at IncomingMessage.<anonymous> (/x/http-transport-utils.js:62:31)","message":"Unauthorized","name":"OTLPExporterError","code":"401"}';
const FLUSH_ERROR = 'Error flushing Weave SDK: OTLPExporterError: Forbidden';
const UNRELATED_DIAG = 'otel: Accessing resource attributes before async attributes settled';

let scratch: string;
before(() => { scratch = fs.mkdtempSync('/tmp/wcp-export-'); });
after(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

function writeSettings(home: string): { socketPath: string } {
  const dir = path.join(home, '.weave-claude-code');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const socketPath = path.join(dir, 'daemon.sock');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    log_file: path.join(dir, 'logs', 'daemon.log'),
    daemon_socket: socketPath,
    weave_project: 'fake-entity/fake-project',
    wandb_api_key: 'fake-api-key',
    agent_name: 'goobers',
    debug: false,
    installed_at: '2026-01-01T00:00:00Z',
    version: '0.0.0-test',
  }, null, 2));
  return { socketPath };
}

function runStatus(home: string, args: string[] = []): Promise<{ stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const k of STRIP) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'status', ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.on('error', reject);
    child.on('exit', () => resolve({ stdout }));
  });
}

// Stand-in daemon replying to the `config-hash` control request with a caller-supplied payload.
async function fakeDaemon(socketPath: string, reply: Record<string, unknown>): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', () => { /* request body ignored */ });
    socket.on('end', () => { socket.end(JSON.stringify(reply)); });
    socket.on('error', () => { /* client may hang up */ });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
suite('parseExportError', () => {
  test('pulls status code and message out of the exporter payload shapes', () => {
    assert.deepEqual(parseExportError(DIAG_403), { code: '403', message: 'Forbidden' });
    assert.deepEqual(parseExportError(DIAG_401), { code: '401', message: 'Unauthorized' });
    // Flush path logs the Error directly, so there is no JSON code to read.
    assert.deepEqual(parseExportError(FLUSH_ERROR), { code: null, message: 'Forbidden' });
  });

  test('ignores diag output that is not an export rejection', () => {
    assert.equal(parseExportError(UNRELATED_DIAG), null);
    assert.equal(parseExportError('otel: BatchSpanProcessor queue is full'), null);
    assert.equal(parseExportError(''), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('ExportHealth', () => {
  test('keeps the newest rejection and counts every one', () => {
    const health = new ExportHealth();
    assert.equal(health.snapshot(), null);

    health.record(DIAG_403);
    health.record(DIAG_403);
    health.record(DIAG_401);

    const snap = health.snapshot();
    assert.ok(snap);
    assert.equal(snap.code, '401');
    assert.equal(snap.message, 'Unauthorized');
    assert.equal(snap.count, 3);
    assert.match(snap.at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('stays empty when only unrelated diag output arrives', () => {
    const health = new ExportHealth();
    health.record(UNRELATED_DIAG);
    assert.equal(health.snapshot(), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('daemon control reply', () => {
  test('reports the last rejected export on config-hash', async () => {
    const socketPath = path.join(fs.mkdtempSync('/tmp/wcp-eh-sock-'), 'd.sock');
    const logFile = path.join(os.tmpdir(), `wcp-eh-${process.pid}.log`);
    const daemon = new Daemon(socketPath, logFile, {
      weaveProject: 'e/p', apiKey: 'k', baseUrl: 'https://x', agentName: 'a', debug: false,
    });
    (daemon as unknown as { exportHealth: ExportHealth }).exportHealth.record(DIAG_403);
    await (daemon as unknown as { listenOnce(): Promise<void> }).listenOnce();
    try {
      const reply = await requestFromSocket(socketPath, JSON.stringify({ command: 'config-hash' }));
      const parsed = JSON.parse(reply) as Record<string, unknown>;
      const err = parsed['last_export_error'] as Record<string, unknown>;
      assert.ok(err, `expected last_export_error in reply: ${reply}`);
      assert.equal(err['code'], '403');
      assert.equal(err['count'], 1);
    } finally {
      await (daemon as unknown as { drain(reason: string): Promise<void> }).drain('test');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
suite('status export row', () => {
  test('warns with the code, count and remediation when exports are rejected', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'failing-'));
    const { socketPath } = writeSettings(home);
    const server = await fakeDaemon(socketPath, {
      config_hash: 'whatever',
      last_export_error: { code: '403', message: 'Forbidden', at: '2026-08-10T19:31:32.651Z', count: 12 },
    });
    try {
      const pretty = await runStatus(home);
      assert.match(pretty.stdout, EXPORT_ROW);
      assert.match(pretty.stdout, /403 Forbidden \(12x, last 19:31:32\)/);
      // A 403 is an access problem, so name the project that is not writable.
      assert.match(pretty.stdout, /no write access to fake-entity\/fake-project/);

      const json = JSON.parse((await runStatus(home, ['--json'])).stdout) as Record<string, unknown>;
      const err = json['last_export_error'] as Record<string, unknown>;
      assert.equal(err['code'], '403');
      assert.equal(err['count'], 12);
      // Additive only: a rejected export must not flip the documented readiness field.
      assert.equal(json['ready_to_trace'], true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('points at the key when the export is unauthorized', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'unauth-'));
    const { socketPath } = writeSettings(home);
    const server = await fakeDaemon(socketPath, {
      config_hash: 'whatever',
      last_export_error: { code: '401', message: 'Unauthorized', at: '2026-08-10T19:31:32.651Z', count: 3 },
    });
    try {
      const pretty = await runStatus(home);
      assert.match(pretty.stdout, /401 Unauthorized \(3x, last 19:31:32\)/);
      assert.match(pretty.stdout, /verify wandb_api_key/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('shows no export row for a healthy daemon or one too old to report', async () => {
    const healthy = fs.mkdtempSync(path.join(scratch, 'healthy-'));
    let { socketPath } = writeSettings(healthy);
    let server = await fakeDaemon(socketPath, { config_hash: 'x', last_export_error: null });
    try {
      const pretty = await runStatus(healthy);
      assert.doesNotMatch(pretty.stdout, EXPORT_ROW);
      const json = JSON.parse((await runStatus(healthy, ['--json'])).stdout) as Record<string, unknown>;
      assert.equal(json['last_export_error'], null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    // Daemon predating this field: absent is unknown, not healthy, and must not throw.
    const old = fs.mkdtempSync(path.join(scratch, 'old-'));
    ({ socketPath } = writeSettings(old));
    server = await fakeDaemon(socketPath, { config_hash: 'x' });
    try {
      const pretty = await runStatus(old);
      assert.doesNotMatch(pretty.stdout, EXPORT_ROW);
      assert.match(pretty.stdout, /Daemon\s+● alive/);
      const json = JSON.parse((await runStatus(old, ['--json'])).stdout) as Record<string, unknown>;
      assert.equal(json['last_export_error'], null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
