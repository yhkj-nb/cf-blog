import { bindings, defineConfig, exports, triggers } from "cf/config";
import { getDomain } from "tldts";
import * as entrypoint from "./src/server" with { type: "cf-worker" };

// Loaded by Node >= 22.18 (Vite, Vitest and `cf`), never by Bun.
//
// Deployment values come from real environment variables, which Workers Builds
// exposes as build variables (`.env` is not read here). The placeholders keep
// `bun dev`, tests and CI working without any Cloudflare resources. The fixed
// UUID is what `bun db:migrate:local` targets, so it must stay a valid D1 id.
const env = process.env;
// 非敏感的构建默认值（你在 Cloudflare 构建设置里设了同名构建变量则会覆盖这里）。
// 注意：R2 存储桶已彻底移除，用户图片与站点资源均走免费图床，不再需要 BUCKET_NAME。
const workerName = env.WORKER_NAME?.trim() || "cf-blog";
const queueName = env.QUEUE_NAME?.trim() || "blog";
const d1DatabaseId =
  env.D1_DATABASE_ID?.trim() || "3c255959-d438-4c96-8ff1-a8fcfe131109";
const kvNamespaceId =
  env.KV_NAMESPACE_ID?.trim() || "4276d1e291c34619b7391b5a52c7bc78";
const domain = env.DOMAIN?.trim() || "yh-blog.de5.net";
const useRoutes = ["1", "true", "yes", "on"].includes(
  env.ROUTE?.trim().toLowerCase() ?? "",
);

// 图床配置（替换 R2 作为用户图片库）：
//   IMAGE_STORAGE_DRIVER  : 逗号分隔的图床驱动链，缺省使用三个免凭据图床。
//   IMAGE_HOST_CONFIG     : 图床详细 JSON（含各图床令牌），缺省留空。
// 二者都作为构建变量注入；未配置时回落到免凭据默认链，开箱即用。
const imageHostConfig = env.IMAGE_HOST_CONFIG?.trim() ?? "";
const imageStorageDriver =
  env.IMAGE_STORAGE_DRIVER?.trim() || "nature,xingye,chatglm";

export default defineConfig((ctx) => {
  // Tests only produce to the queue; a consumer would race their assertions.
  const isTest = ctx.mode === "test";

  return {
    worker: {
      name: workerName,
      compatibilityDate: "2026-02-17",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      entrypoint,
      cache: { enabled: true },
      observability: { enabled: true },
      ...(domain && !useRoutes ? { domains: [domain] } : {}),
      triggers: [
        triggers.scheduled({ schedule: "15 0 * * *" }),
        ...(domain && useRoutes
          ? [
              triggers.fetch({
                pattern: `${domain}/*`,
                zone: env.ZONE_NAME?.trim() || getDomain(domain) || domain,
              }),
            ]
          : []),
        ...(isTest
          ? []
          : [
              triggers.queue({
                name: queueName,
                maxBatchSize: 10,
                maxBatchTimeout: 5,
                maxRetries: 3,
              }),
            ]),
      ],
      env: {
        DB: bindings.d1({ id: d1DatabaseId }),
        KV: bindings.kv({ id: kvNamespaceId }),
        QUEUE: bindings.queue({ name: queueName }),
        IMAGE_HOST_CONFIG: bindings.text(imageHostConfig),
        IMAGE_STORAGE_DRIVER: bindings.text(imageStorageDriver),
      },
      // Durable Objects are reached through `exports` from `cloudflare:workers`,
      // so they need no binding. Once deployed this way, rolling back to a
      // `migrations`-based wrangler config is rejected.
      exports: {
        default: exports.worker({ cache: { enabled: false } }),
        App: exports.worker({ cache: { enabled: true } }),
        RateLimiter: exports.durableObject({ storage: "sqlite" }),
        PostPublisher: exports.durableObject({ storage: "sqlite" }),
      },
    },
  };
});
