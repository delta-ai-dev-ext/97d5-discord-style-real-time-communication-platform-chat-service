import { describe, expect, it } from "bun:test";
import { createAppHarness } from "../mocks/appHarness";
import { httpCall } from "../mocks/httpClient";

interface HealthBody {
  status: string;
}

describe("GET /healthz (liveness)", () => {
  it("answers 200 without probing any downstream dependency", async () => {
    const test = createAppHarness();
    test.producerState.connected = false;
    test.databaseState.healthy = false;

    const response = await httpCall<HealthBody>(test.app, "/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("GET /readyz (readiness)", () => {
  it("answers 200 when the database pool and the Kafka producer are ready", async () => {
    const test = createAppHarness();

    const response = await httpCall<HealthBody>(test.app, "/readyz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("answers 503 when the Kafka producer is disconnected", async () => {
    const test = createAppHarness();
    test.producerState.connected = false;

    const response = await httpCall<HealthBody>(test.app, "/readyz");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "unavailable" });
  });

  it("answers 503 when the database pool is unusable", async () => {
    const test = createAppHarness();
    test.databaseState.healthy = false;

    const response = await httpCall<HealthBody>(test.app, "/readyz");

    expect(response.status).toBe(503);
  });

  it("answers 503 as soon as draining starts", async () => {
    const test = createAppHarness();

    test.readiness.beginDraining();
    const response = await httpCall<HealthBody>(test.app, "/readyz");

    expect(test.readiness.isDraining()).toBe(true);
    expect(response.status).toBe(503);
  });
});

describe("GET /metrics", () => {
  it("exposes the Prometheus registry", async () => {
    const test = createAppHarness();

    const response = await test.app.handle(new Request("http://chat.local/metrics"));
    const exposition = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(exposition).toContain("chat_messages_sent_total");
    expect(exposition).toContain("http_request_duration_seconds");
  });
});
