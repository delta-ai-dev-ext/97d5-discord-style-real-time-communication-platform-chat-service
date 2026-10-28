import { describe, expect, it } from "bun:test";
import { ConfigError, loadConfig } from "../../src/config";

const baseEnv: Record<string, string> = {
  DATABASE_URL: "postgres://user:secret@localhost:5432/chat_service",
  KAFKA_BROKERS: "broker-a:9092,broker-b:9092",
  COMMUNITY_SERVICE_URL: "http://community-service:3001",
  SERVICE_TOKEN: "super-secret-service-token",
  CLERK_JWKS_URL: "https://clerk.example.com/.well-known/jwks.json",
  CLERK_ISSUER: "https://clerk.example.com",
  CLERK_AUDIENCE: "chat_service",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(baseEnv);

    expect(config.port).toBe(3000);
    expect(config.accessCheckTimeoutMs).toBe(300);
    expect(config.shutdownTimeoutSeconds).toBe(25);
    expect(config.logLevel).toBe("info");
    expect(config.kafka.consumerGroup).toBe("chat_service");
    expect(config.kafka.clientId).toBe("chat_service");
    expect(config.rateLimitSendPerMinute).toBe(30);
    expect(config.clerk.jwksUrl).toBe(baseEnv.CLERK_JWKS_URL);
    expect(config.clerk.jwtKey).toBeUndefined();
    expect(config.communityServiceUrl).toBe("http://community-service:3001");
  });

  it("splits and trims the Kafka broker list", () => {
    const config = loadConfig({ ...baseEnv, KAFKA_BROKERS: " a:9092 , b:9092 , " });

    expect(config.kafka.brokers).toEqual(["a:9092", "b:9092"]);
  });

  it("accepts an offline CLERK_JWT_KEY instead of a JWKS URL", () => {
    const { CLERK_JWKS_URL: _omitted, ...withoutJwks } = baseEnv;
    const config = loadConfig({ ...withoutJwks, CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----abc" });

    expect(config.clerk.jwtKey).toBe("-----BEGIN PUBLIC KEY-----abc");
    expect(config.clerk.jwksUrl).toBeUndefined();
  });

  it("honours overridden numeric and enum knobs", () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: "8080",
      ACCESS_CHECK_TIMEOUT_MS: "250",
      RATE_LIMIT_SEND_PER_MINUTE: "5",
      SHUTDOWN_TIMEOUT_SECONDS: "10",
      LOG_LEVEL: "debug",
      CHAT_KAFKA_CONSUMER_GROUP: "chat_service_canary",
    });

    expect(config.port).toBe(8080);
    expect(config.accessCheckTimeoutMs).toBe(250);
    expect(config.rateLimitSendPerMinute).toBe(5);
    expect(config.shutdownTimeoutSeconds).toBe(10);
    expect(config.logLevel).toBe("debug");
    expect(config.kafka.consumerGroup).toBe("chat_service_canary");
  });

  it("parses optional Kafka TLS and SASL settings", () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_TLS: "true",
      KAFKA_SASL_MECHANISM: "scram-sha-256",
      KAFKA_SASL_USERNAME: "chat",
      KAFKA_SASL_PASSWORD: "pw",
      KAFKA_CLIENT_ID: "chat_service_pod",
    });

    expect(config.kafka.tls).toBe(true);
    expect(config.kafka.sasl).toEqual({ mechanism: "scram-sha-256", username: "chat", password: "pw" });
    expect(config.kafka.clientId).toBe("chat_service_pod");
  });

  it("leaves Kafka auth undefined when unset", () => {
    const config = loadConfig(baseEnv);

    expect(config.kafka.tls).toBe(false);
    expect(config.kafka.sasl).toBeUndefined();
  });

  it("fails fast when a required variable is missing", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("reports every missing variable by name", () => {
    try {
      loadConfig({});
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      for (const name of ["DATABASE_URL", "KAFKA_BROKERS", "COMMUNITY_SERVICE_URL", "SERVICE_TOKEN", "CLERK_ISSUER", "CLERK_AUDIENCE"]) {
        expect(message).toContain(name);
      }
    }
  });

  it("requires one Clerk verification key source", () => {
    const { CLERK_JWKS_URL: _omitted, ...withoutJwks } = baseEnv;

    expect(() => loadConfig(withoutJwks)).toThrow(/CLERK_JWKS_URL.*CLERK_JWT_KEY|CLERK_JWT_KEY.*CLERK_JWKS_URL/);
  });

  it("rejects an unknown log level", () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: "trace" })).toThrow(ConfigError);
  });

  it("rejects non-numeric numeric knobs", () => {
    expect(() => loadConfig({ ...baseEnv, ACCESS_CHECK_TIMEOUT_MS: "fast" })).toThrow(ConfigError);
  });

  it("never echoes secret values in the error message", () => {
    try {
      loadConfig({ ...baseEnv, PORT: "not-a-port" });
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).not.toContain("super-secret-service-token");
      expect(message).not.toContain("secret@localhost");
    }
  });
});
