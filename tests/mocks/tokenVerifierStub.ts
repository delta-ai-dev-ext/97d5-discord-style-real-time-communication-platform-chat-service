import type { SessionClaims, TokenVerifier } from "../../src/auth/types";

/**
 * Offline Clerk token-verifier double: maps bearer tokens to fixed claims and
 * rejects everything else, exactly like an invalid signature would.
 */
export class TokenVerifierStub implements TokenVerifier {
  readonly tokens: string[] = [];
  private readonly tokenMap: Map<string, SessionClaims>;

  constructor(entries: Array<[string, SessionClaims]>) {
    this.tokenMap = new Map(entries);
  }

  async verify(token: string): Promise<SessionClaims> {
    this.tokens.push(token);
    const claims = this.tokenMap.get(token);

    if (!claims) {
      throw new Error("invalid token");
    }

    return claims;
  }
}
