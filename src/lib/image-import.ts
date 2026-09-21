/**
 * Pasted/dropped raster-image ingestion - decode, downscale, re-encode.
 *
 * Large images land in the document's content-addressed asset registry
 * (lib/doc-assets.ts) rather than inline in the shape's `src`, so the
 * budget here is PER IMAGE, not per document: hosts that transport docs
 * through size-capped channels strip the registry out and ship each
 * payload separately. The budgets below therefore optimize for fidelity
 * first - a Retina screenshot embeds pixel-exact - while still refusing
 * inputs big enough to hurt the editor itself (decode time, canvas
 * memory, the localStorage session backup).
 */

/** Hard ceiling on the RAW input we're willing to decode at all. Above this
 *  we refuse rather than risk multi-second decodes of arbitrary files.
 *  Matches the 20 MB per-asset cap enforced by cloud hosts, so an image
 *  the editor accepts is one the cloud can store. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Longest edge after import. 4096px keeps a full-frame Retina capture
 *  crisp at high zoom; anything larger downsamples. */
const MAX_EDGE_PX = 4096;

/** Ceiling for the ENCODED data URL of ONE image. Per-image (see module
 *  header) - sized so even a handful of dense screenshots keeps the
 *  in-memory doc and its session backup manageable. */
const DATA_URL_BUDGET = 8_000_000;

/** Originals at or below this raw size embed untouched when their pixels
 *  also fit MAX_EDGE_PX - base64 of 4 MB is ~5.4 MB, inside the budget -
 * keeping screenshots pixel-exact instead of lossy. */
const RAW_PASSTHROUGH_BYTES = 4_000_000;

export interface ImportedImage {
  dataUrl: string;
  /** Pixel dimensions of the encoded image. */
  w: number;
  h: number;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Dimensions of an already-encoded image, with a safe fallback for sources
 *  the <img> decoder rejects (mirrors the old Canvas-local imageDims). */
function dataUrlDims(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 320, h: 240 });
    img.src = src;
  });
}

/** Sample the bitmap at thumbnail size and report whether any pixel is
 *  meaningfully transparent. Scaling opaque pixels never introduces alpha,
 *  so a 64×64 probe is enough and avoids a full-resolution getImageData. */
function probeAlpha(bitmap: ImageBitmap): boolean {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  if (!ctx) return true; // can't tell - assume alpha, the safe direction
  ctx.drawImage(bitmap, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

/**
 * Turn a pasted/dropped image file into an embeddable data URL within the
 * document's size budget, downscaling and re-encoding as needed.
 *
 * - Small originals embed untouched (pixel-exact, keeps PNG alpha).
 * - SVG stays vector and GIF stays animated: embedded verbatim when they
 *   fit the budget, refused otherwise - a canvas re-encode would destroy
 *   what makes them those formats.
 * - Everything else re-encodes at ≤ MAX_EDGE_PX: JPEG when opaque, WebP
 *   when transparent (with a PNG fallback on browsers that can't encode
 *   WebP), stepping down quality then scale until it fits.
 *
 * Throws with a human-readable message when the image can't be brought
 * under the budget; callers surface that to the user.
 *
 * Accepts any Blob (only `size` and `type` are read) so importers that
 * hold image bytes without a File - e.g. decoded data URLs - can reuse
 * the same pipeline.
 */
export async function importImageFile(file: Blob): Promise<ImportedImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${(file.size / 1024 / 1024).toFixed(1)} MiB > ${MAX_IMAGE_BYTES / 1024 / 1024} MiB)`,
    );
  }

  const keepVerbatim =
    file.type === 'image/svg+xml' || file.type === 'image/gif';
  const bitmap = keepVerbatim
    ? null
    : await createImageBitmap(file).catch(() => null);

  if (!bitmap) {
    // Vector / animated / undecodable: verbatim or nothing. Base64 inflates
    // by 4/3, so gate on the projected encoded size.
    if ((file.size * 4) / 3 <= DATA_URL_BUDGET) {
      const dataUrl = await readAsDataUrl(file);
      const dims = await dataUrlDims(dataUrl);
      return { dataUrl, ...dims };
    }
    throw new Error(
      `${file.type || 'image'} cannot be embedded within the size budget without re-encoding`,
    );
  }

  try {
    const { width, height } = bitmap;
    if (
      file.size <= RAW_PASSTHROUGH_BYTES &&
      width <= MAX_EDGE_PX &&
      height <= MAX_EDGE_PX
    ) {
      return { dataUrl: await readAsDataUrl(file), w: width, h: height };
    }

    const hasAlpha = file.type !== 'image/jpeg' && probeAlpha(bitmap);

    let scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
    for (let attempt = 0; attempt < 4; attempt++, scale *= 0.7) {
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(width * scale));
      cv.height = Math.max(1, Math.round(height * scale));
      const ctx = cv.getContext('2d');
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, cv.width, cv.height);
      for (const q of [0.82, 0.7, 0.58]) {
        const dataUrl = hasAlpha
          ? cv.toDataURL('image/webp', q)
          : cv.toDataURL('image/jpeg', q);
        if (dataUrl.length <= DATA_URL_BUDGET) {
          return { dataUrl, w: cv.width, h: cv.height };
        }
        // Browsers without WebP encoding (Safari) silently return PNG,
        // which ignores the quality knob - retrying q is pointless, only
        // shrinking helps. Skip straight to the next scale step.
        if (hasAlpha && !dataUrl.startsWith('data:image/webp')) break;
      }
    }
    throw new Error('image could not be compressed under the embed budget');
  } finally {
    bitmap.close();
  }
}

/**
 * Bring an already-encoded data URL within the embed budget. Importers
 * (Excalidraw) receive images as verbatim data URLs rather than Files;
 * one already within budget passes through byte-exact - no fidelity loss
 * for images that were never the problem - while anything larger is
 * decoded to a Blob and run through the same downscale/re-encode pipeline
 * as a pasted file. Throws (like `importImageFile`) when the image can't
 * be brought under budget, or when the data URL is malformed.
 */
export async function importImageDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.length <= DATA_URL_BUDGET) return dataUrl;
  const { dataUrl: reencoded } = await importImageFile(dataUrlToBlob(dataUrl));
  return reencoded;
}

/** Decode a data: URL into a Blob so the pipeline can treat it like a
 *  dropped file. Throws on malformed input (missing comma, bad base64). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('malformed data URL');
  const header = dataUrl.slice(0, comma); // `data:image/png;base64`
  const mime = header.slice('data:'.length).split(';')[0] || 'image/png';
  const body = dataUrl.slice(comma + 1);
  if (/;base64$/i.test(header)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  // Not base64 - percent-encoded text (typically SVG).
  return new Blob([decodeURIComponent(body)], { type: mime });
}
