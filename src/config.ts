import { z } from "zod";
import type { LogLevel } from "./logger";

/**
 * 12-factor configuration: everything comes from the environment, is validated
 * once at startup, and fails fast with a structured (secret-free) error.
 */

const booleanFlagSchema = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: z.string().min(1),
    KAFKA_BROKERS: z.string().min(1),
    KAFKA_CLIENT_ID: z.string().min(1).optional(),
    KAFKA_SASL_MECHANISM: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).optional(),
    KAFKA_SASL_USERNAME: z.string().min(1).optional(),
    KAFKA_SASL_PASSWORD: z.string().min(1).optional(),
    KAFKA_TLS: booleanFlagSchema.optional(),
    CHAT_KAFKA_CONSUMER_GROUP: z.string().min(1).default("chat_service"),
    COMMUNITY_SERVICE_URL: z.string().min(1),
    SERVICE_TOKEN: z.string().min(1),
    CLERK_JWKS_URL: z.string().min(1).optional(),
    CLERK_JWT_KEY: z.string().min(1).optional(),
    CLERK_ISSUER: z.string().min(1),
    CLERK_AUDIENCE: z.string().min(1),
    ACCESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1).max(10_000).default(300),
    RATE_LIMIT_SEND_PER_MINUTE: z.coerce.number().int().min(1).max(6_000).default(30),
    SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(300).default(25),
    LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  })
  .refine((env) => Boolean(env.CLERK_JWKS_URL) || Boolean(env.CLERK_JWT_KEY), {
    message: "CLERK_JWKS_URL or CLERK_JWT_KEY is required for offline token verification",
    path: ["CLERK_JWKS_URL"],
  });

export interface KafkaSaslConfig {
  mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
  username: string;
  password: string;
}

export interface Config {
  port: number;
  databaseUrl: string;
  kafka: {
    brokers: string[];
    clientId: string;
    consumerGroup: string;
    tls: boolean;
    sasl?: KafkaSaslConfig;
  };
  communityServiceUrl: string;
  serviceToken: string;
  clerk: {
    jwksUrl?: string;
    jwtKey?: string;
    issuer: string;
    audience: string;
  };
  accessCheckTimeoutMs: number;
  rateLimitSendPerMinute: number;
  shutdownTimeoutSeconds: number;
  logLevel: LogLevel;
}

export interface ConfigIssue {
  path: string;
  message: string;
}

/** Raised when the process environment cannot satisfy the config contract. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      })),
    );
  }

  const value = parsed.data;
  const sasl =
    value.KAFKA_SASL_MECHANISM && value.KAFKA_SASL_USERNAME && value.KAFKA_SASL_PASSWORD
      ? {
          mechanism: value.KAFKA_SASL_MECHANISM,
          username: value.KAFKA_SASL_USERNAME,
          password: value.KAFKA_SASL_PASSWORD,
        }
      : undefined;

  return {
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    kafka: {
      brokers: value.KAFKA_BROKERS.split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
      clientId: value.KAFKA_CLIENT_ID ?? "chat_service",
      consumerGroup: value.CHAT_KAFKA_CONSUMER_GROUP,
      tls: value.KAFKA_TLS ?? false,
      ...(sasl ? { sasl } : {}),
    },
    communityServiceUrl: value.COMMUNITY_SERVICE_URL.replace(/\/+$/, ""),
    serviceToken: value.SERVICE_TOKEN,
    clerk: {
      jwksUrl: value.CLERK_JWKS_URL,
      jwtKey: value.CLERK_JWT_KEY,
      issuer: value.CLERK_ISSUER,
      audience: value.CLERK_AUDIENCE,
    },
    accessCheckTimeoutMs: value.ACCESS_CHECK_TIMEOUT_MS,
    rateLimitSendPerMinute: value.RATE_LIMIT_SEND_PER_MINUTE,
    shutdownTimeoutSeconds: value.SHUTDOWN_TIMEOUT_SECONDS,
    logLevel: value.LOG_LEVEL,
  };
}
