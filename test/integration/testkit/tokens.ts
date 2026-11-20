import { createPrivateKey, randomUUID } from 'node:crypto';
import type { UserRole } from '../../../src/entities/index.js';
import { signAccessToken } from '../../../src/auth/tokens.js';

// An access token signed with the test file's throwaway key (createTestApp puts it in
// the environment), as /auth/login would issue: for tests that call protected routes
// without going through a login each time. Call it after createTestApp.
export async function accessTokenFor(user: { id: string; role?: UserRole }, sid: string = randomUUID()): Promise<string> {
  const privateKey = createPrivateKey(Buffer.from(process.env.JWT_PRIVATE_KEY!, 'base64').toString());
  return signAccessToken({ privateKey, kid: process.env.JWT_KID! }, { id: user.id, role: user.role ?? 'customer' }, sid);
}

export const bearer = (token: string) => `Bearer ${token}`;
