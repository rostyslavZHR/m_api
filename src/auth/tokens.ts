// The two tokens a login issues.
//
// Access token: an ES256 JWT, short-lived, verified by signature alone (nothing is
// stored server-side). Header: alg + kid (the verifier reads the kid from the
// header to pick the key). Claims: sub, jti, iat, exp in SECONDS since the epoch
// (Date.now() is milliseconds: a token that lives for millennia), role, and sid:
// the refresh family it was issued for (OIDC's session id), so logout and reuse
// detection can cut off every access token of that login (the denylist).
//
// Refresh token: 32 random bytes, opaque (not a JWT), long-lived. Only its HMAC is
// stored: HMAC-SHA256 with the pepper is deterministic, so a presented token is found
// by recomputing its hash (an indexed lookup), and a dump of the table holds no
// usable token. Not a slow hash (Argon2, bcrypt, scrypt): those exist for guessable
// passwords, and their per-row salt would make "find the row by hash" impossible.
import { createHmac, type KeyObject, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, type JWTHeaderParameters, SignJWT } from 'jose';
import { USER_ROLES, type UserRole } from '../entities/index.js';
import { JWT_ALG } from '../config/jwt-keys.js';

// 10 minutes: the window in which a stolen access token works, and in which a role
// change doesn't reach the token (the role claim is a cache).
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;
// 14 days without logging in again (Phase C rotates the token on every refresh).
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

// Who issued the token and for whom: checked on verification, so a token from
// another issuer, or meant for another API, signed with a shared key, is refused.
export const JWT_ISSUER = 'm_api';
export const JWT_AUDIENCE = 'm_api';

export interface SigningKey {
  privateKey: KeyObject;
  kid: string;
}

export async function signAccessToken(
  { privateKey, kid }: SigningKey,
  user: { id: string; role: UserRole },
  sid: string,
  now = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ role: user.role, sid })
    .setProtectedHeader({ alg: JWT_ALG, kid, typ: 'JWT' })
    .setSubject(String(user.id))
    .setJti(randomUUID())
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_TTL_SECONDS)
    .sign(privateKey);
}

// 256 bits from the OS's CSPRNG: unguessable, so a fast keyed hash is enough.
export const newRefreshToken = (): string => randomBytes(32).toString('base64url');

export const hashRefreshToken = (pepper: string, token: string): string =>
  createHmac('sha256', pepper).update(token).digest('hex');

// --- verification -----------------------------------------------------------

// The public keys the API accepts, by kid. One entry today (this environment's key);
// during a key rotation it holds the old and the new one, so tokens signed before the
// switch keep verifying until they expire.
export type VerificationKeys = ReadonlyMap<string, KeyObject>;

// exp (and nbf) may be off by this much: clocks on different machines drift.
export const CLOCK_TOLERANCE_SECONDS = 5;

// Who the request is from, as the guard puts it on req.user. jti and exp let the
// denylist refuse one token until it would have expired anyway; sid (the refresh
// family) lets it refuse every token of one login.
export interface AuthUser {
  id: string;
  role: UserRole;
  jti: string;
  exp: number;
  sid: string;
}

// A token whose kid isn't in the map: refused like a bad signature.
export class UnknownKidError extends Error {
  readonly code = 'ERR_UNKNOWN_KID';
  constructor(kid: string | undefined) {
    super(`no key for kid ${kid ?? '(none)'}`);
  }
}

// A verified token whose claims aren't what this API issues.
export class InvalidClaimsError extends Error {
  readonly code = 'ERR_INVALID_CLAIMS';
}

// Checks the signature (with the key the header's kid names), the algorithm (only
// ES256: never the token's own choice, so "alg": "none" or an HS256 token forged with
// the public key as the secret is refused), iss, aud and exp. Throws on anything else.
export async function verifyAccessToken(token: string, keys: VerificationKeys): Promise<AuthUser> {
  const { payload } = await jwtVerify(
    token,
    (header: JWTHeaderParameters) => {
      const key = header.kid === undefined ? undefined : keys.get(header.kid);
      if (!key) throw new UnknownKidError(header.kid);
      return key;
    },
    {
      algorithms: ['ES256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['sub', 'jti', 'iat', 'exp'],
    },
  );
  const role = payload.role as UserRole;
  if (!USER_ROLES.includes(role)) throw new InvalidClaimsError('role');
  if (typeof payload.sid !== 'string' || payload.sid === '') throw new InvalidClaimsError('sid');
  return { id: payload.sub!, role, jti: payload.jti!, exp: payload.exp!, sid: payload.sid };
}
