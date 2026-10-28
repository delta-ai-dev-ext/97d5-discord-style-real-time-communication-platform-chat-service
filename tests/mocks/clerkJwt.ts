import type { Jwk } from "../../src/auth/jwks";

/**
 * Real RS256 session-token fixtures for the offline Clerk verifier: keys and
 * signatures are produced with WebCrypto, so the tests exercise the actual
 * `@clerk/backend` verification path (signature, iss, aud, exp) rather than a
 * stubbed verifier.
 */

export interface TestSigningKey {
  kid: string;
  privateKey: CryptoKey;
  /** Public key in JWKS form (`kty`/`n`/`e` present, plus `kid`). */
  jwk: Jwk;
}

export async function createTestSigningKey(kid = "key_test_1"): Promise<TestSigningKey> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as Record<string, unknown>;

  return { kid, privateKey: keyPair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as Jwk };
}

function base64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SignSessionTokenParams {
  key: TestSigningKey;
  issuer: string;
  audience: string;
  sub: string;
  username?: string;
  email?: string;
  expiresInSeconds?: number;
  nowMs?: number;
}

export async function signSessionToken(params: SignSessionTokenParams): Promise<string> {
  const issuedAtMs = params.nowMs ?? Date.now();
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: params.key.kid };
  const payload: Record<string, unknown> = {
    iss: params.issuer,
    sub: params.sub,
    aud: params.audience,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + (params.expiresInSeconds ?? 60),
    sid: "sess_test",
  };

  if (params.username !== undefined) {
    payload.username = params.username;
  }

  if (params.email !== undefined) {
    payload.email = params.email;
  }

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    params.key.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** A JWKS document for the given keys, served by the fetch stub. */
export function jwksDocument(keys: TestSigningKey[]): { keys: Jwk[] } {
  return { keys: keys.map((key) => key.jwk) };
}
