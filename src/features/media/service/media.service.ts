import * as MediaRepo from "@/features/media/data/media.data";
import * as Storage from "@/features/media/data/media.storage";
import type {
  GetMediaListInput,
  MediaInvalidDetail,
  UpdateMediaNameInput,
} from "@/features/media/media.schema";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_FILE_SIZE,
} from "@/features/media/media.schema";
import { getImageDimensions } from "@/features/media/utils/image-dimensions";
import { matchesDeclaredImageType } from "@/features/media/utils/image-signature";
import {
  cleanMediaName,
  getContentTypeFromKey,
  getOriginalImageUrl,
  getTransformSourceUrl,
  importedMediaName,
  imageExtensionOf,
  isSameImageType,
  parseImageTransform,
  isGifKey,
} from "@/features/media/utils/media.utils";
import { purgeWorkersCache } from "@/features/cache/workers-cache";
import { mediaPurgeTarget } from "@/features/cache/workers-cache-policy";
import * as PostMediaRepo from "@/features/posts/data/post-media.data";
import { CACHE_CONTROL } from "@/lib/constants";
import { fetchPublicUrl } from "@/lib/http/public-fetch";
import { err, ok } from "@/lib/errors";

function mediaInvalid(detail: MediaInvalidDetail) {
  return err({ reason: "MEDIA_INVALID" as const, detail });
}

export async function upload(
  context: DbContext & { executionCtx: ExecutionContext },
  input: { file: File },
) {
  const { file } = input;

  const buffer = await file.arrayBuffer();
  if (!matchesDeclaredImageType(buffer, file.type)) {
    return mediaInvalid("TYPE_MISMATCH");
  }
  const dimensions = getImageDimensions(buffer);
  const width = dimensions?.width;
  const height = dimensions?.height;

  // 图片存储走免费图床链（替换 R2），返回的 key/url 即图床公开 URL
  const uploaded = await Storage.uploadImage(context.env, file);

  try {
    const mediaRecord = await MediaRepo.insertMedia(context.db, {
      key: uploaded.key,
      url: uploaded.url,
      fileName:
        cleanMediaName(uploaded.fileName) ||
        `image.${imageExtensionOf(uploaded.mimeType)}`,
      mimeType: uploaded.mimeType,
      sizeInBytes: uploaded.sizeInBytes,
      width,
      height,
    });
    return ok(mediaRecord);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "media db insert failed, rolling back upload",
        key: uploaded.key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    context.executionCtx.waitUntil(
      Storage.deleteImageStorage(context.env, uploaded.key).catch(
        (rollbackError) =>
          console.error(
            JSON.stringify({
              message: "upload rollback delete failed",
              key: uploaded.key,
              error:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            }),
          ),
      ),
    );
    return err({ reason: "MEDIA_RECORD_CREATE_FAILED" });
  }
}

export async function deleteImage(
  context: DbContext & { executionCtx: ExecutionContext },
  key: string,
) {
  // The in-use check is part of the delete, so a Post saved meanwhile with
  // the image either makes it refuse or is refused itself.
  if (!(await MediaRepo.deleteMediaIfUnused(context.db, key))) {
    return (await MediaRepo.findMediaByKey(context.db, key))
      ? err({ reason: "MEDIA_IN_USE" })
      : err({ reason: "MEDIA_NOT_FOUND" });
  }
  context.executionCtx.waitUntil(
    Storage.deleteImageStorage(context.env, key).catch((deleteError) =>
      console.error(
        JSON.stringify({
          message: "image delete failed",
          key,
          error:
            deleteError instanceof Error
              ? deleteError.message
              : String(deleteError),
        }),
      ),
    ),
  );

  return ok({ success: true });
}

export async function getMediaList(
  context: DbContext,
  data: GetMediaListInput,
) {
  return await MediaRepo.getMediaList(context.db, data);
}

export async function isMediaInUse(context: DbContext, key: string) {
  return await PostMediaRepo.isMediaInUse(context.db, key);
}

export async function getLinkedPosts(context: DbContext, key: string) {
  return await PostMediaRepo.getPostsByMediaKey(context.db, key);
}

export async function getLinkedMediaKeys(
  context: DbContext,
  keys: Array<string>,
) {
  return await PostMediaRepo.getLinkedMediaKeys(context.db, keys);
}

export async function getTotalMediaSize(context: DbContext) {
  return await MediaRepo.getTotalMediaSize(context.db);
}

export async function getMediaStats(context: DbContext) {
  return await MediaRepo.getMediaStats(context.db);
}

export async function updateMediaName(
  context: DbContext,
  data: UpdateMediaNameInput,
) {
  const renamed = await MediaRepo.updateMediaName(
    context.db,
    data.key,
    data.name,
  );
  if (!renamed) {
    return err({ reason: "MEDIA_NOT_FOUND" });
  }
  return ok(undefined);
}

/**
 * Puts a new file at an existing key. Posts keep naming the key, so their
 * drafts, Public Content Snapshots and Post Revisions are not written: the
 * cached copies of the key are purged instead, and every address of it,
 * public pages and editor alike, serves the new file from then on. The new
 * file must be the same image type: the key's extension and the content type
 * served at it would otherwise disagree.
 *
 * R2 已移除：替换为重新上传到免费图床链，返回新的外部公开 URL。
 */
export async function replaceImage(
  context: DbContext & { executionCtx: ExecutionContext },
  input: { key: string; file: File },
) {
  const existing = await MediaRepo.findMediaByKey(context.db, input.key);
  if (!existing) {
    return err({ reason: "MEDIA_NOT_FOUND" });
  }

  const buffer = await input.file.arrayBuffer();
  if (!matchesDeclaredImageType(buffer, input.file.type)) {
    return mediaInvalid("TYPE_MISMATCH");
  }
  if (!isSameImageType(input.file.type, existing.mimeType)) {
    return mediaInvalid("TYPE_CHANGED");
  }
  const dimensions = getImageDimensions(buffer);
  const uploaded = await Storage.uploadImage(context.env, input.file);
  // 图片走免费图床链，每次返回新的外部公开 URL
  const url = `${uploaded.url}?v=${Date.now()}`;
  const updated = await MediaRepo.updateMediaFile(context.db, input.key, {
    url,
    fileName: cleanMediaName(input.file.name) || existing.fileName,
    mimeType: input.file.type || existing.mimeType,
    sizeInBytes: input.file.size,
    width: dimensions?.width,
    height: dimensions?.height,
  });
  if (!updated) {
    return err({ reason: "MEDIA_NOT_FOUND" });
  }
  await purgeWorkersCache(context.executionCtx, mediaPurgeTarget(input.key));
  return ok(updated);
}

export async function deleteUnused(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  const keys = await MediaRepo.deleteUnusedMedia(context.db);
  for (const key of keys) {
    context.executionCtx.waitUntil(
      Storage.deleteImageStorage(context.env, key).catch((deleteError) =>
        console.error(
          JSON.stringify({
            message: "image delete failed",
            key,
            error:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
          }),
        ),
      ),
    );
  }
  return ok({ count: keys.length });
}

export async function importFromUrl(
  context: DbContext & { executionCtx: ExecutionContext },
  input: { url: string; name?: string },
) {
  const parsed = parseImageUrl(input.url);
  if (!parsed) {
    return err({ reason: "MEDIA_INVALID_URL" });
  }

  // The address, the DNS answers of its name and every redirect must all
  // be on the public internet.
  const fetched = await fetchPublicUrl(parsed, {
    signal: AbortSignal.timeout(15_000),
  });
  if (fetched.error) {
    return fetched.error.reason === "NOT_PUBLIC"
      ? err({ reason: "MEDIA_INVALID_URL" })
      : err({ reason: "MEDIA_IMPORT_FAILED" });
  }
  const response = fetched.data;

  if (!response.ok) {
    return err({ reason: "MEDIA_IMPORT_FAILED" });
  }

  const mime = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ACCEPTED_IMAGE_TYPES.includes(mime)) {
    return mediaInvalid("TYPE_UNRECOGNIZED");
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    return mediaInvalid("EMPTY");
  }
  if (buffer.byteLength > MAX_FILE_SIZE) {
    return mediaInvalid("TOO_LARGE");
  }

  const file = new File(
    [buffer],
    importedMediaName(input.name ?? lastPathPart(parsed), mime),
    { type: mime },
  );
  return upload(context, { file });
}

function parseImageUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/** The last part of the address path, decoded; empty when it has none or is not valid UTF-8 escapes. */
function lastPathPart(url: URL) {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

// An SVG opened at its own address is a document on the site origin. Served
// as a sandboxed document with no script source it cannot run script, and
// nosniff keeps any image from being read as another type. As an <img>, an
// SVG never runs script anyway, so this changes nothing on the site's pages.
const IMAGE_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
} as const;

function withImageHeaders(
  response: Response,
  cacheControl: Record<string, string>,
) {
  for (const [name, value] of Object.entries({
    ...cacheControl,
    ...IMAGE_SECURITY_HEADERS,
  })) {
    response.headers.set(name, value);
  }
  return response;
}

/**
 * R2 存储已移除：用户图片与站点资源均存储在外部免费图床，直接以公开 URL 访问，
 * 不再经过 /images/{key} 代理。若 key 本身是外部 URL，直接重定向；否则 404。
 */
export async function handleImageRequest(
  _env: Env,
  key: string,
  _request: Request,
) {
  if (key.startsWith("http://") || key.startsWith("https://")) {
    return Response.redirect(key, 302);
  }
  return new Response("Image not found", { status: 404 });
}
