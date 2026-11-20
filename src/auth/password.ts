// Password hashing with Argon2id (the argon2 package): the algorithm #165 ranks first,
// memory-hard and deliberately slow, because passwords are low-entropy and a stolen
// hash must be expensive to guess at. The library does the rest: a random salt per
// hash, the parameters stored with it ($argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>,
// so they can be raised later), and a constant-time comparison in verify.
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

// The library's defaults for Argon2id: 64 MiB, 3 passes, 4 lanes (above OWASP's
// minimum of 19 MiB, 2 passes).
export const hashPassword = (password: string): Promise<string> => argon2.hash(password, { type: argon2.argon2id });

// A malformed stored hash is no match, not an error.
export const verifyPassword = (password: string, stored: string): Promise<boolean> =>
  argon2.verify(stored, password).catch(() => false);

// For an unknown email: a real hash of a random password, verified against all the
// same, so "no such user" takes as long as "wrong password" and timing can't tell
// which emails exist. Computed once (AuthService computes it at startup).
let dummy: Promise<string> | undefined;
export const dummyPasswordHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(16).toString('hex')));
