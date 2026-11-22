// One MongoDB Atlas client per process, shared by everything that keeps small documents
// there (pinned tickers, the ticker catalog snapshot). Article content never goes here.
//
// The connection string holds a password and must never reach logs or the frontend.
import { MongoClient } from 'mongodb';
import { config } from './config.js';

export class MongoUnavailableError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

export const mongoEnabled = () => Boolean(config.mongo.uri);

let clientPromise = null;

/** Mongo's connection errors are long and can echo the URI; keep the actionable part. */
export function redactMongoError(err) {
  const first = String(err?.message ?? err).split('\n')[0].slice(0, 200);
  return first.replace(/mongodb(\+srv)?:\/\/[^\s,]*/gi, 'the configured cluster');
}

/** The configured database; throws MongoUnavailableError when unset or unreachable. */
export async function mongoDb() {
  if (!config.mongo.uri) {
    throw new MongoUnavailableError('MongoDB is not configured — set MONGO_URI in backend/.env');
  }
  clientPromise ??= new MongoClient(config.mongo.uri, {
    serverSelectionTimeoutMS: config.mongo.connectTimeoutMs,
    connectTimeoutMS: config.mongo.connectTimeoutMs,
  })
    .connect()
    .catch((err) => {
      clientPromise = null; // let the next request retry instead of caching the failure
      throw new MongoUnavailableError(`Cannot reach MongoDB: ${redactMongoError(err)}`);
    });
  return (await clientPromise).db(config.mongo.dbName);
}

export async function closeMongo() {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  await pending.then((client) => client.close()).catch(() => {});
}
