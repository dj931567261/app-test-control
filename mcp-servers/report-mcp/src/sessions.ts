import { mkdir, writeFile, appendFile, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type SessionStatus = "running" | "passed" | "failed" | "aborted";

export interface SessionMeta {
  id: string;
  name: string;
  started_at: string; // ISO
  ended_at?: string;
  status: SessionStatus;
  /** Optional arbitrary key/value collected by the agent. */
  extra?: Record<string, unknown>;
}

export interface StepRecord {
  index: number;
  ts: string; // ISO
  action: string;
  result?: "ok" | "fail" | "skip";
  screenshot?: string; // relative path inside session dir
  log_excerpt?: string; // relative path
  notes?: string;
}

export interface CrashRecord {
  id: string;        // c1, c2, ...
  ts: string;
  step_index?: number; // step where it was detected
  signature: string;
  kind?: string;     // java | anr | native | other
  stack_path: string;  // relative
  log_path?: string;   // relative — full log archived
  repro_path: number[]; // sequence of step indices considered required
}

const WORKSPACE_ENV = "APP_TEST_CTRL_WORKSPACE";

export function resolveWorkspaceRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const env = process.env[WORKSPACE_ENV];
  if (env) return path.resolve(env);
  // Default: cwd/workspace/sessions
  return path.resolve(process.cwd(), "workspace", "sessions");
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "session";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export interface CreatedSession {
  id: string;
  dir: string;
  meta_path: string;
}

export async function createSession(opts: {
  name: string;
  workspaceRoot?: string;
  extra?: Record<string, unknown>;
}): Promise<CreatedSession> {
  const root = resolveWorkspaceRoot(opts.workspaceRoot);
  const id = `${timestamp()}_${sanitizeName(opts.name)}`;
  const dir = path.join(root, id);
  await mkdir(path.join(dir, "steps"), { recursive: true });
  await mkdir(path.join(dir, "crashes"), { recursive: true });
  await mkdir(path.join(dir, "logs"), { recursive: true });
  const meta: SessionMeta = {
    id,
    name: opts.name,
    started_at: new Date().toISOString(),
    status: "running",
    ...(opts.extra ? { extra: opts.extra } : {}),
  };
  const metaPath = path.join(dir, "meta.json");
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  await writeFile(path.join(dir, "steps.jsonl"), "");
  await writeFile(path.join(dir, "crashes.jsonl"), "");
  return { id, dir, meta_path: metaPath };
}

export async function loadMeta(sessionDir: string): Promise<SessionMeta> {
  const txt = await readFile(path.join(sessionDir, "meta.json"), "utf8");
  return JSON.parse(txt) as SessionMeta;
}

export async function writeMeta(sessionDir: string, meta: SessionMeta): Promise<void> {
  await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function resolveSessionDir(opts: {
  workspaceRoot?: string;
  sessionId?: string;
  sessionDir?: string;
}): string {
  if (opts.sessionDir) return path.resolve(opts.sessionDir);
  if (!opts.sessionId) {
    throw new Error("Either session_id or session_dir is required");
  }
  return path.join(resolveWorkspaceRoot(opts.workspaceRoot), opts.sessionId);
}

export async function appendStep(
  sessionDir: string,
  step: StepRecord,
): Promise<void> {
  await appendFile(path.join(sessionDir, "steps.jsonl"), JSON.stringify(step) + "\n");
}

export async function appendCrash(
  sessionDir: string,
  crash: CrashRecord,
): Promise<void> {
  await appendFile(
    path.join(sessionDir, "crashes.jsonl"),
    JSON.stringify(crash) + "\n",
  );
}

export async function readSteps(sessionDir: string): Promise<StepRecord[]> {
  try {
    const txt = await readFile(path.join(sessionDir, "steps.jsonl"), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StepRecord);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function readCrashes(sessionDir: string): Promise<CrashRecord[]> {
  try {
    const txt = await readFile(path.join(sessionDir, "crashes.jsonl"), "utf8");
    return txt
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as CrashRecord);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export async function listSessions(workspaceRoot?: string): Promise<
  Array<{ id: string; dir: string; status: SessionStatus; started_at: string }>
> {
  const root = resolveWorkspaceRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Array<{ id: string; dir: string; status: SessionStatus; started_at: string }> = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      const meta = await loadMeta(dir);
      out.push({ id: meta.id, dir, status: meta.status, started_at: meta.started_at });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  return out;
}
