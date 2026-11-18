import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A 1x1 grey+alpha PNG that libpng reads with a warning. sharp 0.35 removed the
// `failOnError` constructor option (deprecated since 0.33), so passing it is a
// silent no-op and the default `failOn: "warning"` rejects this image. The ops
// must keep reading slightly malformed inbound images the way 0.34 did.
const PNG_WITH_LIBPNG_WARNING = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
  "base64",
);

// The sharp factory is cached per module with the first budget it sees, so each
// case loads a fresh module to get the budget it names.
async function opsWithBudget(maxInputPixels: number) {
  const { createMediaAttachmentImageOps } = await import("./image-ops.js");
  return createMediaAttachmentImageOps({ maxInputPixels });
}

describe("createMediaAttachmentImageOps", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resizes an image libpng reads only with a warning", async () => {
    const ops = await opsWithBudget(1_000_000);

    const png = await ops.resizeToPng({ buffer: PNG_WITH_LIBPNG_WARNING, maxSide: 2048 });
    const jpeg = await ops.resizeToJpeg({
      buffer: PNG_WITH_LIBPNG_WARNING,
      maxSide: 2048,
      quality: 80,
    });

    expect((await sharp(png).metadata()).format).toBe("png");
    expect((await sharp(jpeg).metadata()).format).toBe("jpeg");
  });

  it("still refuses an image over the pixel budget", async () => {
    const ops = await opsWithBudget(4);
    const large = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    await expect(ops.resizeToPng({ buffer: large, maxSide: 2048 })).rejects.toThrow(/pixel limit/i);
  });
});
