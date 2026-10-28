/**
 * Health module.
 *
 * `/healthz` is liveness only: the process and event loop are responsive and no
 * downstream dependency is probed (a Kafka or community_service incident must
 * not trigger a restart storm). `/readyz` gates traffic on the PostgreSQL pool
 * and the Kafka producer, and starts failing as soon as draining begins.
 */

export interface DatabaseProbe {
  ping(): Promise<boolean>;
}

export interface ProducerProbe {
  isConnected(): boolean;
}

export interface ReadinessDependencies {
  database: DatabaseProbe;
  producer: ProducerProbe;
}

export interface ReadinessReport {
  ready: boolean;
  draining: boolean;
  database: boolean;
  kafka: boolean;
}

export class ReadinessState {
  private draining = false;

  constructor(private readonly deps: ReadinessDependencies) {}

  /** Called first thing on SIGTERM/SIGINT so Kubernetes stops routing traffic. */
  beginDraining(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  async check(): Promise<ReadinessReport> {
    if (this.draining) {
      return { ready: false, draining: true, database: false, kafka: this.deps.producer.isConnected() };
    }

    const database = await this.deps.database.ping();
    const kafka = this.deps.producer.isConnected();

    return { ready: database && kafka, draining: false, database, kafka };
  }
}
