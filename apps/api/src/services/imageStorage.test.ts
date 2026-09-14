import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================
// IMAGE-STORAGE-TRUTH-A2
// Production must never fabricate or persist a
// synthetic mock CDN URL. When S3 is incomplete
// in production, upload must fail closed instead.
// dev/test keep the deterministic mock.
// ============================================

const COMPLETE_S3 = {
  S3_BUCKET: "snakzap-test-bucket",
  S3_ACCESS_KEY_ID: "test-access-key",
  S3_SECRET_ACCESS_KEY: "test-secret-key",
  S3_REGION: "ap-south-1",
};

const INCOMPLETE_S3 = {
  S3_BUCKET: "",
  S3_ACCESS_KEY_ID: "",
  S3_SECRET_ACCESS_KEY: "",
  S3_REGION: "ap-south-1",
};

type LoadedImageStorage = typeof import("./imageStorage");
type LoadedEnvelope = typeof import("../middleware/envelope");

/**
 * `config` is snapshotted at module import, so each case resets the module
 * registry and re-imports under stubbed env. This keeps cases isolated and
 * never depends on the developer machine's AWS/S3 environment.
 */
async function loadImageStorage(
  env: Record<string, string>,
): Promise<LoadedImageStorage & { AppError: LoadedEnvelope["AppError"] }> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const mod = await import("./imageStorage");
  const envelope = await import("../middleware/envelope");
  return { ...mod, AppError: envelope.AppError };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("IMAGE-STORAGE-TRUTH-A2 backend selection", () => {
  it("T1: production + complete S3 selects S3ImageStorage", async () => {
    const { createImageStorage, S3ImageStorage } = await loadImageStorage({
      NODE_ENV: "production",
      ...COMPLETE_S3,
    });
    expect(createImageStorage()).toBeInstanceOf(S3ImageStorage);
  });

  it("T2: production + missing bucket fails closed", async () => {
    const { createImageStorage, UnconfiguredImageStorage } =
      await loadImageStorage({
        NODE_ENV: "production",
        ...INCOMPLETE_S3,
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
      });
    expect(createImageStorage()).toBeInstanceOf(UnconfiguredImageStorage);
  });

  it("T3: production + missing accessKeyId fails closed", async () => {
    const { createImageStorage, UnconfiguredImageStorage } =
      await loadImageStorage({
        NODE_ENV: "production",
        ...INCOMPLETE_S3,
        S3_BUCKET: "b",
        S3_SECRET_ACCESS_KEY: "s",
      });
    expect(createImageStorage()).toBeInstanceOf(UnconfiguredImageStorage);
  });

  it("T4: production + missing secretAccessKey fails closed", async () => {
    const { createImageStorage, UnconfiguredImageStorage } =
      await loadImageStorage({
        NODE_ENV: "production",
        ...INCOMPLETE_S3,
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
      });
    expect(createImageStorage()).toBeInstanceOf(UnconfiguredImageStorage);
  });

  it("T5: production incomplete config never selects MockImageStorage", async () => {
    const { createImageStorage, MockImageStorage } = await loadImageStorage({
      NODE_ENV: "production",
      ...INCOMPLETE_S3,
    });
    expect(createImageStorage()).not.toBeInstanceOf(MockImageStorage);
  });

  it("T6: fail-closed upload throws IMAGE_STORAGE_UNCONFIGURED", async () => {
    const { createImageStorage, AppError } = await loadImageStorage({
      NODE_ENV: "production",
      ...INCOMPLETE_S3,
    });
    const error = await createImageStorage()
      .upload(Buffer.from("x"), "image/jpeg", "menu/a/b/c.jpg")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as { code: string }).code).toBe("IMAGE_STORAGE_UNCONFIGURED");
  });

  it("T7: fail-closed status is 503", async () => {
    const { createImageStorage } = await loadImageStorage({
      NODE_ENV: "production",
      ...INCOMPLETE_S3,
    });
    await expect(
      createImageStorage().upload(
        Buffer.from("x"),
        "image/jpeg",
        "menu/a/b/c.jpg",
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("T8: test env + incomplete config still selects MockImageStorage", async () => {
    const { createImageStorage, MockImageStorage } = await loadImageStorage({
      NODE_ENV: "test",
      ...INCOMPLETE_S3,
    });
    expect(createImageStorage()).toBeInstanceOf(MockImageStorage);
  });

  it("T9: non-production mock still returns the synthetic test URL", async () => {
    const { createImageStorage } = await loadImageStorage({
      NODE_ENV: "development",
      ...INCOMPLETE_S3,
    });
    const url = await createImageStorage().upload(
      Buffer.from("x"),
      "image/jpeg",
      "menu/a/b/c.jpg",
    );
    expect(url).toBe("https://cdn.snakzap.in/mock/menu/a/b/c.jpg");
  });

  it("T10: non-production + complete config preserves real S3 selection", async () => {
    const { createImageStorage, S3ImageStorage } = await loadImageStorage({
      NODE_ENV: "test",
      ...COMPLETE_S3,
    });
    expect(createImageStorage()).toBeInstanceOf(S3ImageStorage);
  });

  it("T11: real S3 upload behavior unchanged (mocked transport)", async () => {
    const { S3ImageStorage } = await loadImageStorage({
      NODE_ENV: "test",
      ...COMPLETE_S3,
    });

    const storage = new S3ImageStorage({
      bucket: "my-bucket",
      region: "ap-south-1",
      accessKeyId: "a",
      secretAccessKey: "b",
      cdnBaseUrl: "https://cdn.example.com/",
    });
    const send = vi.fn().mockResolvedValue({});
    (storage as unknown as { client: { send: unknown } }).client = { send };

    const url = await storage.upload(
      Buffer.from("hello"),
      "image/jpeg",
      "menu/r/i/x.jpg",
    );
    expect(url).toBe("https://cdn.example.com/menu/r/i/x.jpg");
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as {
      input: Record<string, unknown>;
    };
    expect(command.input.Bucket).toBe("my-bucket");
    expect(command.input.Key).toBe("menu/r/i/x.jpg");
    expect(command.input.ContentType).toBe("image/jpeg");
    expect(command.input.CacheControl).toBe(
      "public, max-age=31536000, immutable",
    );

    const bare = new S3ImageStorage({
      bucket: "my-bucket",
      region: "ap-south-1",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    (bare as unknown as { client: { send: unknown } }).client = {
      send: vi.fn().mockResolvedValue({}),
    };
    expect(
      await bare.upload(
        Buffer.from("hello"),
        "image/png",
        "menu/r/i/y.png",
      ),
    ).toBe("https://my-bucket.s3.ap-south-1.amazonaws.com/menu/r/i/y.png");
  });

  it("T12: upload failure happens before any catalog persistence", async () => {
    const { createImageStorage } = await loadImageStorage({
      NODE_ENV: "production",
      ...INCOMPLETE_S3,
    });
    const storage = createImageStorage();
    const updateImageUrl = vi.fn(
      async (_id: string, _url: string) => undefined,
    );

    // Mirrors the frozen route order: await upload(...) then persist.
    const persistFlow = async (): Promise<void> => {
      const url = await storage.upload(
        Buffer.from("x"),
        "image/jpeg",
        "menu/a/b/c.jpg",
      );
      await updateImageUrl("item-1", url);
    };

    await expect(persistFlow()).rejects.toMatchObject({
      code: "IMAGE_STORAGE_UNCONFIGURED",
      status: 503,
    });
    expect(updateImageUrl).not.toHaveBeenCalled();
  });

  it("T13: existing MIME allowlist and key generation are unchanged", async () => {
    const { ALLOWED_IMAGE_MIME, buildMenuPhotoKey } = await loadImageStorage({
      NODE_ENV: "test",
      ...INCOMPLETE_S3,
    });
    expect([...ALLOWED_IMAGE_MIME].sort()).toEqual([
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    const key = buildMenuPhotoKey(
      "a0000000-0000-4000-8000-000000000001",
      "b0000000-0000-4000-8000-000000000001",
      "../../weird.ext!",
    );
    expect(key).toMatch(
      /^menu\/a0000000-0000-4000-8000-000000000001\/b0000000-0000-4000-8000-000000000001\/[0-9a-f-]+\.weirdext$/,
    );
  });

  it("T14: production incomplete config never yields a mock URL", async () => {
    const { createImageStorage } = await loadImageStorage({
      NODE_ENV: "production",
      ...INCOMPLETE_S3,
    });
    const error = await createImageStorage()
      .upload(Buffer.from("x"), "image/jpeg", "menu/a/b/c.jpg")
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    expect(error?.code).toBe("IMAGE_STORAGE_UNCONFIGURED");
  });
});
