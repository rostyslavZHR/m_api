import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_URL: z.url({ protocol: /^postgres$/ }),
  RABBITMQ_URL: z.url({ protocol: /^amqps?$/ }),
  // Two Redis instances (HW#23): the cache (allkeys-lru, no persistence) and the
  // queue (noeviction, AOF: BullMQ jobs and sessions). Never the same instance.
  REDIS_CACHE_URL: z.url({ protocol: /^rediss?$/ }),
  REDIS_QUEUE_URL: z.url({ protocol: /^rediss?$/ }),
  // The cleanup scheduler runs daily at 03:00; set (in ms, at least 1000) only for a
  // demo, to make it fire every few seconds. Empty means unset, as in .env.example.
  CLEANUP_EVERY_MS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(1000).optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

export const validate = (env: Record<string, unknown>): Env => {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const brokenVars = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment variables:\n${brokenVars}`);
  }

  return parsed.data;
};

