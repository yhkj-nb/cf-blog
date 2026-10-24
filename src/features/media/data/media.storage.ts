import { generateKey } from "@/features/media/utils/media.utils";
import {
  type ImageHostConfig,
  type ImageHostDriver,
  parseImageHostConfig,
  resolveChain,
  uploadToImageHost,
} from "./external-image-host";

/**
 * 默认图片存储链（未配置时）：免凭据、开箱即用的免费图床。
 * 这些图床无需任何密钥即可上传，用来替换原本的 R2 存储桶作为用户图片库。
 */
const DEFAULT_DRIVERS: ImageHostDriver[] = ["nature", "xingye", "chatglm"];

export async function putToR2(
  env: Env,
  image: File,
  key = generateKey(image.name),
) {
  const contentType = image.type;
  const url = `/images/${key}`;

  await env.R2.put(key, image.stream(), {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      originalName: image.name,
    },
  });

  return {
    key,
    url,
    fileName: image.name,
    mimeType: contentType,
    sizeInBytes: image.size,
  };
}

export async function deleteFromR2(env: Env, key: string) {
  await env.R2.delete(key);
}

export async function getFromR2(env: Env, key: string) {
  return await env.R2.get(key);
}

/**
 * Upload a site asset (favicon, theme images) to R2 with a fixed key.
 * No DB record; overwrites in place on re-upload.
 * 站点资源仍走 R2（与用户图片库分开存储）。
 */
export async function putSiteAsset(
  env: Env,
  file: File,
  assetPath: string,
): Promise<{ key: string; url: string }> {
  const key = `asset/${assetPath}`;
  await env.R2.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
    },
  });
  return { key, url: `/images/${key}` };
}

// ---------------------------------------------------------------------------
// 免费图床存储（替换 R2 作为用户图片库）
// ---------------------------------------------------------------------------

/**
 * 解析本次上传要使用的图床链与配置。
 * 优先级：IMAGE_HOST_CONFIG(chain) > IMAGE_STORAGE_DRIVER(逗号列表) > 默认免凭据链。
 */
function resolveImageHost(env: Env): {
  drivers: ImageHostDriver[];
  config: ImageHostConfig;
} {
  const envAny = env as unknown as Record<string, string | undefined>;
  const rawDriver = envAny.IMAGE_STORAGE_DRIVER?.trim();
  const rawCfg = envAny.IMAGE_HOST_CONFIG?.trim();

  const parsed = parseImageHostConfig(rawCfg);
  if (parsed) {
    const chain = resolveChain(parsed);
    if (chain.length) return { drivers: chain, config: parsed };
  }
  if (rawDriver) {
    const list = rawDriver
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as ImageHostDriver[];
    if (list.length) return { drivers: list, config: parsed ?? {} };
  }
  // 默认：开箱即用的免费图床，替换 R2 默认存储
  return { drivers: DEFAULT_DRIVERS, config: parsed ?? {} };
}

/**
 * 上传一张图片：按 resolved 图床链依次尝试，前一个失败自动回退下一个。
 * 外部图床返回公开 URL，并同时作为 key 与 url 返回（渲染层对外部 URL 原样透传）。
 * r2 仍可作为链中一环：由 putToR2 处理，返回 {key,url}（key 为 R2 key）。
 */
export async function uploadImage(
  env: Env,
  image: File,
  existingKey?: string,
): Promise<{
  key: string;
  url: string;
  fileName: string;
  mimeType: string;
  sizeInBytes: number;
}> {
  const { drivers, config } = resolveImageHost(env);
  const bytes = new Uint8Array(await image.arrayBuffer());
  let lastErr: unknown;

  for (const d of drivers) {
    try {
      if (d === "r2") {
        const r = await putToR2(env, image, existingKey);
        return r;
      }
      const url = await uploadToImageHost(
        { ...config, driver: d },
        { bytes, filename: image.name, contentType: image.type },
      );
      return {
        key: url,
        url,
        fileName: image.name,
        mimeType: image.type,
        sizeInBytes: image.size,
      };
    } catch (e) {
      lastErr = e;
      console.warn(
        `[image-host] 图床「${d}」上传失败，尝试下一个：${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  throw new Error(
    `所有图片存储后端均上传失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * 删除一张图片存储。外部图床大多无删除接口，仅记日志不真删远端；
 * R2 key（http(s) 以外的，如 uuid.ext 或 /images/xxx）则走 R2 删除兜底。
 */
export async function deleteImageStorage(env: Env, key: string) {
  if (key.startsWith("http://") || key.startsWith("https://")) {
    console.log(`[image-host] 外部图床图片不删除远端：${key}`);
    return;
  }
  const r2key = key.startsWith("/images/") ? key.replace(/^\/images\//, "") : key;
  await deleteFromR2(env, r2key);
}
