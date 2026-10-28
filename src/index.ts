import { Elysia } from "elysia";
import { createCommunityAccessClient } from "./access/communityAccessClient";
import { createClerkTokenVerifier } from "./auth/clerk";
import type { TokenVerifier } from "./auth/types";
import { ConfigError, loadConfig } from "./config";
import type { Config } from "./config";
import { MessageController } from "./controllers/messageController";
import { createDatabase, pingDatabase } from "./db/client";
import { CommunityEventsConsumer } from "./events/communityEventsConsumer";
import { CommunityEventsProcessor } from "./events/communityEventsProcessor";
import { createKafkaConsumerFactory, startLagMonitor } from "./events/kafkaConsumer";
import { createKafkaProducer } from "./events/kafkaProducer";
import { OutboxRelay } from "./events/outboxRelay";
import { ReadinessState } from "./health";
import { createLogger, SERVICE_NAME } from "./logger";
import type { AppLogger } from "./logger";
import { createMetrics } from "./metrics";
import type { Metrics } from "./metrics";
import { createTokenBucketRateLimiter } from "./rateLimit";
import { DrizzleMessageRepository } from "./repositories/drizzleMessages";
import { DrizzleOutboxRepository } from "./repositories/drizzleOutbox";
import { DrizzlePurgeRepository } from "./repositories/drizzlePurge";
import { healthRoutes } from "./routes/health";
import { messageRoutes } from "./routes/messages";
import { MessageService } from "./services/messageService";

export interface AppDependencies {
  verifier: TokenVerifier;
  controller: MessageController;
  readiness: ReadinessState;
  metrics: Metrics;
  logger: AppLogger;
}

/** Builds the HTTP application. Dependencies are injected for testability. */
export function createApp(deps: AppDependencies) {
  return new Elysia()
    .use(
      messageRoutes({
        controller: deps.controller,
        verifier: deps.verifier,
        metrics: deps.metrics,
        logger: deps.logger,
      }),
    )
    .use(healthRoutes({ readiness: deps.readiness, metrics: deps.metrics, logger: deps.logger }));
}

/** The concrete Elysia instance produced by `createApp`. */
export type ChatApp = ReturnType<typeof createApp>;

export interface RunningService {
  app: ChatApp;
  shutdown: (reason: string) => Promise<void>;
}

export async function bootstrap(env: Record<string, string | undefined> = process.env): Promise<RunningService> {
  let config: Config;

  try {
    config = loadConfig(env);
  } catch (error) {
    // Fail fast with structured output; never print secrets.
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        service_name: SERVICE_NAME,
        message: error instanceof Error ? error.message : "invalid configuration",
        operation: "bootstrap",
        status: "error",
        variables: error instanceof ConfigError ? error.issues.map((issue) => issue.path) : [],
      })}\n`,
    );
    throw error;
  }

  const logger = createLogger({ level: config.logLevel });
  const metrics = createMetrics();

  const { pool, db } = createDatabase(config.databaseUrl);
  const messageRepository = new DrizzleMessageRepository(db);
  const outboxRepository = new DrizzleOutboxRepository(db);
  const purgeRepository = new DrizzlePurgeRepository(db);

  const producer = createKafkaProducer(config);
  const accessClient = createCommunityAccessClient({
    baseUrl: config.communityServiceUrl,
    serviceToken: config.serviceToken,
    timeoutMs: config.accessCheckTimeoutMs,
    metrics,
    logger,
  });
  const verifier = createClerkTokenVerifier({
    issuer: config.clerk.issuer,
    audience: config.clerk.audience,
    ...(config.clerk.jwtKey ? { jwtKey: config.clerk.jwtKey } : {}),
    ...(config.clerk.jwksUrl ? { jwksUrl: config.clerk.jwksUrl } : {}),
    logger,
  });

  const service = new MessageService({
    repository: messageRepository,
    accessClient,
    rateLimiter: createTokenBucketRateLimiter({ limitPerMinute: config.rateLimitSendPerMinute }),
    metrics,
    logger,
  });

  const readiness = new ReadinessState({
    database: { ping: () => pingDatabase(pool) },
    producer,
  });

  const relay = new OutboxRelay({ outbox: outboxRepository, producer, metrics, logger });
  const eventsProcessor = new CommunityEventsProcessor({ purge: purgeRepository, logger });
  const consumer = new CommunityEventsConsumer({
    processor: eventsProcessor,
    consumerFactory: createKafkaConsumerFactory(config),
    logger,
  });
  const stopLagMonitor = startLagMonitor({ config, metrics, logger });

  const app = createApp({
    verifier,
    controller: new MessageController(service),
    readiness,
    metrics,
    logger,
  });

  await producer.connect().catch((error: unknown) => {
    // A broker outage must not stop the pod from starting: /readyz reports it.
    logger.error("kafka producer failed to connect", {
      operation: "bootstrap",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const oldest = await outboxRepository.oldestUnpublishedCreatedAt().catch(() => null);

  if (oldest) {
    metrics.setOutboxUnpublishedAge(Math.max(0, (Date.now() - oldest.getTime()) / 1000));
  }

  app.listen(config.port);
  relay.start();
  await consumer.start().catch((error: unknown) => {
    logger.error("community events consumer failed to start", {
      operation: "bootstrap",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info("chat_service started", {
    operation: "bootstrap",
    status: "started",
    port: config.port,
  });

  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    // 1. Stop receiving traffic, then drain in-flight requests.
    readiness.beginDraining();
    logger.info("draining", { operation: "shutdown", status: "draining", reason });

    const drainDeadline = Date.now() + config.shutdownTimeoutSeconds * 1000;

    await app.stop();
    // 2. Pause the consumer loop (offsets of completed work are already committed).
    await consumer.stop();
    // 3. Best-effort flush of pending outbox rows within the drain window.
    await relay.stop();
    stopLagMonitor();

    while (Date.now() < drainDeadline) {
      const pending = await relay.tick().catch(() => ({ published: 0, failed: 1 }));

      if (pending.published === 0) {
        break;
      }
    }

    await producer.disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
    logger.info("shutdown complete", { operation: "shutdown", status: "stopped", reason });
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });

  return { app, shutdown };
}

if (import.meta.main) {
  await bootstrap();
}
