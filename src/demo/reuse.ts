// npm run demo:reuse — refresh-token reuse detection through the real API (in this
// process, on a random port), for a user made for this run:
//
// login=200 r1-refresh=200 r1-reuse=401 r2-after-reuse=401
//
// R1 is refreshed (giving R2), then presented again: that's a reuse, so the whole
// family is revoked, and R2, the one the legitimate client holds, stops working too.
import { startApi } from './api.js';
import { fixtures, http } from './auth-kit.js';
import { log, migrate, runDemo, SetupError, statusContract } from './lib.js';

interface Pair {
  accessToken: string;
  refreshToken: string;
}

await runDemo('demo:reuse', async (onCleanup) => {
  const admin = await migrate(onCleanup);
  const own = await fixtures(admin, onCleanup);
  const user = await own.user('customer');
  const { url } = await startApi(onCleanup);
  const call = http(url);
  const { step, held } = statusContract();
  log(`user ${user.id}`);

  const login = await call('POST', '/auth/login', { body: { email: user.email, password: user.password } });
  step('login', login.status, 200);
  if (login.status !== 200) throw new SetupError(`login answered ${login.status}: nothing else to check`);
  const r1 = (login.body as unknown as Pair).refreshToken;
  // Its sid: the reuse denylists the family's access tokens, removed at the end.
  own.ownToken((login.body as unknown as Pair).accessToken);

  const rotated = await call('POST', '/auth/refresh', { body: { refreshToken: r1 } });
  step('r1-refresh', rotated.status, 200);
  if (rotated.status !== 200) throw new SetupError(`the first refresh answered ${rotated.status}: no R2`);
  const r2 = (rotated.body as unknown as Pair).refreshToken;

  step('r1-reuse', (await call('POST', '/auth/refresh', { body: { refreshToken: r1 } })).status, 401);
  step('r2-after-reuse', (await call('POST', '/auth/refresh', { body: { refreshToken: r2 } })).status, 401);

  return held();
});
