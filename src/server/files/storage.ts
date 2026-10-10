/**
 * Object storage for PDFs. `s3` works with any S3-compatible service; `local` stores files on
 * disk (single-server deployments and tests). Files are never publicly readable: the app
 * streams them to authorized users.
 */
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/server/env";

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  contentRange?: string;
  totalSize: number;
  partial: boolean;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string, range?: ByteRange): Promise<StoredObject>;
  getBytes(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

class S3Storage implements Storage {
  private client: S3Client;
  private bucketReady: Promise<void> | null = null;

  constructor(
    private readonly bucket: string,
    private readonly autoCreate: boolean,
  ) {
    const e = env();
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  private ensureBucket() {
    if (!this.autoCreate) return Promise.resolve();
    this.bucketReady ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((err: unknown) => {
          const name = (err as { name?: string }).name;
          if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
        });
      }
    })().catch((err) => {
      this.bucketReady = null;
      throw err;
    });
    return this.bucketReady;
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject> {
    await this.ensureBucket();
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ""}` : undefined,
      }),
    );
    const contentLength = res.ContentLength ?? 0;
    const total = res.ContentRange ? Number(res.ContentRange.split("/")[1]) : contentLength;
    return {
      body: res.Body!.transformToWebStream() as ReadableStream<Uint8Array>,
      contentLength,
      contentRange: res.ContentRange,
      totalSize: total,
      partial: !!range,
    };
  }

  async getBytes(key: string) {
    await this.ensureBucket();
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body!.transformToByteArray();
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return resolved;
  }

  async put(key: string, body: Uint8Array) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string, range?: ByteRange): Promise<StoredObject> {
    const file = this.file(key);
    const { size } = await stat(file);
    const start = range?.start ?? 0;
    const end = Math.min(range?.end ?? size - 1, size - 1);
    const stream = createReadStream(file, { start, end });
    return {
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      contentLength: end - start + 1,
      contentRange: range ? `bytes ${start}-${end}/${size}` : undefined,
      totalSize: size,
      partial: !!range,
    };
  }

  async getBytes(key: string) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(this.file(key)));
  }

  async delete(key: string) {
    await rm(this.file(key), { force: true });
  }
}

let instance: Storage | undefined;

export function storage(): Storage {
  if (!instance) {
    const e = env();
    instance =
      e.STORAGE_DRIVER === "local"
        ? new LocalStorage(path.resolve(e.STORAGE_LOCAL_DIR))
        : new S3Storage(e.S3_BUCKET, e.S3_AUTO_CREATE_BUCKET);
  }
  return instance;
}

/** Parses a single-range HTTP Range header ("bytes=0-1023"). */
export function parseRange(header: string | null, size?: number): ByteRange | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1] && size !== undefined) {
    const suffix = Number(m[2]);
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  if (!m[1]) return undefined;
  return { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
}
