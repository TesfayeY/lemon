import { MongoClient, type Db } from 'mongodb';
import type { Env } from './config.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDb(config: Env): Promise<{ client: MongoClient; db: Db }> {
  client = new MongoClient(config.MONGO_URI);
  await client.connect();
  db = client.db(config.MONGO_DB_NAME);
  return { client, db };
}

export function getDb(): Db {
  if (!db) throw new Error('Database not connected');
  return db;
}

export function getClient(): MongoClient {
  if (!client) throw new Error('Database not connected');
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export async function checkMongo(): Promise<boolean> {
  if (!client || !db) return false;
  try {
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
