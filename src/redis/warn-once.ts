// Logged, never swallowed, but once per distinct problem: a dead Redis would
// otherwise log on every request. ok() after a success clears the set, so the
// next outage is logged again.
export function warnOnce(prefix: string) {
  const warned = new Set<string>();
  // Arrow functions, so callers can destructure them.
  return {
    warn: (message: string): void => {
      if (warned.has(message)) return;
      warned.add(message);
      console.error(`[${prefix}] ${message}`);
    },
    ok: (): void => {
      warned.clear();
    },
  };
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
