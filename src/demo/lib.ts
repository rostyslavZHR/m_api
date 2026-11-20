// Shared by the demos: the HW#22 messaging ones (outbox, crash-write, crash-relay,
// dlq) and the HW#23 Redis ones (cache, session, ratelimit, queue).
//
// stdout carries only the result lines, exactly key=value, for the grader's
// `grep -qx`. Everything else (progress, failed checks, the consumer's logs) goes
// to stderr.
//
// Exit codes: 0 every check held; 1 a check failed (the result lines are printed
// first); 2 setup failed (broker or DB unreachable, no stock, the overall deadline).
import { type ChildProcess, spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { type ChannelModel, type ConfirmChannel, connect } from 'amqplib';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { createSchemaDataSource } from '../schema-data-source.js';
import type { ConsumerLine } from '../consumer/report.js';
import { bootstrapRabbitMQ } from '../messaging/bootstrap.js';
import {
  DEAD_LETTER_QUEUE,
  INVOICING_QUEUE,
  UNROUTED_QUEUE,
} from '../messaging/topology.js';

// Well above a normal run (~4 s), and above the inner waits added up (ready 10 s +
// settle 10 s + depth reads), so a slow machine fails a check, not the deadline.
const DEADLINE_MS = 60_000;
const CLEANUP_GRACE_MS = 5_000;
const CONSUMER_ENTRY = fileURLToPath(
  new URL('../consumer/main.js', import.meta.url),
);
const RELAY_ENTRY = fileURLToPath(new URL('../relay/main.js', import.meta.url));

export const log = (message: string) => console.error(`[demo] ${message}`);

// A failure before there is anything to measure: exit 2, no result lines.
export class SetupError extends Error {}

// One line for any failure: the policy script's stderr, or the error's message; a
// refused connection to a host with two addresses (::1, 127.0.0.1) is an
// AggregateError with an empty message, so its first inner error stands in.
const describe = (error: unknown): string => {
  const { stderr, errors, message } = error as {
    stderr?: string;
    errors?: Error[];
    message?: string;
  };
  return stderr?.trim() || message || errors?.[0]?.message || String(error);
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new SetupError(
      `${name} is not set: run through scripts/with-secrets.sh, or export it with SKIP_VAULT=1`,
    );
  }
  return value;
};

// Every consumer child, so none outlives the demo: a leftover one would keep
// consuming and skew the next demo's counts.
const children = new Set<ChildProcess>();
const killChildren = () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
};
process.on('exit', killChildren);

// --- result lines and checks -------------------------------------------------

// Synchronous, like the consumer's lines: the demo ends with process.exit(), which
// doesn't wait for an asynchronous write to a pipe.
export const printResults = (results: [string, string | number][]) => {
  for (const [key, value] of results) writeSync(1, `${key}=${value}\n`);
};

export const checker = () => {
  const failures: string[] = [];
  return {
    // Arrow functions, so the demos can destructure them.
    check: (label: string, ok: boolean) => {
      log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
      if (!ok) failures.push(label);
    },
    passed: () => failures.length === 0,
  };
};

// HTTP status contracts (the HW#24 demos): each step prints key=status at once, and a
// status outside the expected ones is named on stderr (INVARIANT key: expected …,
// got …). `held()` is false if any step broke its invariant.
export const statusContract = () => {
  const broken: string[] = [];
  return {
    step: (key: string, status: number, ...expected: number[]) => {
      printResults([[key, status]]);
      if (!expected.includes(status)) {
        broken.push(key);
        writeSync(2, `INVARIANT ${key}: expected ${expected.join(' or ')}, got ${status}\n`);
      }
    },
    held: () => broken.length === 0,
  };
};

// Runs one demo: the overall deadline, exit codes, and cleanup whatever happens,
// Ctrl+C and SIGTERM included (exit 130 / 143 after the cleanup). `demo` returns
// whether its checks held, and registers through `onCleanup` what it opened, to be
// closed in reverse order.
export async function runDemo(
  name: string,
  demo: (onCleanup: (fn: () => Promise<void>) => void) => Promise<boolean>,
): Promise<never> {
  const started = Date.now();
  const cleanups: (() => Promise<void>)[] = [];
  // Once, whoever asks first (the normal end or a signal).
  let cleaning: Promise<void> | undefined;
  const cleanUp = () =>
    (cleaning ??= (async () => {
      killChildren();
      for (const cleanup of [...cleanups].reverse()) {
        await cleanup().catch(() => {});
      }
    })());
  // Off the normal path (the deadline, a signal): clean up, but never wait more than
  // CLEANUP_GRACE_MS for it, so a hanging cleanup can't keep the process alive.
  const abort = (code: number) => {
    setTimeout(() => process.exit(code), CLEANUP_GRACE_MS).unref();
    void cleanUp().then(() => process.exit(code));
  };
  const deadline = setTimeout(() => {
    log(`${name}: no result within ${DEADLINE_MS / 1000} s, giving up`);
    abort(2);
  }, DEADLINE_MS);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      log(`${name}: ${signal}, cleaning up`);
      clearTimeout(deadline);
      abort(code);
    });
  }

  let code: number;
  try {
    code = (await demo((fn) => cleanups.push(fn))) ? 0 : 1;
    log(`${name}: ${code === 0 ? 'passed' : 'FAILED'} in ${Date.now() - started} ms`);
  } catch (error) {
    log(`${name}: setup failed: ${describe(error)}`);
    code = 2;
  }
  clearTimeout(deadline);
  await cleanUp();
  process.exit(code);
}

// --- the broker ----------------------------------------------------------------

export interface Broker {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

// The reset: policies and topology (the grader never runs the bootstrap on its own),
// then all three queues emptied, so a message left by an earlier run can't be
// counted. Returns a connection for publishing and reading depths.
export async function resetBroker(url: string): Promise<Broker> {
  await bootstrapRabbitMQ(url);
  const connection = await connect(url, { timeout: 5_000 });
  connection.on('error', (error: Error) =>
    log(`broker connection error: ${error.message}`),
  );
  const channel = await connection.createConfirmChannel();
  channel.on('error', (error: Error) =>
    log(`broker channel error: ${error.message}`),
  );
  for (const queue of [INVOICING_QUEUE, DEAD_LETTER_QUEUE, UNROUTED_QUEUE]) {
    await channel.purgeQueue(queue);
  }
  return { connection, channel };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// checkQueue counts *ready* messages only: call it after the consumer has stopped,
// so nothing is unacked. The count itself is current, but dead-lettering moves a
// message to the DLQ asynchronously, so one read right after an action can be
// stale. This polls until the value hasn't changed for STABLE_MS, up to WAIT_MS,
// and returns the last value read either way.
const POLL_MS = 200;
const STABLE_MS = 1_000;
const WAIT_MS = 10_000;

export async function settledDepth(
  channel: ConfirmChannel,
  queue: string,
): Promise<number> {
  const until = Date.now() + WAIT_MS;
  let value = (await channel.checkQueue(queue)).messageCount;
  let since = Date.now();
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const next = (await channel.checkQueue(queue)).messageCount;
    if (next !== value) {
      value = next;
      since = Date.now();
    } else if (Date.now() - since >= STABLE_MS) {
      return value;
    }
  }
  log(`${queue}: depth still changing after ${WAIT_MS} ms, using ${value}`);
  return value;
}

// Polls until the queue holds at least `count` ready messages, up to WAIT_MS.
export async function waitForDepth(
  channel: ConfirmChannel,
  queue: string,
  count: number,
): Promise<boolean> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    if ((await channel.checkQueue(queue)).messageCount >= count) return true;
    await sleep(POLL_MS);
  }
  return false;
}

// --- the consumer as a child process ---------------------------------------------

export interface Consumer {
  // Every JSON line it has printed so far.
  lines: ConsumerLine[];
  // Resolves true once `done(lines)` holds; false on timeout or if the child exits.
  waitFor(done: (lines: ConsumerLine[]) => boolean, ms: number): Promise<boolean>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  // SIGTERM (the consumer's graceful stop), then SIGKILL if it hangs.
  stop(): Promise<void>;
}

// The real consumer (dist/consumer/main.js), with this process's environment.
// `crashAfterEffect` sets its demo-only kill switch.
export function startConsumer({ crashAfterEffect = false } = {}): Consumer {
  const env = { ...process.env };
  if (crashAfterEffect) env.CONSUMER_CRASH_AFTER_EFFECT = '1';
  else delete env.CONSUMER_CRASH_AFTER_EFFECT;

  const child = spawn(process.execPath, [CONSUMER_ENTRY], {
    env,
    // Its stderr (logs) straight to ours; its stdout (JSON lines) to the parser.
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.add(child);

  const lines: ConsumerLine[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  createInterface({ input: child.stdout! }).on('line', (text) => {
    try {
      lines.push(JSON.parse(text) as ConsumerLine);
    } catch {
      log(`consumer printed a non-JSON line: ${text}`);
      return;
    }
    notify();
  });

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.on('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
      notify();
    }),
  );

  const isRunning = () => child.exitCode === null && child.signalCode === null;

  const waitFor = (done: (lines: ConsumerLine[]) => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      const finish = (result: boolean) => {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(result);
      };
      const check = () => {
        if (done(lines)) finish(true);
        else if (!isRunning()) finish(false);
      };
      const timer = setTimeout(() => finish(false), ms);
      listeners.add(check);
      check();
    });

  const stop = async () => {
    if (!isRunning()) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };

  return { lines, waitFor, exited, stop };
}

export const linesOf = <E extends ConsumerLine['event']>(
  lines: ConsumerLine[],
  event: E,
) => lines.filter((line): line is Extract<ConsumerLine, { event: E }> => line.event === event);

// --- HW#22: the relay as a child process, setup, polling ----------------------

export interface Relay {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  // SIGTERM (finishes its batch), then SIGKILL if it hangs.
  stop(): Promise<void>;
}

// The real relay (dist/relay/main.js), with this process's environment.
// `crashAfterConfirm` sets its demo-only kill switch (both variables it needs). Its
// stdout (the publisher's Nest logger) goes to our stderr, so stdout keeps only the
// result lines.
export function startRelay({ crashAfterConfirm = false } = {}): Relay {
  const env = { ...process.env };
  delete env.RELAY_CRASH_AFTER_CONFIRM;
  delete env.DEMO_RUN;
  if (crashAfterConfirm) {
    env.RELAY_CRASH_AFTER_CONFIRM = '1';
    env.DEMO_RUN = '1';
  }

  const child = spawn(process.execPath, [RELAY_ENTRY], {
    env,
    stdio: ['ignore', 2, 'inherit'],
  });
  children.add(child);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.on('exit', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    }),
  );
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };
  return { exited, stop };
}

// What every HW#22 demo needs on a fresh stack (the grader starts with only docker
// compose): the schema (pending migrations, as the schema owner; a no-op when
// they've run), then the broker's policies and topology, then empty queues.
// Returns the schema owner's DataSource too (demo:crash-write creates a trigger with
// it; app_user can't).
export async function prepare(
  onCleanup: (fn: () => Promise<void>) => void,
): Promise<{ broker: Broker; admin: DataSource }> {
  const admin = await migrate(onCleanup);
  const broker = await resetBroker(requireEnv('RABBITMQ_URL'));
  onCleanup(() => broker.connection.close());
  return { broker, admin };
}

// The schema on a fresh stack: pending migrations, as the schema owner (a no-op when
// they've run). Returns the schema owner's DataSource.
export async function migrate(onCleanup: (fn: () => Promise<void>) => void): Promise<DataSource> {
  const admin = createSchemaDataSource(requireEnv('MIGRATIONS_DB_URL'));
  await admin.initialize();
  onCleanup(() => admin.destroy());
  const ran = await admin.runMigrations({ transaction: 'each' });
  log(`migrations: ${ran.length === 0 ? 'up to date' : `${ran.length} applied`}`);
  return admin;
}

// The app's Redis clients fail fast and send nothing before the connection is up:
// wait for it, or fail the setup (exit 2) instead of measuring a dead Redis.
export async function connected(client: Redis, ms = 5_000): Promise<Redis> {
  if (client.status === 'ready') return client;
  const ready = await Promise.race([
    new Promise<boolean>((resolve) => client.once('ready', () => resolve(true))),
    sleep(ms).then(() => false),
  ]);
  if (!ready) throw new SetupError(`Redis (${client.options.connectionName}) not reachable within ${ms / 1000} s`);
  return client;
}

// The keys matching a pattern, by SCAN (never KEYS, which blocks Redis while it
// walks the whole keyspace).
export async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  for await (const keys of redis.scanStream({ match: pattern, count: 1_000 })) found.push(...(keys as string[]));
  return found;
}

// Deletes them in batches (UNLINK frees the memory in the background).
export async function deleteMatching(redis: Redis, pattern: string): Promise<number> {
  let deleted = 0;
  for await (const keys of redis.scanStream({ match: pattern, count: 1_000 })) {
    if ((keys as string[]).length > 0) deleted += await redis.unlink(...(keys as string[]));
  }
  return deleted;
}

// Polls `check` every 200 ms until it returns true, up to `ms`. false on timeout.
export async function waitUntil(
  check: () => Promise<boolean> | boolean,
  ms: number,
): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(POLL_MS);
  }
  return check();
}
