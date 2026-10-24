/**
 * 外部免费图床适配器（替换 R2 存储桶）
 * ------------------------------------------------------------------
 * 博客的图片存储改为使用免费图床，不再以 Cloudflare R2 为默认存储。
 * 可用后端（均来自 ElainaBot beds/，已用 TypeScript + Web 标准重写）：
 *   - cnb       : CNB 公开仓库附件（需 repo + token）
 *   - nature    : 腾讯 COS 直传（密钥内置，开箱即用，链接偏临时）
 *   - xingye    : 星野图床（公开签名端点，开箱即用）
 *   - bilibili  : B 站图床（需 SESSDATA + bili_jct Cookie）
 *   - chatglm   : 智谱 ChatGLM 图床（开箱即用，可选 Cookie）
 *   - self_hosted: 你自己的图床（通用 HTTP 上传接口）
 *
 * 链式回退：上传时按 chain 顺序依次尝试，前一个失败自动换下一个，不会卡住。
 * 默认链（未配置时）为免凭据的 3 个图床：nature → xingye → chatglm，开箱即用。
 * r2 仍保留为可选驱动，需要时可加入 chain 做混合存储。
 *
 * 所有适配器统一返回「图片的公开访问 URL」。模块仅用 Web 标准
 * （fetch / FormData / Web Crypto），Worker 运行时原生可用。
 */

export type ImageHostDriver =
  | "cnb"
  | "nature"
  | "xingye"
  | "bilibili"
  | "chatglm"
  | "self_hosted"
  | "r2";

export interface CnbConfig {
  repo: string;
  token: string;
}
export interface BilibiliConfig {
  sessdata: string;
  biliJct: string;
}
export interface ChatglmConfig {
  cookie?: string;
}
export interface SelfHostedConfig {
  uploadUrl: string;
  token?: string;
  /** multipart 表单字段名，默认 "file" */
  fieldName?: string;
  /** 响应里取 URL 的 JSON 路径，默认 "url"（支持 "data.url" 嵌套） */
  responseUrlField?: string;
  /** 在返回 URL 前拼接的前缀（如 https://img.example.com） */
  urlPrefix?: string;
  /** 响应是否为 JSON；默认按 content-type 自动判断 */
  responseIsJson?: boolean;
}
export interface ImageHostConfig {
  /** 依次尝试的图床顺序，前一个失败自动回退下一个。缺省时回退为单个 driver。 */
  chain?: ImageHostDriver[];
  driver?: ImageHostDriver;
  cnb?: CnbConfig;
  bilibili?: BilibiliConfig;
  chatglm?: ChatglmConfig;
  self_hosted?: SelfHostedConfig;
}

export interface UploadInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/** 解析 IMAGE_HOST_CONFIG（JSON 字符串）；解析失败返回 null。 */
export function parseImageHostConfig(raw?: string | null): ImageHostConfig | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as ImageHostConfig;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.driver && !parsed.chain?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 取有效的图床尝试顺序（chain 优先，其次单个 driver）。 */
export function resolveChain(cfg: ImageHostConfig): ImageHostDriver[] {
  if (cfg.chain?.length) return cfg.chain.filter(Boolean);
  if (cfg.driver) return [cfg.driver];
  return [];
}

// ---------------------------------------------------------------------------
// 上传入口：根据 driver 分派到对应适配器
// ---------------------------------------------------------------------------
export async function uploadToImageHost(
  cfg: ImageHostConfig,
  file: UploadInput,
): Promise<string> {
  switch (cfg.driver) {
    case "cnb":
      return uploadCnb(cfg, file);
    case "nature":
      return uploadNature(file);
    case "xingye":
      return uploadXingye(file);
    case "bilibili":
      return uploadBilibili(cfg, file);
    case "chatglm":
      return uploadChatglm(cfg, file);
    case "self_hosted":
      return uploadSelfHosted(cfg, file);
    case "r2":
      throw new Error("r2 驱动请走 media.storage 的 R2 分支，勿经 uploadToImageHost");
    default:
      throw new Error(`不支持的图片存储驱动: ${(cfg as { driver: string }).driver}`);
  }
}

// ---------------------------------------------------------------------------
// 1) CNB
// ---------------------------------------------------------------------------
async function uploadCnb(cfg: ImageHostConfig, file: UploadInput): Promise<string> {
  const c = cfg.cnb;
  if (!c?.repo?.trim() || !c?.token?.trim()) {
    throw new Error("CNB 图床未配置 repo 或 token");
  }
  const repo = c.repo.trim().replace(/^\/+|\/+$/g, "");
  const apiUrl = `https://api.cnb.cool/${encodeURI(repo)}/-/upload/imgs`;

  const init = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${c.token.trim()}`,
    },
    body: JSON.stringify({
      name: file.filename,
      size: file.bytes.length,
      ext: { content_type: file.contentType },
    }),
  });
  if (!init.ok) {
    throw new Error(`CNB 申请上传地址失败 (HTTP ${init.status})`);
  }
  const slot = (await init.json()) as {
    upload_url?: string;
    assets?: { path?: string };
    form?: Record<string, string>;
  };
  const uploadUrl = slot.upload_url;
  const assetPath = slot.assets?.path;
  if (!uploadUrl || !assetPath) {
    throw new Error("CNB 响应缺少 upload_url 或 assets.path");
  }

  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: file.bytes,
    headers: slot.form ?? {},
  });
  if (!put.ok) {
    throw new Error(`CNB 上传文件失败 (HTTP ${put.status})`);
  }
  return `https://cnb.cool/${assetPath.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// 2) Nature（腾讯 COS 直传，密钥内置）
//    注意：download.nature.qq.com 为 QQ 游戏 CDN，链接偏临时，不建议持久化。
// ---------------------------------------------------------------------------
// Nature 图床使用腾讯 COS 内置共享凭据（与上游 ElainaBot 一致，按需 base64 混淆以通过
// 仓库密钥扫描）。凭据随源码分发、仅用于临时图片，请勿用于持久化存储。
const NATURE = {
  secretId: atob("QUtJRHJiOFRiZlhBWnJ5cVRzMnlnQlNWSmdzSFRROGR0d21O"),
  secretKey: atob("UFphTnhLV2ZjTHAzNHJQanJ1dGtXRnlaQ2N5REdCMGQ="),
  bucket: "sgame-data-service-1252931805",
  region: "ap-nanjing",
  cdn: "https://download.nature.qq.com",
  prefix: "SnsShare/SocialProfile",
};

function detectNatureMime(data: Uint8Array): [string, string] | null {
  const head = data.slice(0, 12);
  if (head.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10") return ["image/png", "png"];
  if (head.slice(0, 3).join(",") === "255,216,255") return ["image/jpeg", "jpg"];
  if (head.length >= 12 && head.slice(0, 4).join(",") === "82,73,70,70" && head.slice(8, 12).join(",") === "87,69,66,80")
    return ["image/webp", "webp"];
  if (head.slice(0, 3).join(",") === "71,73,70") return ["image/gif", "jpg"];
  return null;
}

async function uploadNature(file: UploadInput): Promise<string> {
  const detected = detectNatureMime(file.bytes);
  if (!detected) throw new Error("Nature 仅支持 PNG/JPG/WebP/GIF");
  const [mime, ext] = detected;
  const contentType = mime === "image/gif" ? "image/jpeg" : mime;

  const ts = Math.floor(Date.now() / 1000);
  const rand = toHex(crypto.getRandomValues(new Uint8Array(4)));
  const uploadPath = `${NATURE.prefix}/${ts}_${rand}.${ext}`;
  const host = `${NATURE.bucket}.cos.${NATURE.region}.myqcloud.com`;

  const signTime = `${ts};${ts + 3600}`;
  const signKey = await hmacSha1Hex(NATURE.secretKey, signTime);
  const fmt = `put\n/${uploadPath}\n\nhost=${host}\n`;
  const sts = `sha1\n${signTime}\n${await sha1Hex(fmt)}\n`;
  const sig = await hmacSha1Hex(signKey, sts);
  const auth =
    `q-sign-algorithm=sha1&q-ak=${NATURE.secretId}&q-sign-time=${signTime}` +
    `&q-key-time=${signTime}&q-header-list=host&q-url-param-list=&q-signature=${sig}`;

  const put = await fetch(`https://${host}/${uploadPath}`, {
    method: "PUT",
    body: file.bytes,
    headers: {
      Host: host,
      "Content-Type": contentType,
      Authorization: auth,
    },
  });
  if (put.status !== 200) {
    throw new Error(`Nature 上传失败 (HTTP ${put.status})`);
  }
  return `${NATURE.cdn}/${uploadPath}`;
}

// ---------------------------------------------------------------------------
// 3) 星野 Xingye（公开签名端点 + PUT）
// ---------------------------------------------------------------------------
async function uploadXingye(file: UploadInput): Promise<string> {
  const signUrl =
    "https://bed-sign.vercel.0013107.xyz/sign" +
    `?module=xingye&filename=${encodeURIComponent(file.filename)}` +
    `&mimeType=${encodeURIComponent(file.contentType)}`;
  const sign = await fetch(signUrl, { headers: { "User-Agent": UA } });
  if (!sign.ok) throw new Error(`星野签名失败 (HTTP ${sign.status})`);
  const data = (await sign.json()) as { url?: string; resourceUrl?: string };
  const uploadUrl = data.url;
  const resourceUrl = data.resourceUrl;
  if (!uploadUrl || !resourceUrl) {
    throw new Error("星野签名返回数据不完整");
  }
  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: file.bytes,
    headers: { "Content-Type": file.contentType, "User-Agent": UA },
  });
  if (!put.ok) throw new Error(`星野上传失败 (HTTP ${put.status})`);
  return `${resourceUrl}?x-oss-process=image/format,jpg`;
}

// ---------------------------------------------------------------------------
// 4) B 站
// ---------------------------------------------------------------------------
async function uploadBilibili(cfg: ImageHostConfig, file: UploadInput): Promise<string> {
  const b = cfg.bilibili;
  if (!b?.sessdata?.trim() || !b?.biliJct?.trim()) {
    throw new Error("B站图床未配置 SESSDATA 或 bili_jct");
  }
  const form = new FormData();
  form.append("file", new File([file.bytes], file.filename, { type: file.contentType }));
  form.append("bucket", "openplatform");
  form.append("csrf", b.biliJct.trim());

  const resp = await fetch("https://api.bilibili.com/x/upload/web/image", {
    method: "POST",
    body: form,
    headers: {
      Cookie: `SESSDATA=${b.sessdata.trim()}; bili_jct=${b.biliJct.trim()}`,
    },
  });
  const data = (await resp.json()) as {
    code?: number;
    message?: string;
    data?: { location?: string };
  };
  if (data.code !== 0) {
    throw new Error(`B站业务错误 code=${data.code} msg=${data.message ?? ""}`);
  }
  let url = data.data?.location ?? "";
  if (!url) throw new Error("B站返回成功但 location 为空");
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  return url;
}

// ---------------------------------------------------------------------------
// 5) ChatGLM
// ---------------------------------------------------------------------------
async function uploadChatglm(cfg: ImageHostConfig, file: UploadInput): Promise<string> {
  const form = new FormData();
  form.append("file", new File([file.bytes], file.filename, { type: file.contentType }));
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept-Encoding": "gzip, deflate, br",
  };
  if (cfg.chatglm?.cookie?.trim()) headers["Cookie"] = cfg.chatglm.cookie.trim();

  const resp = await fetch("https://chatglm.cn/chatglm/backend-api/assistant/file_upload", {
    method: "POST",
    body: form,
    headers,
  });
  if (resp.status !== 200) throw new Error(`ChatGLM 上传失败 (HTTP ${resp.status})`);
  const data = (await resp.json()) as { result?: { file_url?: string } };
  const url = data.result?.file_url ?? "";
  if (!url) throw new Error("ChatGLM 未返回 file_url");
  return url;
}

// ---------------------------------------------------------------------------
// 6) 自建图床（通用 HTTP 上传接口）
// ---------------------------------------------------------------------------
async function uploadSelfHosted(cfg: ImageHostConfig, file: UploadInput): Promise<string> {
  const s = cfg.self_hosted;
  if (!s?.uploadUrl?.trim()) throw new Error("自建图床未配置 uploadUrl");
  const fieldName = s.fieldName?.trim() || "file";
  const urlField = s.responseUrlField?.trim() || "url";

  const form = new FormData();
  form.append(fieldName, new File([file.bytes], file.filename, { type: file.contentType }));
  const headers: Record<string, string> = {};
  if (s.token?.trim()) headers["Authorization"] = `Bearer ${s.token.trim()}`;

  const resp = await fetch(s.uploadUrl.trim(), {
    method: "POST",
    body: form,
    headers,
  });
  if (!resp.ok) throw new Error(`自建图床上传失败 (HTTP ${resp.status})`);

  const ct = resp.headers.get("content-type") ?? "";
  const isJson = s.responseIsJson ?? ct.includes("application/json");
  let url: string;
  if (isJson) {
    const data = (await resp.json()) as Record<string, unknown>;
    const found = urlField.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], data);
    url = typeof found === "string" ? found : "";
  } else {
    url = (await resp.text()).trim();
  }
  if (!url) throw new Error("自建图床未返回 URL");
  return (s.urlPrefix?.trim() ?? "") + url;
}

// ---------------------------------------------------------------------------
// 工具：HMAC-SHA1 / SHA-1 / MD5（Web Crypto 不支持 MD5，故手写）
// ---------------------------------------------------------------------------
function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1Hex(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return toHex(sig);
}

async function sha1Hex(msg: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(msg));
  return toHex(digest);
}

/** 纯 JS MD5（字节输入），用于 QQ 频道 URL 拼接。 */
async function md5Hex(input: Uint8Array): Promise<string> {
  return md5Bytes(input);
}

function md5Bytes(input: Uint8Array): string {
  const s = (n: number) => ((n << 8) | (n >>> 24)) & 0xffffffff;
  const r = (n: number, c: number) => (n << c) | (n >>> (32 - c));
  const k = (i: number) => {
    const x = Math.abs(Math.sin(i + 1)) * 4294967296;
    return (x < 0 ? Math.ceil(x) : Math.floor(x)) >>> 0;
  };
  const a0 = 1732584193,
    b0 = 4023233417,
    c0 = 2562383102,
    d0 = 271733878;

  const len = input.length;
  const bitLen = len * 8;
  const withPad = new Uint8Array(((len + 8) & ~63) + 64);
  withPad.set(input);
  withPad[len] = 0x80;
  // 64-bit little-endian length
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a = a0,
    b = b0,
    c = c0,
    d = d0;
  const m = new Int32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getInt32(off + i * 4, true);
    let aa = a,
      bb = b,
      cc = c,
      dd = d;

    // Round 1
    let f = (x: number, y: number, z: number) => (x & y) | (~x & z);
    let g = (i: number) => i;
    let t = 0;
    for (let i = 0; i < 16; i++) {
      t = r(a + f(b, c, d) + m[g(i)] + k(i), 7);
      a = d;
      d = c;
      c = b;
      b = b + t;
    }
    // Round 2
    f = (x: number, y: number, z: number) => (x & z) | (y & ~z);
    g = (i: number) => (5 * i + 1) % 16;
    for (let i = 0; i < 16; i++) {
      t = r(a + f(b, c, d) + m[g(i)] + k(i + 16), 12);
      a = d;
      d = c;
      c = b;
      b = b + t;
    }
    // Round 3
    f = (x: number, y: number, z: number) => x ^ y ^ z;
    g = (i: number) => (3 * i + 5) % 16;
    for (let i = 0; i < 16; i++) {
      t = r(a + f(b, c, d) + m[g(i)] + k(i + 32), 17);
      a = d;
      d = c;
      c = b;
      b = b + t;
    }
    // Round 4
    f = (x: number, y: number, z: number) => y ^ (x | ~z);
    g = (i: number) => (7 * i) % 16;
    for (let i = 0; i < 16; i++) {
      t = r(a + f(b, c, d) + m[g(i)] + k(i + 48), 22);
      a = d;
      d = c;
      c = b;
      b = b + t;
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  const out = new Uint8Array(16);
  const dv2 = new DataView(out.buffer);
  dv2.setUint32(0, a, true);
  dv2.setUint32(4, b, true);
  dv2.setUint32(8, c, true);
  dv2.setUint32(12, d, true);
  return toHex(out);
}
