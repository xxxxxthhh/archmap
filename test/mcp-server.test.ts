/**
 * M4-4: the stdio MCP query server and its CLI parity.
 *
 * Every assertion runs against the **freshly compiled** server (`dist/cli/bin.js mcp`) spawned
 * as a real subprocess and driven over raw JSON-RPC — not the SDK client — so malformed frames,
 * EOF, and interrupted sessions are exercised the way a hostile or buggy client would.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toCanonicalJson } from '../src/model/canonical.js';
import { paths } from '../src/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'dist', 'cli', 'bin.js');
const FIXTURE = join(ROOT, 'fixtures', 'mixed-repo');

const TOOL_NAMES = [
  'project_summary',
  'context_for_files',
  'impact_analysis',
  'search_architecture',
  'get_node',
  'get_evidence',
  'list_stale_nodes',
  'get_update_work_items',
  'propose_update',
  'validate_proposal',
  'apply_proposal',
];

interface JsonRpcResponse {
  id?: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

/** A live server subprocess driven over raw JSON-RPC lines. */
class Session {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();
  private buffer = '';
  private nextId = 0;
  readonly stderr: string[] = [];
  readonly exited: Promise<number | null>;

  constructor(cwd: string) {
    this.proc = spawn(process.execPath, [BIN, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.exited = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i !== -1; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as JsonRpcResponse;
      const resolve = message.id === undefined ? undefined : this.pending.get(message.id);
      if (resolve && message.id !== undefined) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  /** Write a raw line, bypassing framing — used to feed the server garbage. */
  writeRaw(line: string): void {
    this.proc.stdin.write(`${line}\n`);
  }

  request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = (this.nextId += 1);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Complete the MCP handshake, as any conforming client must before calling a tool. */
  async initialize(): Promise<JsonRpcResponse> {
    const res = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'archmap-test', version: '0' },
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return res;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    return this.request('tools/call', { name, arguments: args });
  }

  /** The canonical payload text a successful tool call answered with. */
  async payloadText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.call(name, args);
    expect(res.error, `${name} returned a protocol error`).toBeUndefined();
    expect(res.result?.isError, `${name} returned a tool error: ${res.result?.content?.[0]?.text}`).toBeFalsy();
    return res.result!.content![0]!.text;
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** End the input stream (EOF) and wait for the process to exit. */
  async end(): Promise<number | null> {
    this.proc.stdin.end();
    return this.exited;
  }

  async kill(): Promise<void> {
    this.proc.kill('SIGKILL');
    await this.exited;
  }
}

function cli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function git(args: string[], cwd: string): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

/** A CLI JSON report with only its transport/command envelope removed. */
function domainOf(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  delete parsed.schema_version;
  delete parsed.command;
  return parsed;
}

/**
 * The domain payload of a CLI JSON command, in canonical form. This is the exact text the
 * matching MCP tool must answer with.
 */
function cliPayload(args: string[], cwd: string): string {
  return toCanonicalJson(domainOf(cli([...args, '--json'], cwd).stdout));
}

/** `project_summary` parity: the canonical semantic union of `status` and `capabilities`. */
function cliSummary(cwd: string): string {
  return toCanonicalJson({
    ...domainOf(cli(['status', '--json'], cwd).stdout),
    ...domainOf(cli(['capabilities', '--json'], cwd).stdout),
  });
}

/** `list_stale_nodes` parity: the stale-node projection of `status`. */
function cliStaleNodes(cwd: string): string {
  const status = domainOf(cli(['status', '--json'], cwd).stdout) as { stale_nodes: string[] };
  return toCanonicalJson({ stale_nodes: status.stale_nodes });
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-mcp-')));
  cpSync(FIXTURE, dir, { recursive: true });
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'mixed fixture'], dir);
  return dir;
}

/** Every byte under `.archmap`, for proving the read-only sweep wrote nothing. */
function archmapBytes(repo: string): Array<[string, string]> {
  const root = paths.dir(repo);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  return files.sort().map((path) => [relative(root, path), readFileSync(path).toString('base64')]);
}

let repo: string;
const sessions: Session[] = [];

function open(cwd: string): Session {
  const session = new Session(cwd);
  sessions.push(session);
  return session;
}

beforeAll(() => {
  // The contract is on the shipped artifact, so every test below runs the freshly compiled bin.
  const build = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
}, 180_000);

beforeEach(() => {
  repo = makeRepo();
  expect(cli(['init'], repo).status).toBe(0);
  expect(cli(['scan'], repo).status).toBe(0);
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.kill()));
  rmSync(repo, { recursive: true, force: true });
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('mcp server: CLI parity', () => {
  it('exposes exactly the contracted tool surface', async () => {
    const session = open(repo);
    const info = await session.initialize();
    expect(info.result).toMatchObject({ serverInfo: { name: 'archmap' } });

    const tools = await session.request('tools/list', {});
    expect(tools.result!.tools!.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  }, 30_000);

  it('does not advertise the write-capable MCP surface as read-only in --help', () => {
    // The served surface now includes the guarded `apply_proposal` write, so the top-level help
    // must not describe `archmap mcp` as read-only.
    const help = cli(['--help'], repo);
    expect(help.status).toBe(0);
    const mcpLine = help.stdout.split('\n').find((line) => /^\s*mcp\s/.test(line));
    expect(mcpLine, 'help must list the mcp command').toBeDefined();
    expect(mcpLine).not.toMatch(/read-only/i);
    expect(mcpLine!.toLowerCase()).toContain('proposal');
  }, 30_000);

  it('answers every tool with its CLI command payload, byte for byte', async () => {
    const session = open(repo);
    await session.initialize();

    // Real ids from the tracked model: a node, and a claim carried by one.
    const matches = (JSON.parse(cli(['search', 'pipeline', '--json'], repo).stdout) as {
      matches: Array<{ node: { id: string; claims: Array<{ id: string }> } }>;
    }).matches.map((match) => match.node);
    const node = matches[0]!;
    const claimId = matches.find((candidate) => candidate.claims.length > 0)!.claims[0]!.id;

    const cases: Array<[string, Record<string, unknown>, string[]]> = [
      ['context_for_files', { paths: ['pipeline/api.py'] }, ['context', 'pipeline/api.py']],
      ['impact_analysis', { paths: ['pipeline/api.py', 'pipeline/models.py'] }, ['impact', 'pipeline/api.py', 'pipeline/models.py']],
      ['search_architecture', { query: 'pipeline' }, ['search', 'pipeline']],
      ['get_node', { id: node.id }, ['node', node.id]],
      ['get_evidence', { id: node.id }, ['evidence', node.id]],
      ['get_evidence', { id: claimId }, ['evidence', claimId]],
      ['get_update_work_items', {}, ['work-items']],
    ];
    for (const [tool, args, command] of cases) {
      expect(await session.payloadText(tool, args), `${tool} vs \`archmap ${command.join(' ')}\``).toBe(
        cliPayload(command, repo),
      );
    }

    expect(await session.payloadText('project_summary')).toBe(cliSummary(repo));
    expect(await session.payloadText('list_stale_nodes')).toBe(cliStaleNodes(repo));
  }, 60_000);

  it('matches CLI found/not-found domain payloads for unknown ids and misses', async () => {
    const session = open(repo);
    await session.initialize();

    for (const [tool, command] of [
      ['get_node', 'node'],
      ['get_evidence', 'evidence'],
    ] as const) {
      const cliRes = cli([command, 'no_such_id', '--json'], repo);
      expect(cliRes.status, `${command} miss must exit 1`).toBe(1);
      expect(await session.payloadText(tool, { id: 'no_such_id' })).toBe(cliPayload([command, 'no_such_id'], repo));
    }

    const miss = cli(['search', 'definitely-absent-xyz', '--json'], repo);
    expect(miss.status).toBe(1);
    expect(await session.payloadText('search_architecture', { query: 'definitely-absent-xyz' })).toBe(
      cliPayload(['search', 'definitely-absent-xyz'], repo),
    );
    expect(JSON.parse(miss.stdout)).toMatchObject({ found: false, matches: [] });
  }, 30_000);

  it('keeps parity on a dirty tree with stale nodes', async () => {
    writeFileSync(join(repo, 'pipeline', 'api.py'), 'def added_endpoint():\n    return 1\n');
    const session = open(repo);
    await session.initialize();

    const status = domainOf(cli(['status', '--json'], repo).stdout) as { clean: boolean; stale_nodes: string[] };
    expect(status.clean).toBe(false);
    expect(status.stale_nodes.length).toBeGreaterThan(0);

    expect(await session.payloadText('list_stale_nodes')).toBe(cliStaleNodes(repo));
    expect(await session.payloadText('get_update_work_items')).toBe(cliPayload(['work-items'], repo));
    expect(await session.payloadText('project_summary')).toBe(cliSummary(repo));
  }, 30_000);

  it('passes the context budget through unchanged, with equal omitted accounting', async () => {
    const session = open(repo);
    await session.initialize();

    for (const budget of [1, 50, 2000]) {
      const text = await session.payloadText('context_for_files', { paths: ['pipeline/api.py'], budget });
      expect(text).toBe(cliPayload(['context', 'pipeline/api.py', '--budget', String(budget)], repo));
      const payload = JSON.parse(text) as { budget: number; used_tokens: number; omitted: unknown[] };
      expect(payload.budget).toBe(budget);
      expect(payload.used_tokens).toBeLessThanOrEqual(budget);
    }
    // The default must be the CLI default, not a transport-specific one.
    expect(await session.payloadText('context_for_files', { paths: ['pipeline/api.py'] })).toBe(
      cliPayload(['context', 'pipeline/api.py'], repo),
    );
    const tight = JSON.parse(await session.payloadText('context_for_files', { paths: ['pipeline/api.py'], budget: 1 })) as {
      omitted: unknown[];
    };
    expect(tight.omitted.length).toBeGreaterThan(0);
  }, 60_000);

  it('returns stable payloads across repeated calls', async () => {
    const session = open(repo);
    await session.initialize();
    for (const [tool, args] of [
      ['project_summary', {}],
      ['search_architecture', { query: 'pipeline' }],
      ['get_update_work_items', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const first = await session.payloadText(tool, args);
      expect(await session.payloadText(tool, args)).toBe(first);
    }
  }, 30_000);
});

describe('mcp server: fail-closed and input rejection', () => {
  it('fails closed with a structured tool error on unscanned and corrupt models', async () => {
    const unscanned = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-mcp-bare-')));
    git(['init'], unscanned);
    expect(cli(['init'], unscanned).status).toBe(0);

    const bare = open(unscanned);
    await bare.initialize();
    for (const tool of TOOL_NAMES) {
      const args = tool === 'context_for_files' || tool === 'impact_analysis'
        ? { paths: ['a.ts'] }
        : tool === 'search_architecture'
          ? { query: 'x' }
          : tool === 'get_node' || tool === 'get_evidence'
            ? { id: 'x' }
            : tool === 'propose_update'
              ? { operations: [{}] }
              : tool === 'validate_proposal' || tool === 'apply_proposal'
                ? { proposal: {} }
                : {};
      const res = await bare.call(tool, args);
      expect(res.result?.isError, `${tool} must fail closed on an unscanned project`).toBe(true);
      expect(JSON.parse(res.result!.content![0]!.text)).toEqual({
        schema_version: 1,
        error: 'not scanned yet; run `archmap scan` first',
      });
    }
    rmSync(unscanned, { recursive: true, force: true });

    // A corrupt tracked model is refused by both surfaces, with the same message.
    const nodeFile = join(paths.nodesDir(repo), readdirSync(paths.nodesDir(repo))[0]!);
    writeFileSync(nodeFile, readFileSync(nodeFile, 'utf8').replace('schema_version: 1', 'schema_version: 2'));
    const corrupt = open(repo);
    await corrupt.initialize();
    const res = await corrupt.call('project_summary');
    expect(res.result?.isError).toBe(true);
    const error = (JSON.parse(res.result!.content![0]!.text) as { error: string }).error;
    expect(error).toContain('unsupported node document schema_version');
    expect(JSON.parse(cli(['search', 'pipeline', '--json'], repo).stderr).error).toBe(error);
  }, 60_000);

  it('rejects missing, extra, wrong-type, out-of-range, blank, and escaping arguments', async () => {
    const session = open(repo);
    await session.initialize();

    const rejected: Array<[string, Record<string, unknown>]> = [
      ['context_for_files', {}], // missing required
      ['context_for_files', { paths: ['pipeline/api.py'], extra: true }], // extra property
      ['context_for_files', { paths: 'pipeline/api.py' }], // wrong type
      ['context_for_files', { paths: [] }], // empty path list
      ['context_for_files', { paths: ['pipeline/api.py'], budget: 0 }], // out of range
      ['context_for_files', { paths: ['pipeline/api.py'], budget: 1.5 }], // non-integer budget
      ['context_for_files', { paths: ['../escape.py'] }], // escapes the repository
      ['impact_analysis', { paths: [join(tmpdir(), 'outside.py')] }], // absolute, outside
      ['search_architecture', { query: '   ' }], // blank query
      ['get_node', { id: 42 }], // wrong type
      ['project_summary', { unexpected: 1 }], // no-argument tool
      ['no_such_tool', {}], // unknown tool
    ];
    for (const [tool, args] of rejected) {
      const res = await session.call(tool, args);
      expect(res.error?.code, `${tool} ${JSON.stringify(args)} must be rejected`).toBe(-32602);
      expect(res.result).toBeUndefined();
    }

    // Rejection is deterministic: the same bad input yields the same error every time.
    const first = await session.call('context_for_files', { paths: [] });
    const second = await session.call('context_for_files', { paths: [] });
    expect(second.error).toEqual(first.error);

    // And the session is still fully usable afterwards.
    expect(await session.payloadText('list_stale_nodes')).toBe(cliStaleNodes(repo));
  }, 60_000);

  it('survives malformed JSON-RPC, EOF, and an interrupted request', async () => {
    const session = open(repo);
    await session.initialize();

    session.writeRaw('{ this is not json');
    session.writeRaw(JSON.stringify({ jsonrpc: '2.0' })); // valid JSON, invalid JSON-RPC
    session.writeRaw('');
    const missingMethod = await session.request('no/such/method', {});
    expect(missingMethod.error?.code).toBe(-32601);

    // Still serving, and still correct, after every one of those.
    const tools = await session.request('tools/list', {});
    expect(tools.result!.tools).toHaveLength(TOOL_NAMES.length);
    expect(await session.payloadText('project_summary')).toBe(cliSummary(repo));
    expect(session.stderr.join('')).toBe('');
    expect(await session.end()).toBe(0);

    // An interrupted request (EOF mid-flight) neither hangs nor poisons the next session.
    const interrupted = open(repo);
    await interrupted.initialize();
    void interrupted.call('get_update_work_items');
    expect(await interrupted.end()).toBe(0);

    const next = open(repo);
    await next.initialize();
    expect(await next.payloadText('project_summary')).toBe(cliSummary(repo));
    expect(await next.end()).toBe(0);
  }, 60_000);
});

describe('mcp server: read-only process boundary', () => {
  it('observes an externally completed scan without a restart', async () => {
    const session = open(repo);
    await session.initialize();
    expect(JSON.parse(await session.payloadText('list_stale_nodes'))).toEqual({ stale_nodes: [] });

    writeFileSync(join(repo, 'pipeline', 'api.py'), 'def added_endpoint():\n    return 1\n');
    const stale = JSON.parse(await session.payloadText('list_stale_nodes')) as { stale_nodes: string[] };
    expect(stale.stale_nodes.length).toBeGreaterThan(0);

    // Another process rescans; the running server must answer from the new baseline.
    git(['add', '-A'], repo);
    git(['commit', '-m', 'external change'], repo);
    expect(cli(['scan'], repo).status).toBe(0);

    expect(JSON.parse(await session.payloadText('list_stale_nodes'))).toEqual({ stale_nodes: [] });
    expect(await session.payloadText('get_update_work_items')).toBe(cliPayload(['work-items'], repo));
  }, 60_000);

  it('writes nothing and opens no listening socket during a full tool sweep', async () => {
    const before = archmapBytes(repo);
    const beforeStatus = git(['status', '--porcelain'], repo);

    const session = open(repo);
    await session.initialize();

    await session.payloadText('project_summary');
    await session.payloadText('context_for_files', { paths: ['pipeline/api.py'], budget: 500 });
    await session.payloadText('impact_analysis', { paths: ['pipeline/api.py'] });
    await session.payloadText('search_architecture', { query: 'pipeline' });
    await session.payloadText('get_node', { id: 'no_such_id' });
    await session.payloadText('get_evidence', { id: 'no_such_id' });
    await session.payloadText('list_stale_nodes');
    await session.payloadText('get_update_work_items');

    // stdio only: the server process must hold no listening socket, loopback or otherwise.
    const listening = spawnSync('lsof', ['-a', '-p', String(session.pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
      encoding: 'utf8',
    });
    expect(listening.error, 'lsof is required to prove no listener is opened').toBeUndefined();
    expect(listening.stdout.trim()).toBe('');

    expect(await session.end()).toBe(0);
    expect(archmapBytes(repo)).toEqual(before);
    expect(git(['status', '--porcelain'], repo)).toBe(beforeStatus);
  }, 60_000);
});
