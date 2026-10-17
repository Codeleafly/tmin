/** Validated application configuration (env-driven, fail-fast in production). */

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  publicDomain: string;
  publicBaseUrl: string;
  trustProxy: boolean;
  sessionSecret: string;
  dataDir: string;
  dataFile: string;
  adminUsername: string;
  adminPassword: string;
  adminEmail: string;
  anonymousTtlSeconds: number;
  anonymousMaxPerIp: number;
  anonymousAbuseBlockSeconds: number;
  anonymousMaxBodyBytes: number;
  freeMaxConcurrentTunnels: number;
  freeUploadLimitBytes: number;
  freeDownloadLimitBytes: number;
  usageWarnPercent: number;
  requestTimeoutMs: number;
  maxConcurrentPerTunnel: number;
  maxBodyBytes: number;
  wsMaxFrameBytes: number;
  wsMaxLifetimeSeconds: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  shutdownDrainMs: number;
  rateAuthPerMin: number;
  rateApiPerMin: number;
  ratePublicPerMin: number;
  requestLogRetentionDays: number;
  auditRetentionDays: number;
  anonCleanupIntervalMs: number;
  maintenanceMode: boolean;
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Invalid ${name}=${raw}: must be a number`);
  return v;
}

export function loadConfig(): AppConfig {
  const nodeEnv = env("NODE_ENV", "development");
  const sessionSecret = env("SESSION_SECRET", "");
  if (nodeEnv === "production" && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 chars in production.");
  }
  const cfg: AppConfig = {
    nodeEnv,
    port: num("PORT", 8080),
    logLevel: env("LOG_LEVEL", "info"),
    publicDomain: env("PUBLIC_DOMAIN", "localhost:8080"),
    publicBaseUrl: env("PUBLIC_BASE_URL", `http://localhost:${num("PORT", 8080)}`),
    trustProxy: env("TRUST_PROXY", "false") === "true",
    sessionSecret: sessionSecret || "dev-only-secret-not-for-production-0123456789",
    dataDir: env("DATA_DIR", "./data"),
    dataFile: env("DATA_FILE", "tmin.json"),
    adminUsername: env("ADMIN_USERNAME", "admin"),
    adminPassword: env("ADMIN_PASSWORD", ""),
    adminEmail: env("ADMIN_EMAIL", "admin@example.com"),
    anonymousTtlSeconds: num("ANONYMOUS_TUNNEL_TTL_SECONDS", 1800),
    anonymousMaxPerIp: num("ANONYMOUS_MAX_PER_IP", 10),
    anonymousAbuseBlockSeconds: num("ANONYMOUS_ABUSE_BLOCK_SECONDS", 600),
    anonymousMaxBodyBytes: num("ANONYMOUS_MAX_BODY_BYTES", 1048576),
    freeMaxConcurrentTunnels: num("FREE_MAX_CONCURRENT_TUNNELS", 3),
    freeUploadLimitBytes: num("FREE_UPLOAD_LIMIT_BYTES", 1073741824),
    freeDownloadLimitBytes: num("FREE_DOWNLOAD_LIMIT_BYTES", 1073741824),
    usageWarnPercent: num("USAGE_WARN_PERCENT", 80),
    requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 30000),
    maxConcurrentPerTunnel: num("MAX_CONCURRENT_PER_TUNNEL", 50),
    maxBodyBytes: num("MAX_BODY_BYTES", 10485760),
    wsMaxFrameBytes: num("WS_MAX_FRAME_BYTES", 1048576),
    wsMaxLifetimeSeconds: num("WS_MAX_LIFETIME_SECONDS", 3600),
    heartbeatIntervalMs: num("HEARTBEAT_INTERVAL_MS", 25000),
    heartbeatTimeoutMs: num("HEARTBEAT_TIMEOUT_MS", 60000),
    shutdownDrainMs: num("SHUTDOWN_DRAIN_MS", 10000),
    rateAuthPerMin: num("RATE_AUTH_PER_MIN", 20),
    rateApiPerMin: num("RATE_API_PER_MIN", 300),
    ratePublicPerMin: num("RATE_PUBLIC_PER_MIN", 600),
    requestLogRetentionDays: num("REQUEST_LOG_RETENTION_DAYS", 7),
    auditRetentionDays: num("AUDIT_RETENTION_DAYS", 90),
    anonCleanupIntervalMs: num("ANON_CLEANUP_INTERVAL_MS", 60000),
    maintenanceMode: env("MAINTENANCE_MODE", "false") === "true",
  };
  if (cfg.anonymousTtlSeconds <= 0 || cfg.anonymousTtlSeconds > 7200) {
    throw new Error("ANONYMOUS_TUNNEL_TTL_SECONDS must be 1..7200");
  }
  if (cfg.freeMaxConcurrentTunnels < 1 || cfg.freeMaxConcurrentTunnels > 10) {
    throw new Error("FREE_MAX_CONCURRENT_TUNNELS must be 1..10");
  }
  return cfg;
}
