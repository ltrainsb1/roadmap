import { MongoMemoryReplSet } from 'mongodb-memory-server';

export interface TestMongo {
  uri: string;
  stop(): Promise<void>;
}

/** In-process replica set (supports transactions). Default for unit tests; needs no Docker. */
export async function memoryMongo(): Promise<TestMongo> {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  return { uri: rs.getUri(), stop: async () => void (await rs.stop()) };
}

/** Testcontainers mongo:8.0 replica set when TEST_MONGO=container, otherwise memoryMongo(). */
export async function startMongo(): Promise<TestMongo> {
  if (process.env.TEST_MONGO !== 'container') return memoryMongo();
  const { MongoDBContainer } = await import('@testcontainers/mongodb');
  const container = await new MongoDBContainer('mongo:8.0').start();
  // Replica-set containers advertise an internal hostname; connect directly to the mapped port.
  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true`;
  return { uri, stop: async () => void (await container.stop()) };
}
