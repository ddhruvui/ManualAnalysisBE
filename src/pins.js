// Pinned tickers, stored in MongoDB so they follow the user across browsers and devices
// (unlike the local SQLite index, which is a disposable cache of the volume).
//
// One document per pinned ticker — `{_id: "GOOG", pinnedAt}` — so pinning and unpinning
// are single-document operations with no read-modify-write race between devices.
//
import { config } from './config.js';
import { mongoDb, mongoEnabled, redactMongoError } from './mongo.js';

export class PinsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const pinsEnabled = mongoEnabled;

function connectionFailed(err) {
  return new PinsError(`Cannot reach the pins database: ${redactMongoError(err)}`, 503);
}

async function pins() {
  if (!pinsEnabled()) {
    throw new PinsError('Pinned tickers need MongoDB — set MONGO_URI in backend/.env', 503);
  }
  try {
    return (await mongoDb()).collection(config.mongo.pinsCollection);
  } catch (err) {
    throw connectionFailed(err);
  }
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
