import { verifyToken } from "@clerk/backend";
import { z } from "zod";
import { isAppError, unauthorized } from "../errors";
import type { AppLogger } from "../logger";
import { createJwksLoader } from "./jwks";
import type { SessionClaims, TokenVerifier } from "./types";

/**
 * Offline Clerk session-token verification (`@clerk/backend` `verifyToken`).
 *
 * No Backend API call happens on the request path: the public key comes either
 * from `CLERK_JWT_KEY` or from the cached key set served by `CLERK_JWKS_URL`.
 */

export interface ClerkTokenVerifierOptions {
  issuer: string;
  audience: string;
  jwtKey?: string;
  jwksUrl?: string;
  logger: AppLogger;
  /** Test seams; production uses the platform defaults. */
  fetchImpl?: typeof fetch;
  verifyImpl?: typeof verifyToken;
  now?: () => number;
}

const claimsSchema = z.object({
  sub: z.string().min(1),
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});

export function createClerkTokenVerifier(options: ClerkTokenVerifierOptions): TokenVerifier {
  const verify = options.verifyImpl ?? verifyToken;
  const loader = options.jwksUrl
    ? createJwksLoader({
        jwksUrl: options.jwksUrl,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    : null;

  return {
    async verify(token: string): Promise<SessionClaims> {
      if (!token) {
        throw unauthorized();
      }

      try {
        const key = options.jwtKey ?? (loader ? await loader.keyFor(token) : null);

        if (!key) {
          throw new Error("no Clerk verification key is configured");
        }

        const payload = await verify(token, {
          jwtKey: key,
          issuer: options.issuer,
          audience: options.audience,
        });
        const claims = claimsSchema.safeParse(payload as unknown);

        if (!claims.success) {
          throw new Error("session token is missing the sub claim");
        }

        return {
          userId: claims.data.sub,
          username: claims.data.username ?? claims.data.email ?? claims.data.sub,
        };
      } catch (error) {
        if (isAppError(error)) {
          throw error;
        }

        options.logger.warn("session token rejected", {
          operation: "auth",
          status: "unauthorized",
          error: error instanceof Error ? error.message : String(error),
        });

        throw unauthorized();
      }
    },
  };
}
