// npm run demo:rbac — both levels of authorization through the real API (in this
// process, on a random port), with users, a product and an order made for this run:
//
// anon=401 own=200 foreign=403 role-denied=403 role-allowed=201 tampered=401
//
//   anon, own, foreign  GET /orders/:id of Alice's order: no token, Alice, Bob
//   role-denied         Alice (a customer) POST /products
//   role-allowed        the seller POST /products: it creates the product the order uses
//   tampered            Alice's access token with role → admin, the old signature,
//                       sent to POST /products: the signature check rejects it first
//
// The order is written straight to the database (OrdersRepository), not through
// checkout: no stock, balance, outbox event or rate-limit counter involved, so
// nothing outlives the run and a rerun measures the same thing.
import { OrdersRepository } from '../orders/orders.repository.js';
import { startApi } from './api.js';
import { type DemoUser, fixtures, http } from './auth-kit.js';
import { log, migrate, runDemo, SetupError, statusContract } from './lib.js';

const PRICE_CENTS = 1_000;

// The brief's tampered token: the payload's role changed, header and signature kept.
const withRoleAdmin = (token: string): string => {
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  return [header, Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url'), signature].join('.');
};

await runDemo('demo:rbac', async (onCleanup) => {
  const admin = await migrate(onCleanup);
  const own = await fixtures(admin, onCleanup);
  const [alice, bob, seller] = [await own.user('customer'), await own.user('customer'), await own.user('seller')];
  const { url } = await startApi(onCleanup);
  const call = http(url);
  const { step, held } = statusContract();
  log(`alice ${alice.id}, bob ${bob.id}, seller ${seller.id}`);

  const tokenOf = async (user: DemoUser): Promise<string> => {
    const login = await call('POST', '/auth/login', { body: { email: user.email, password: user.password } });
    if (login.status !== 200) throw new SetupError(`login of user ${user.id} answered ${login.status}`);
    return String(login.body.accessToken);
  };
  const [aliceToken, bobToken, sellerToken] = [await tokenOf(alice), await tokenOf(bob), await tokenOf(seller)];

  // Every product write: whatever it creates (the seller's, or one a broken check let
  // through) is deleted at the end.
  const newProduct = { title: 'demo:rbac product', price_cents: PRICE_CENTS, stock: 1 };
  const writeProduct = async (token: string) => {
    const reply = await call('POST', '/products', { token, body: newProduct });
    if (reply.status === 201) own.ownProduct(String(reply.body.id));
    return reply;
  };

  // The seller's write first: it makes the product the order needs (printed in the
  // contract's order below).
  const created = await writeProduct(sellerToken);
  const productId = created.status === 201 ? String(created.body.id) : undefined;

  let orderId = '0';
  if (productId) {
    const order = await new OrdersRepository(admin.manager).insert({
      userId: alice.id,
      status: 'paid',
      totalCents: String(PRICE_CENTS),
      items: [{ productId, quantity: 1, unitPriceCents: String(PRICE_CENTS), productName: newProduct.title }],
    });
    orderId = order.id;
    log(`product ${productId}, alice's order ${orderId}`);
  }

  step('anon', (await call('GET', `/orders/${orderId}`)).status, 401);
  step('own', (await call('GET', `/orders/${orderId}`, { token: aliceToken })).status, 200);
  step('foreign', (await call('GET', `/orders/${orderId}`, { token: bobToken })).status, 403);
  step('role-denied', (await writeProduct(aliceToken)).status, 403);
  step('role-allowed', created.status, 200, 201);
  step('tampered', (await writeProduct(withRoleAdmin(aliceToken))).status, 401);

  return held();
});
