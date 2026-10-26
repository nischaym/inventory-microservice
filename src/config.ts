import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export interface Config {
  readonly port: number;
  readonly dataDir: string;
  readonly logLevel: (typeof LOG_LEVELS)[number];
}

const environmentSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(0).max(65_535))
    .default(8080),
  DATA_DIR: z.string().min(1, 'must not be empty').default('/data'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parses environment variables; throws ConfigError naming every invalid variable. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  return { port: result.data.PORT, dataDir: result.data.DATA_DIR, logLevel: result.data.LOG_LEVEL };
}
