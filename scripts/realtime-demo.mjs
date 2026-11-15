// Socket.IO room isolation, end to end (HW#18).
//
//   node scripts/realtime-demo.mjs               A=1, B=0: B is in another order's room
//   node scripts/realtime-demo.mjs --same-room   A=1, B=1: the control run, B is in A's room
//
// Each run creates two fresh orders (A and B) for one seeded user, connects two clients
// as that user, joins A to order A's room and B to order B's room (or A's with
// --same-room), changes A's status over HTTP and reports who received it.
//
// stdout: exactly A_RECEIVED=0|1 and B_RECEIVED=0|1. Progress and errors: stderr.
// Exit codes: 0 = as expected, 1 = not as expected (the result lines are printed),
// 2 = setup failed, so no verdict (app down, refused connect or join, no ack, a
// failed checkout or PATCH, the deadline; no result lines).
//
// Config (env): DEMO_BASE_URL (default http://localhost:3000), DEMO_USER_ID (default 1,
// a seeded user with a large balance).

import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const BASE_URL = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';
const USER_ID = Number(process.env.DEMO_USER_ID ?? 1);
const SAME_ROOM = process.argv.includes('--same-room');

const REQUEST_TIMEOUT_MS = 3_000; // each HTTP request, connect and join ack
const WAIT_FOR_A_MS = 3_000; // A should get the event well within this
const GRACE_MS = 300; // after A's event: B gets it in the same server tick, if at all
const DEADLINE_MS = 15_000; // the whole run, whatever happens

class SetupError extends Error {}

const log = (message) => process.stderr.write(`[demo] ${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sockets = [];
let deadline;

// Every path ends here: sockets closed, timers cleared, output flushed, then exit.
function finish(code, lines = []) {
  clearTimeout(deadline);
  for (const socket of sockets) socket.disconnect();
  const output = lines.length ? `${lines.join('\n')}\n` : '';
  process.stdout.write(output, () => process.exit(code));
}

async function http(method, path, { body, headers } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SetupError(
      `${method} ${path}: ${error.cause?.code ?? error.message} (is the app running at ${BASE_URL}?)`,
    );
  }
  return {
    status: response.status,
    data: await response.json().catch(() => null),
  };
}

// Reconnection off: a retrying client keeps Node alive and proves nothing here.
// The server refuses a bad handshake in middleware, so connect_error is final.
function connect(label) {
  const socket = io(`${BASE_URL}/orders`, {
    auth: { userId: USER_ID },
    forceNew: true,
    reconnection: false,
    timeout: REQUEST_TIMEOUT_MS,
  });
  sockets.push(socket);
  // Listening from the start, so nothing that arrives before the ack is missed.
  socket.events = [];
  socket.on('order.status', (event) => socket.events.push(event));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) =>
      reject(
        new SetupError(`client ${label}: connect_error "${error.message}"`),
      ),
    );
  });
}

// The cheapest product still in stock: the seed doesn't restore stock, so a fixed
// product id would run out after enough runs.
async function pickProduct() {
  const { status, data } = await http('GET', '/products');
  if (status !== 200 || !Array.isArray(data))
    throw new SetupError(`GET /products → ${status}`);
  const product = data
    .filter((p) => p.in_stock)
    .sort((a, b) => a.price_cents - b.price_cents)[0];
  if (!product)
    throw new SetupError('no product in stock; re-seed the database');
  return product.id;
}

// A fresh order starts as `paid`, so every run has a legal paid → processing.
async function createOrder(productId) {
  const { status, data } = await http('POST', '/orders', {
    headers: { 'idempotency-key': randomUUID() },
    body: { user_id: USER_ID, items: [{ product_id: productId, quantity: 1 }] },
  });
  if (status !== 201)
    throw new SetupError(
      `checkout → ${status}: ${data?.detail ?? JSON.stringify(data)}`,
    );
  return data.id;
}

async function join(socket, label, orderId) {
  let ack;
  try {
    ack = await socket
      .timeout(REQUEST_TIMEOUT_MS)
      .emitWithAck('join', { orderId });
  } catch {
    throw new SetupError(
      `client ${label}: no ack for join ${orderId} within ${REQUEST_TIMEOUT_MS} ms`,
    );
  }
  if (!ack?.ok)
    throw new SetupError(
      `client ${label}: join ${orderId} refused: ${JSON.stringify(ack)}`,
    );
  return ack;
}

// Received = an order.status for order A newer than what this client's join ack
// already covered. Only order A counts: nothing else is changed during the run, and
// an event for another order says nothing about A's room.
const receivedA = (socket, ack, orderA) =>
  socket.events.some(
    (event) => event.orderId === orderA && event.eventId > ack.lastEventId,
  )
    ? 1
    : 0;

async function run() {
  const [clientA, clientB] = await Promise.all([connect('A'), connect('B')]);
  log(`connected as user ${USER_ID}`);

  const productId = await pickProduct();
  const orderA = await createOrder(productId);
  const orderB = await createOrder(productId);
  log(`orders A=${orderA}, B=${orderB}`);

  // The flag changes B's room and B's expected value; nothing else.
  const roomForB = SAME_ROOM ? orderA : orderB;
  const expectedB = SAME_ROOM ? 1 : 0;

  // Both acks before the PATCH: until then the clients may not be in their rooms.
  const [ackA, ackB] = await Promise.all([
    join(clientA, 'A', orderA),
    join(clientB, 'B', roomForB),
  ]);
  log(`joined: A → order ${orderA}, B → order ${roomForB}`);

  const patch = await http('PATCH', `/orders/${orderA}/status`, {
    body: { status: 'processing' },
  });
  if (patch.status !== 200)
    throw new SetupError(
      `PATCH order ${orderA} → ${patch.status}: ${patch.data?.detail ?? ''}`,
    );
  log(`order ${orderA}: paid → processing`);

  // Wait for A (or give up after WAIT_FOR_A_MS), then a short grace period for B.
  for (
    let waited = 0;
    waited < WAIT_FOR_A_MS && !receivedA(clientA, ackA, orderA);
    waited += 50
  ) {
    await sleep(50);
  }
  await sleep(GRACE_MS);

  const a = receivedA(clientA, ackA, orderA);
  const b = receivedA(clientB, ackB, orderA);
  const ok = a === 1 && b === expectedB;
  if (!ok) log(`expected A_RECEIVED=1, B_RECEIVED=${expectedB}`);
  finish(ok ? 0 : 1, [`A_RECEIVED=${a}`, `B_RECEIVED=${b}`]);
}

deadline = setTimeout(() => {
  log(`no result within ${DEADLINE_MS} ms`);
  finish(2);
}, DEADLINE_MS);

run().catch((error) => {
  log(
    error instanceof SetupError
      ? `setup failed: ${error.message}`
      : `unexpected error: ${error.stack}`,
  );
  finish(2);
});
