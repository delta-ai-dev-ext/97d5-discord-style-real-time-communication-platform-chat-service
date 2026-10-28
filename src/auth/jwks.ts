import { z } from "zod";

/**
 * Offline JWKS support.
 *
 * `@clerk/backend`'s `verifyToken` verifies networklessly when it is given a PEM
 * public key. `CLERK_JWT_KEY` supplies one directly; when only
 * `CLERK_JWKS_URL` is configured we fetch the key set once (cached, refreshed on
 * TTL) and hand the matching key to `verifyToken`, so the request path never
 * calls the Clerk Backend API.
 */

const jwkSchema = z.object({
  kid: z.string().optional(),
  kty: z.string().min(1),
  alg: z.string().optional(),
  use: z.string().optional(),
  crv: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
});

const jwksSchema = z.object({ keys: z.array(jwkSchema).min(1) });

export type Jwk = z.infer<typeof jwkSchema>;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function pemFromDer(der: ArrayBuffer): string {
  const base64 = base64FromBytes(new Uint8Array(der));
  const lines = base64.match(/.{1,64}/g) ?? [];

  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

/** Converts a JWKS entry into the PEM form `verifyToken` expects. */
export async function jwkToPem(jwk: Jwk): Promise<string> {
  if (jwk.kty !== "RSA" && jwk.kty !== "EC") {
    throw new Error(`unsupported key type: ${jwk.kty}`);
  }

  const algorithm: RsaHashedImportParams | EcKeyImportParams =
    jwk.kty === "RSA"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: jwk.crv ?? "P-256" };

  const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm, true, ["verify"]);
  const der = await crypto.subtle.exportKey("spki", key);

  return pemFromDer(der);
}

/** Reads `kid` from a JWT header without trusting any of its contents. */
export function readKeyId(token: string): string | undefined {
  const [header] = token.split(".");

  if (!header) {
    return undefined;
  }

  try {
    const padded = header.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
      ),
    ) as unknown;
    const parsed = z.object({ kid: z.string().optional() }).safeParse(decoded);

    return parsed.success ? parsed.data.kid : undefined;
  } catch {
    return undefined;
  }
}

export interface JwksLoaderOptions {
  jwksUrl: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface JwksLoader {
  /** Returns the PEM for the token's key id (first key when no `kid`). */
  keyFor(token: string): Promise<string>;
}

export function createJwksLoader(options: JwksLoaderOptions): JwksLoader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());

  let cached: { keys: Jwk[]; fetchedAtMs: number } | null = null;
  let inFlight: Promise<Jwk[]> | null = null;

  async function fetchKeys(): Promise<Jwk[]> {
    const response = await fetchImpl(options.jwksUrl, { headers: { accept: "application/json" } });

    if (!response.ok) {
      throw new Error(`JWKS request failed with ${response.status}`);
    }

    const parsed = jwksSchema.safeParse(await response.json());

    if (!parsed.success) {
      throw new Error("JWKS response is not a key set");
    }

    return parsed.data.keys;
  }

  async function loadKeys(force: boolean): Promise<Jwk[]> {
    const fresh = cached !== null && !force && now() - cached.fetchedAtMs < ttlMs;

    if (fresh && cached) {
      return cached.keys;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = fetchKeys()
      .then((keys) => {
        cached = { keys, fetchedAtMs: now() };

        return keys;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  return {
    async keyFor(token: string): Promise<string> {
      const kid = readKeyId(token);
      let keys = await loadKeys(false);
      let jwk = kid === undefined ? keys[0] : keys.find((candidate) => candidate.kid === kid);

      if (!jwk) {
        // The key set rotated: refresh once before failing.
        keys = await loadKeys(true);
        jwk = kid === undefined ? keys[0] : keys.find((candidate) => candidate.kid === kid);
      }

      if (!jwk) {
        throw new Error("no matching JWKS key for this token");
      }

      return jwkToPem(jwk);
    },
  };
}
