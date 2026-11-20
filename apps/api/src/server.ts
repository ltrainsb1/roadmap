import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connectDb } from './db/client.ts';
import { ensureIndexes } from './db/indexes.ts';

const config = loadConfig(process.env);
const { db } = await connectDb(config.mongoUri, config.mongoDb);
await ensureIndexes(db);
const app = await buildApp({ config, db });
await app.listen({ port: config.port, host: '0.0.0.0' });
