import { describe, expect, it } from "bun:test";
import { createLogger, formatLogLine } from "../../src/logger";

describe("formatLogLine", () => {
  it("produces the documented structured JSON shape", () => {
    const line = formatLogLine(
      { level: "info", message: "message sent", trace_id: "trace-1", request_id: "req-1", operation: "send_message", status: "created" },
      { serviceName: "chat_service", timestamp: "2025-01-01T00:00:00.000Z" },
    );

    expect(JSON.parse(line)).toEqual({
      timestamp: "2025-01-01T00:00:00.000Z",
      level: "info",
      service_name: "chat_service",
      message: "message sent",
      trace_id: "trace-1",
      request_id: "req-1",
      operation: "send_message",
      status: "created",
    });
  });

  it("keeps structured fields on error lines", () => {
    const line = formatLogLine(
      { level: "error", message: "access check failed", trace_id: "trace-2", operation: "access_check", status: "error" },
      { serviceName: "chat_service", timestamp: "2025-01-01T00:00:00.000Z" },
    );

    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      service_name: "chat_service",
      trace_id: "trace-2",
      status: "error",
    });
  });
});

describe("createLogger", () => {
  it("writes JSON lines through the supplied sink", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });

    logger.info("started", { operation: "bootstrap", trace_id: "abc" });
    logger.debug("detailed", { operation: "bootstrap" });
    logger.warn("slow", { operation: "access_check" });
    logger.error("boom", { operation: "access_check", status: "error" });

    expect(lines).toHaveLength(4);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({ level: "info", message: "started", service_name: "chat_service", trace_id: "abc" });
    expect(records[1]).toMatchObject({ level: "debug" });
    expect(records[2]).toMatchObject({ level: "warn" });
    expect(records[3]).toMatchObject({ level: "error", status: "error" });
    expect(records.every((record) => typeof record.timestamp === "string")).toBe(true);
  });

  it("respects the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });

    logger.info("ignored", { operation: "bootstrap" });
    logger.error("kept", { operation: "bootstrap" });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "error", message: "kept" });
  });

  it("binds request-scoped fields for child loggers", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", sink: (line) => lines.push(line) });
    const child = logger.child({ request_id: "req-42", trace_id: "trace-42" });

    child.info("scoped", { operation: "list_messages" });

    expect(JSON.parse(lines[0] as string)).toMatchObject({
      request_id: "req-42",
      trace_id: "trace-42",
      operation: "list_messages",
      service_name: "chat_service",
    });
  });

  it("defaults to a stdout sink without throwing", () => {
    const logger = createLogger({ level: "error" });

    expect(() => logger.error("to stdout", { operation: "bootstrap" })).not.toThrow();
  });
});
