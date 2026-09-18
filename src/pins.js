// Pinned tickers, stored in MongoDB so they follow the user across browsers and devices
// (unlike the local SQLite index, which is a disposable cache of the volume).
//
// One document per pinned ticker — `{_id: "GOOG", pinnedAt}` — so pinning and unpinning
// are single-document operations with no read-modify-write race between devices.
//
// The connection string holds a password and must never reach logs or the frontend.
import { MongoClient } from 'mongodb';
import { config } from './config.js';

export class PinsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const pinsEnabled = () => Boolean(config.mongo.uri);

let clientPromise = null;

/** Mongo's connection errors are long and can echo the URI; keep the actionable part. */
function connectionFailed(err) {
  const first = String(err?.message ?? err).split('\n')[0].slice(0, 200);
  const redacted = first.replace(/mongodb(\+srv)?:\/\/[^\s,]*/gi, 'the configured cluster');
  return new PinsError(`Cannot reach the pins database: ${redacted}`, 503);
}

async function pins() {
  if (!config.mongo.uri) {
    throw new PinsError('Pinned tickers need MongoDB — set MONGO_URI in backend/.env', 503);
  }
  clientPromise ??= new MongoClient(config.mongo.uri, {
    serverSelectionTimeoutMS: config.mongo.connectTimeoutMs,
    connectTimeoutMS: config.mongo.connectTimeoutMs,
  })
    .connect()
    .catch((err) => {
      clientPromise = null; // let the next request retry instead of caching the failure
      throw connectionFailed(err);
    });

  const client = await clientPromise;
  return client.db(config.mongo.dbName).collection(config.mongo.pinsCollection);
}

async function run(operation) {
  const collection = await pins();
  try {
    return await operation(collection);
  } catch (err) {
    if (err instanceof PinsError) throw err;
    throw connectionFailed(err);
  }
}

const readAll = async (c) =>
  (await c.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map((d) => d._id);

/** Every pinned ticker, alphabetically. Mutations return the new list so clients stay in step. */
export function listPins() {
  return run(readAll);
}

export function addPin(ticker) {
  return run(async (c) => {
    await c.updateOne({ _id: ticker }, { $setOnInsert: { pinnedAt: new Date() } }, { upsert: true });
    return readAll(c);
  });
}

export function removePin(ticker) {
  return run(async (c) => {
    await c.deleteOne({ _id: ticker });
    return readAll(c);
  });
}

/** For /api/health — never throws. */
export async function pinsStatus() {
  if (!pinsEnabled()) return { enabled: false, reachable: false };
  try {
    const count = await run((c) => c.countDocuments());
    return { enabled: true, reachable: true, count, database: config.mongo.dbName };
  } catch (err) {
    return { enabled: true, reachable: false, error: err.message };
  }
}

export async function closePins() {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  await pending.then((client) => client.close()).catch(() => {});
}
