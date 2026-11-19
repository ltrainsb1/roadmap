import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/**
 * One MongoDB per test run, started before any test file so start-up never eats a test timeout.
 * Testcontainers mongo:8.0 when TEST_MONGO=container, otherwise an in-process replica set.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.TEST_MONGO === 'container') {
    const { MongoDBContainer } = await import('@testcontainers/mongodb');
    const container = await new MongoDBContainer('mongo:8.0')
      // Every test app gets its own database (about 40 files each); the default fd limit on some hosts is too low.
      .withUlimits({ nofile: { soft: 65536, hard: 65536 } })
      .start();
    // Replica-set containers advertise an internal hostname; connect directly to the mapped port.
    project.provide(
      'mongoUri',
      `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true`,
    );
    return async () => void (await container.stop());
  }
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  project.provide('mongoUri', rs.getUri());
  return async () => void (await rs.stop());
}
