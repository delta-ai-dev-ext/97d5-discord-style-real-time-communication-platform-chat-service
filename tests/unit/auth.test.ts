import { describe, expect, it } from "bun:test";
import { createClerkTokenVerifier } from "../../src/auth/clerk";
import { jwkToPem } from "../../src/auth/jwks";
import { AppError } from "../../src/errors";
import { createLogger } from "../../src/logger";
import { createTestSigningKey, jwksDocument, signSessionToken } from "../mocks/clerkJwt";
import { FetchStub, jsonResponse } from "../mocks/fetchStub";

const ISSUER = "https://clerk.example.com";
const AUDIENCE = "chat_service";
const JWKS_URL = "https://clerk.example.com/.well-known/jwks.json";

function silentLogger() {
  return createLogger({ level: "error", sink: () => undefined });
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error("expected the token to be rejected");
}

describe("createClerkTokenVerifier — offline JWKS mode", () => {
  it("verifies a real RS256 session token and maps the claims", async () => {
    const key = await createTestSigningKey();
    const fetchStub = new FetchStub(() => jsonResponse(jwksDocument([key])));
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: fetchStub.fetch,
    });
    const token = await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_1", username: "ada" });

    const claims = await verifier.verify(token);

    expect(claims).toEqual({ userId: "user_1", username: "ada" });
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.url).toBe(JWKS_URL);
  });

  it("caches the key set so the request path stays offline", async () => {
    const key = await createTestSigningKey();
    const fetchStub = new FetchStub(() => jsonResponse(jwksDocument([key])));
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: fetchStub.fetch,
      now: () => 1_000,
    });

    await verifier.verify(
      await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_1", username: "ada" }),
    );
    await verifier.verify(
      await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_2", username: "grace" }),
    );

    expect(fetchStub.calls).toHaveLength(1);
  });

  it("picks the key by kid and refreshes the cache when the key set rotates", async () => {
    const first = await createTestSigningKey("key_1");
    const second = await createTestSigningKey("key_2");
    let served = [first];
    const fetchStub = new FetchStub(() => jsonResponse(jwksDocument(served)));
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: fetchStub.fetch,
      now: () => 1_000,
    });

    await verifier.verify(await signSessionToken({ key: first, issuer: ISSUER, audience: AUDIENCE, sub: "user_1" }));
    served = [first, second];
    const claims = await verifier.verify(
      await signSessionToken({ key: second, issuer: ISSUER, audience: AUDIENCE, sub: "user_2" }),
    );

    expect(claims.userId).toBe("user_2");
    expect(fetchStub.calls).toHaveLength(2);
  });

  it("falls back to email and then sub when the username claim is absent", async () => {
    const key = await createTestSigningKey();
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: new FetchStub(() => jsonResponse(jwksDocument([key]))).fetch,
    });

    const withEmail = await verifier.verify(
      await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_1", email: "ada@example.com" }),
    );
    const bare = await verifier.verify(
      await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_2" }),
    );

    expect(withEmail.username).toBe("ada@example.com");
    expect(bare.username).toBe("user_2");
  });

  it("rejects a token signed with an unknown key", async () => {
    const trusted = await createTestSigningKey("key_1");
    const rogue = await createTestSigningKey("key_rogue");
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: new FetchStub(() => jsonResponse(jwksDocument([trusted]))).fetch,
    });

    const error = await expectUnauthorized(
      verifier.verify(await signSessionToken({ key: rogue, issuer: ISSUER, audience: AUDIENCE, sub: "user_1" })),
    );

    expect(error.code).toBe("unauthorized");
    expect(error.httpStatus).toBe(401);
  });

  it("rejects tokens with the wrong issuer, audience or expiry", async () => {
    const key = await createTestSigningKey();
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: new FetchStub(() => jsonResponse(jwksDocument([key]))).fetch,
    });

    for (const token of [
      await signSessionToken({ key, issuer: "https://evil.example.com", audience: AUDIENCE, sub: "user_1" }),
      await signSessionToken({ key, issuer: ISSUER, audience: "realtime_gateway", sub: "user_1" }),
      await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_1", expiresInSeconds: -120 }),
    ]) {
      expect((await expectUnauthorized(verifier.verify(token))).code).toBe("unauthorized");
    }
  });

  it("rejects empty and malformed tokens", async () => {
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      logger: silentLogger(),
      fetchImpl: new FetchStub(() => jsonResponse({ keys: [] })).fetch,
    });

    expect((await expectUnauthorized(verifier.verify(""))).code).toBe("unauthorized");
    expect((await expectUnauthorized(verifier.verify("not-a-jwt"))).code).toBe("unauthorized");
  });
});

describe("createClerkTokenVerifier — offline JWT key mode", () => {
  it("verifies without touching the network", async () => {
    const key = await createTestSigningKey();
    const fetchStub = new FetchStub(() => {
      throw new Error("the network must not be used");
    });
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtKey: await jwkToPem(key.jwk),
      logger: silentLogger(),
      fetchImpl: fetchStub.fetch,
    });

    const claims = await verifier.verify(
      await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_9", username: "linus" }),
    );

    expect(claims).toEqual({ userId: "user_9", username: "linus" });
    expect(fetchStub.calls).toHaveLength(0);
  });

  it("rejects a token signed by a different key", async () => {
    const configured = await createTestSigningKey();
    const other = await createTestSigningKey("key_other");
    const verifier = createClerkTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtKey: await jwkToPem(configured.jwk),
      logger: silentLogger(),
    });

    const error = await expectUnauthorized(
      verifier.verify(await signSessionToken({ key: other, issuer: ISSUER, audience: AUDIENCE, sub: "user_1" })),
    );

    expect(error.code).toBe("unauthorized");
  });

  it("fails closed when no key material is configured", async () => {
    const key = await createTestSigningKey();
    const verifier = createClerkTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, logger: silentLogger() });

    const error = await expectUnauthorized(
      verifier.verify(await signSessionToken({ key, issuer: ISSUER, audience: AUDIENCE, sub: "user_1" })),
    );

    expect(error.code).toBe("unauthorized");
  });
});
