/** Verified Clerk session claims used by `chat_service`. */
export interface SessionClaims {
  /** Platform user id (`sub`). */
  userId: string;
  /** Snapshot stored as `author_username` at send time. */
  username: string;
}

export interface TokenVerifier {
  /** Verifies a bearer token offline; throws when the token is not valid. */
  verify(token: string): Promise<SessionClaims>;
}
