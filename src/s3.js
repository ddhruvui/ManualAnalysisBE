// READ-ONLY access to the RunPod network volume. Only List/Head/Get commands may be
// imported here — this project must never write to or delete from the volume.
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { config } from './config.js';

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: true,
  // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment.
  // S3-compatible stores often reject the SDK's newer default checksum headers.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const Bucket = config.s3.bucket;

// For bucket-level calls the SDK requests "/<bucket>/", which RunPod rejects with
// "InvalidArgument: Invalid object path" (the AWS CLI sends "/<bucket>" and works).
// Runs in the build step, i.e. before the request is signed.
client.middlewareStack.add(
  (next) => async (args) => {
    const { request } = args;
    if (request?.path === `/${Bucket}/`) request.path = `/${Bucket}`;
    return next(args);
  },
  { step: 'build', name: 'runpodStripBucketTrailingSlash' },
);

export function isNotFound(err) {
  const status = err?.$metadata?.httpStatusCode;
  return status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey';
}

function objectInfo(res) {
  return {
    etag: res.ETag ? res.ETag.replaceAll('"', '') : null,
    size: res.ContentLength ?? null,
    lastModified: res.LastModified ? res.LastModified.toISOString() : null,
  };
}

export async function headObject(key) {
  return objectInfo(await client.send(new HeadObjectCommand({ Bucket, Key: key })));
}

/** Whole object as a byte stream (async iterable of Buffers). */
export async function getObjectStream(key) {
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  return { ...objectInfo(res), body: res.Body };
}

/** Last `bytes` bytes of an object. */
export async function getObjectTail(key, bytes) {
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=-${bytes}` }));
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function getObjectJson(key) {
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  return JSON.parse(await res.Body.transformToString('utf8'));
}

/** Direct children (files only) under a prefix. */
export async function listObjects(prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket, Prefix: prefix, Delimiter: '/', ContinuationToken }),
    );
    for (const o of res.Contents ?? []) {
      out.push({
        key: o.Key,
        size: o.Size,
        lastModified: o.LastModified ? o.LastModified.toISOString() : null,
      });
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}
