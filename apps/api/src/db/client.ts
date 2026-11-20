import { MongoClient, type Db } from 'mongodb';

export type { Db };

export async function connectDb(
  uri: string,
  dbName: string,
): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db(dbName) };
}
