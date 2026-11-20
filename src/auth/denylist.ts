// Access tokens that must stop working before their exp. A JWT is self-contained:
// nothing stored can stop it, so the guard asks here after verifying the signature.
// Two kinds of entry, each with a TTL that ends when the tokens it covers would have
// expired anyway, so the list never grows:
//   deny:jti:<jti>  one access token (logout): TTL = exp − now, rounded up;
//   deny:sid:<sid>  every access token of a login, i.e. a refresh family (logout,
//                   reuse detection): TTL = the access-token lifetime, the longest
//                   any of them can still live.
// Redis errors are thrown: the caller decides (the guard fails closed).
import type { Redis } from 'ioredis';
import { ACCESS_TOKEN_TTL_SECONDS } from './tokens.js';

const jtiKey = (jti: string) => `deny:jti:${jti}`;
const sidKey = (sid: string) => `deny:sid:${sid}`;

export class TokenDenylist {
  constructor(private readonly redis: Redis) {}

  // Nothing to do for a token that has already expired: it can't be used anyway.
  async denyToken(jti: string, exp: number, now = new Date()): Promise<void> {
    const ttl = Math.ceil(exp - now.getTime() / 1000);
    if (ttl > 0) await this.redis.set(jtiKey(jti), '1', 'EX', ttl);
  }

  async denySession(sid: string): Promise<void> {
    await this.redis.set(sidKey(sid), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS);
  }

  // One round trip for both keys.
  async isDenied({ jti, sid }: { jti: string; sid: string }): Promise<boolean> {
    return (await this.redis.exists(jtiKey(jti), sidKey(sid))) > 0;
  }
}
