import type { AccessCheckRequest, AccessClient, AccessDecision } from "../../src/access/types";
import { buildAccessDecision } from "./builders";

type Outcome = { kind: "decision"; decision: AccessDecision } | { kind: "error"; error: Error };

/**
 * `community_service` access stub. Records every call so tests can assert the
 * check happens on each send/read and never for author-scoped edits/deletes.
 */
export class AccessClientStub implements AccessClient {
  readonly requests: AccessCheckRequest[] = [];
  private outcome: Outcome;

  constructor(outcome: Outcome = { kind: "decision", decision: buildAccessDecision() }) {
    this.outcome = outcome;
  }

  setDecision(decision: AccessDecision): void {
    this.outcome = { kind: "decision", decision };
  }

  setError(error: Error): void {
    this.outcome = { kind: "error", error };
  }

  get callCount(): number {
    return this.requests.length;
  }

  async checkAccess(request: AccessCheckRequest): Promise<AccessDecision> {
    this.requests.push(request);

    if (this.outcome.kind === "error") {
      throw this.outcome.error;
    }

    return this.outcome.decision;
  }
}
