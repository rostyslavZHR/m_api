// npm run demo:auth — the token lifecycle through the real API (in this process, on a
// random port), for a user made for this run:
//
// login=200 no-token=401 with-token=200 refresh=200 logout=204 after-logout=401
// refresh-after-logout=401
//
// Logout uses the access token from the refresh (A2); after-logout checks that A2,
// refresh-after-logout the newest refresh token (R2). Tokens are never printed.
import { startApi } from './api.js';
import { fixtures, http } from './auth-kit.js';
import { log, migrate, runDemo, SetupError, statusContract } from './lib.js';

interface Pair {
  accessToken: string;
  refreshToken: string;
}

await runDemo('demo:auth', async (onCleanup) => {
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
  const first = login.body as unknown as Pair;
  own.ownToken(first.accessToken);

  step('no-token', (await call('GET', '/auth/me')).status, 401);
  step('with-token', (await call('GET', '/auth/me', { token: first.accessToken })).status, 200);

  const refresh = await call('POST', '/auth/refresh', { body: { refreshToken: first.refreshToken } });
  step('refresh', refresh.status, 200);
  if (refresh.status !== 200) throw new SetupError(`refresh answered ${refresh.status}: no A2 to log out with`);
  const second = refresh.body as unknown as Pair;
  own.ownToken(second.accessToken);

  step('logout', (await call('POST', '/auth/logout', { token: second.accessToken })).status, 200, 204);
  step('after-logout', (await call('GET', '/auth/me', { token: second.accessToken })).status, 401);
  step('refresh-after-logout', (await call('POST', '/auth/refresh', { body: { refreshToken: second.refreshToken } })).status, 401);

  return held();
});
