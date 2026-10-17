import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface CliConfig {
  server: string;
  token: string | null;
  tokenPrefix: string | null;
  username: string | null;
  anonResume: Record<string, string>; // "anon:<server>" -> resumeToken
}

const DIR = path.join(os.homedir(), ".tmin");
const FILE = path.join(DIR, "config.json");
const RUNTIME = path.join(DIR, "tunnels.json");

export function defaultServer(): string {
  return process.env.TMIN_SERVER || "http://localhost:8080";
}

export async function loadConfig(): Promise<CliConfig> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const c = JSON.parse(raw) as Partial<CliConfig>;
    return {
      server: process.env.TMIN_SERVER || c.server || defaultServer(),
      token: process.env.TMIN_TOKEN || c.token || null,
      tokenPrefix: c.tokenPrefix || null,
      username: c.username || null,
      anonResume: c.anonResume || {},
    };
  } catch {
    return {
      server: defaultServer(),
      token: process.env.TMIN_TOKEN || null,
      tokenPrefix: null,
      username: null,
      anonResume: {},
    };
  }
}

export async function saveConfig(c: CliConfig): Promise<void> {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  // Never persist an env-provided token to disk.
  const toSave: CliConfig = { ...c, token: process.env.TMIN_TOKEN ? null : c.token };
  await fs.writeFile(FILE + ".tmp", JSON.stringify(toSave, null, 2), { mode: 0o600 });
  await fs.rename(FILE + ".tmp", FILE);
  try {
    await fs.chmod(FILE, 0o600);
  } catch {
    undefined;
  }
}

export function configPath(): string {
  return FILE;
}

export interface RuntimeTunnel {
  tunnelId: string;
  routePath: string;
  publicUrl: string;
  slot: number;
  localPort: number;
  anonymous: boolean;
  expiresAt: number | null;
  startedAt: number;
  pid: number;
}

export async function readRuntime(): Promise<RuntimeTunnel[]> {
  try {
    const raw = await fs.readFile(RUNTIME, "utf8");
    const arr = JSON.parse(raw) as RuntimeTunnel[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeRuntime(list: RuntimeTunnel[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(RUNTIME + ".tmp", JSON.stringify(list, null, 2));
  await fs.rename(RUNTIME + ".tmp", RUNTIME);
}

export async function addRuntime(t: RuntimeTunnel): Promise<void> {
  const list = (await readRuntime()).filter((x) => x.tunnelId !== t.tunnelId);
  list.push(t);
  await writeRuntime(list);
}

export async function removeRuntime(tunnelId: string): Promise<void> {
  await writeRuntime((await readRuntime()).filter((x) => x.tunnelId !== tunnelId));
}
