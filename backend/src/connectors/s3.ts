// src/connectors/s3.ts
// S3 connector: lists objects in a bucket (supports MinIO / non-AWS).
// Uses inline SigV4 signing — no AWS SDK dependency.
// Spec 2 Plan 2-B Track A.

import { createHash, createHmac } from 'node:crypto';
import type { S3ConnectorConfig } from '../types/connectors';
import type { Connector, DecryptedSecret, DryRunResult, FetchedRecord } from './types';
import { ConnectorError } from './types';
import { errorToDryRunError, takeAsyncIter } from './_helpers';
import { safeFetch, SsrfBlockedError } from '../utils/ssrf-guard';

// ----- Inline SigV4 signer --------------------------------------------------

function hash(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function signRequest(args: {
  method: string;
  url: URL;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  body: string;
}): Record<string, string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders =
    `host:${args.url.host}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';

  const payloadHash = hash(args.body);
  const canonicalQueryString = args.url.searchParams.toString();

  const canonicalRequest = [
    args.method,
    args.url.pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hash(canonicalRequest),
  ].join('\n');

  const signature = createHmac('sha256', signingKey(args.secretAccessKey, dateStamp, args.region, args.service))
    .update(stringToSign)
    .digest('hex');

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    Authorization: authorization,
    'x-amz-date': amzDate,
    Host: args.url.host,
  };
}

// ----- Simple XML extraction ------------------------------------------------

function extractXmlValues(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 'gs');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) results.push(m[1]);
  }
  return results;
}

// ----- Connector ------------------------------------------------------------

interface S3SecretJson {
  access_key_id: string;
  secret_access_key: string;
}

export const s3Connector: Connector = {
  async *fetch(
    config: unknown,
    secret: DecryptedSecret | null,
  ): AsyncGenerator<FetchedRecord> {
    const cfg = config as S3ConnectorConfig;

    if (!secret?.value) {
      throw new ConnectorError('MISSING_SECRET', 's3 connector requires a secret');
    }

    let creds: S3SecretJson;
    try {
      creds = JSON.parse(secret.value) as S3SecretJson;
      if (!creds.access_key_id || !creds.secret_access_key) throw new Error('missing fields');
    } catch (err) {
      throw new ConnectorError(
        'INVALID_SECRET',
        's3 secret must be JSON with {access_key_id, secret_access_key}',
        err,
      );
    }

    const region = cfg.region ?? 'us-east-1';
    const endpoint = cfg.endpoint ?? `https://s3.${region}.amazonaws.com`;
    const maxObjects = cfg.max_objects ?? 100;
    let fetched = 0;
    let continuationToken: string | undefined;

    while (fetched < maxObjects) {
      const url = new URL(`/${cfg.bucket}`, endpoint);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('max-keys', String(Math.min(1000, maxObjects - fetched)));
      if (cfg.prefix) url.searchParams.set('prefix', cfg.prefix);
      if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

      const headers = signRequest({
        method: 'GET',
        url,
        accessKeyId: creds.access_key_id,
        secretAccessKey: creds.secret_access_key,
        region,
        service: 's3',
        body: '',
      });

      let response: Response;
      try {
        // H2: the endpoint is user-set. safeFetch runs assertPublicUrl BEFORE
        // the request, and maxRedirects: 0 refuses any redirect — the signed
        // headers must never be replayed to another host.
        response = await safeFetch(url.toString(), { method: 'GET', headers }, { maxRedirects: 0 });
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          // A config problem, never a reachability result (no existence oracle).
          throw new ConnectorError('CONFIG_MISMATCH', err.message, err);
        }
        throw new ConnectorError(
          'UPSTREAM_UNREACHABLE',
          `Cannot reach S3 endpoint: ${endpoint}`,
          err,
        );
      }

      if (!response.ok) {
        // H2: status code only — the upstream body is never relayed (an
        // internal service's error page is exactly what an attacker wants).
        throw new ConnectorError(
          'UPSTREAM_ERROR',
          `S3 ListObjectsV2 returned HTTP ${response.status}`,
        );
      }

      const xml = await response.text();
      const keys = extractXmlValues(xml, 'Key');
      const etags = extractXmlValues(xml, 'ETag').map((e) =>
        e.replace(/&quot;/g, '"').replace(/"/g, ''),
      );

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!key) continue;
        const etag = etags[i] ?? key;
        yield {
          stable_id: etag,
          raw: { key, etag: etags[i]?.replace(/&quot;/g, '"').replace(/"/g, '') ?? etag },
        };
        fetched++;
        if (fetched >= maxObjects) return;
      }

      // Check for truncation
      const truncated = extractXmlValues(xml, 'IsTruncated')[0];
      if (truncated?.toLowerCase() !== 'true') break;
      const nextToken = extractXmlValues(xml, 'NextContinuationToken')[0];
      if (!nextToken) break;
      continuationToken = nextToken;
    }
  },

  async dryRun(config, secret): Promise<DryRunResult> {
    try {
      const sample = await takeAsyncIter(this.fetch(config, secret), 3);
      return { ok: true, sample_count: sample.length, sample };
    } catch (err) {
      return { ok: false, error: errorToDryRunError(err) };
    }
  },
};
