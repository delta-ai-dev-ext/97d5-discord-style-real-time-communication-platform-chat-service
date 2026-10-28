import { Registry } from "prom-client";
import { AccessClientStub } from "./accessClientStub";
import { AUTHOR_ID, OTHER_USER_ID, buildAccessDecision, buildClaims } from "./builders";
import { FakeMessageRepository } from "./fakeRepositories";
import { TokenVerifierStub } from "./tokenVerifierStub";
import { MessageController } from "../../src/controllers/messageController";
import { ReadinessState } from "../../src/health";
import { createApp } from "../../src/index";
import type { ChatApp } from "../../src/index";
import { createLogger } from "../../src/logger";
import type { AppLogger } from "../../src/logger";
import { createMetrics } from "../../src/metrics";
import type { Metrics } from "../../src/metrics";
import { createTokenBucketRateLimiter } from "../../src/rateLimit";
import { MessageService } from "../../src/services/messageService";

export const AUTHOR_TOKEN = "session-author";
export const OTHER_TOKEN = "session-other";

export interface AppHarness {
  app: ChatApp;
  repository: FakeMessageRepository;
  access: AccessClientStub;
  metrics: Metrics;
  logger: AppLogger;
  readiness: ReadinessState;
  producerState: { connected: boolean };
  databaseState: { healthy: boolean };
}

export interface HarnessOptions {
  limitPerMinute?: number;
}

/**
 * Full in-process app with every external dependency faked: PostgreSQL
 * (repository), community_service (access stub), Clerk (offline verifier stub),
 * Kafka (producer/consumer doubles) and the rate limiter.
 */
export function createAppHarness(options: HarnessOptions = {}): AppHarness {
  const logger = createLogger({ level: "error", sink: () => undefined });
  const metrics = createMetrics(new Registry());
  const repository = new FakeMessageRepository();
  const access = new AccessClientStub({ kind: "decision", decision: buildAccessDecision() });
  const verifier = new TokenVerifierStub([
    [AUTHOR_TOKEN, buildClaims({ userId: AUTHOR_ID, username: "author" })],
    [OTHER_TOKEN, buildClaims({ userId: OTHER_USER_ID, username: "other" })],
  ]);
  const producerState = { connected: true };
  const databaseState = { healthy: true };
  const readiness = new ReadinessState({
    database: {
      ping: async () => databaseState.healthy,
    },
    producer: {
      isConnected: () => producerState.connected,
    },
  });
  const service = new MessageService({
    repository,
    accessClient: access,
    rateLimiter: createTokenBucketRateLimiter({ limitPerMinute: options.limitPerMinute ?? 60 }),
    metrics,
    logger,
  });
  const app = createApp({
    verifier,
    controller: new MessageController(service),
    readiness,
    metrics,
    logger,
  });

  return { app, repository, access, metrics, logger, readiness, producerState, databaseState };
}
