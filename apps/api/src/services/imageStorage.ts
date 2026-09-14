import { randomUUID } from "node:crypto";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config, type AppConfig } from "../config";
import { AppError } from "../middleware/envelope";

// ============================================
// Image Storage (PRD V13 Menu Photo Upload)
// Abstraction over object storage so the S3
// backend is swappable. When S3 credentials are
// absent (dev/test), a deterministic mock is used.
//
// IMAGE-STORAGE-TRUTH-A2: production must never
// fabricate a synthetic CDN URL. When S3 is not
// configured in production the upload fails closed
// (503 IMAGE_STORAGE_UNCONFIGURED) instead of
// silently returning/persisting a mock URL.
// ============================================

export interface ImageStorage {
  upload(
    buffer: Buffer,
    contentType: string,
    key: string,
  ): Promise<string>;
}

export class S3ImageStorage implements ImageStorage {
  private client: S3Client;
  private bucket: string;
  private cdnBaseUrl: string;

  constructor(options: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    cdnBaseUrl?: string;
  }) {
    this.client = new S3Client({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
    this.bucket = options.bucket;
    this.cdnBaseUrl = options.cdnBaseUrl ?? "";
  }

  async upload(
    buffer: Buffer,
    contentType: string,
    key: string,
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    if (this.cdnBaseUrl) {
      return `${this.cdnBaseUrl.replace(/\/$/, "")}/${key}`;
    }
    return `https://${this.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`;
  }
}

export class MockImageStorage implements ImageStorage {
  private uploaded: Array<{ key: string; contentType: string; sizeBytes: number }> = [];

  async upload(
    buffer: Buffer,
    contentType: string,
    key: string,
  ): Promise<string> {
    this.uploaded.push({
      key,
      contentType,
      sizeBytes: buffer.byteLength,
    });
    return `https://cdn.snakzap.in/mock/${key}`;
  }

  /** Test helper: assert which keys were "uploaded" to S3. */
  get uploads() {
    return this.uploaded;
  }

  _reset(): void {
    this.uploaded = [];
  }
}

/**
 * Fail-closed backend used in production when S3 is not fully configured.
 * Guessing is worse than failing: it must never return or persist a
 * synthetic URL, so `upload` throws before the route can persist anything.
 */
export class UnconfiguredImageStorage implements ImageStorage {
  async upload(): Promise<string> {
    throw new AppError(
      "IMAGE_STORAGE_UNCONFIGURED",
      "Menu photo storage is not configured for this environment",
      503,
    );
  }
}

/** Complete S3 config mirrors what `S3ImageStorage` needs to sign a PUT. */
function isS3Configured(s3: AppConfig["s3"]): boolean {
  return Boolean(s3.bucket && s3.accessKeyId && s3.secretAccessKey);
}

/**
 * Picks the object storage backend:
 * - S3 credentials present            => S3ImageStorage
 * - production + incomplete config    => UnconfiguredImageStorage (fails closed)
 * - non-production + absent config    => MockImageStorage (dev/test only)
 */
export function createImageStorage(): ImageStorage {
  const { bucket, region, accessKeyId, secretAccessKey, cdnBaseUrl } =
    config.s3;
  if (isS3Configured(config.s3)) {
    return new S3ImageStorage({
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      cdnBaseUrl,
    });
  }
  if (config.env === "production") {
    return new UnconfiguredImageStorage();
  }
  return new MockImageStorage();
}

export function buildMenuPhotoKey(
  restaurantId: string,
  itemId: string,
  ext: string,
): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  return `menu/${restaurantId}/${itemId}/${randomUUID()}.${safeExt}`;
}

export const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
