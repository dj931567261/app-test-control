#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createProductionReadonlyFirebaseServer } from "./server.js";
import type { FirebaseProjectSource } from "./upstream.js";

interface CliOptions {
  firebaseDir?: string;
  projectSource?: FirebaseProjectSource;
  firebaseProjectId?: string;
  help: boolean;
}

const FIREBASE_PROJECT_SOURCES = new Set<FirebaseProjectSource>([
  "service-account",
  "firebaserc",
]);

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let firebaseDir: string | undefined;
  let projectSource: FirebaseProjectSource | undefined;
  let firebaseProjectId: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dir") {
      if (firebaseDir !== undefined) throw new Error("--dir may be supplied only once");
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--dir requires one absolute directory");
      firebaseDir = value;
    } else if (argument === "--project-source") {
      if (projectSource !== undefined) {
        throw new Error("--project-source may be supplied only once");
      }
      const value = argv[++index] as FirebaseProjectSource | undefined;
      if (!value || value.startsWith("--")) {
        throw new Error("--project-source requires service-account or firebaserc");
      }
      if (!FIREBASE_PROJECT_SOURCES.has(value)) {
        throw new Error("--project-source must be service-account or firebaserc");
      }
      projectSource = value;
    } else if (argument === "--project-id") {
      if (firebaseProjectId !== undefined) {
        throw new Error("--project-id may be supplied only once");
      }
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--project-id requires one Firebase project id");
      }
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value)) {
        throw new Error("--project-id is not a valid Firebase project id");
      }
      firebaseProjectId = value;
    } else if (argument === "--help" || argument === "-h") {
      if (help) throw new Error("--help may be supplied only once");
      help = true;
    } else {
      throw new Error(`unknown or positional argument: ${argument}`);
    }
  }
  if (help && argv.length !== 1) throw new Error("--help cannot be combined with other arguments");
  if (projectSource !== undefined && firebaseDir === undefined) {
    throw new Error("--project-source requires --dir");
  }
  if (firebaseDir !== undefined && projectSource === undefined) {
    throw new Error("--dir requires an explicit --project-source");
  }
  if (projectSource === "service-account" && firebaseProjectId === undefined) {
    throw new Error("service-account project source requires --project-id");
  }
  if (projectSource !== "service-account" && firebaseProjectId !== undefined) {
    throw new Error("--project-id is only valid with service-account project source");
  }
  return { firebaseDir, projectSource, firebaseProjectId, help };
}

async function validateFirebaseDir(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value) || value.includes("\0") || value.length > 4096) {
    throw new Error("--dir must be an absolute existing directory");
  }
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("--dir must be an absolute existing directory");
  }
  return canonical;
}

export async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(
      "Usage: firebase-readonly-mcp [--project-source service-account --project-id <id> --dir <absolute Firebase project directory> | --project-source firebaserc --dir <absolute Firebase project directory>]\n",
    );
    return;
  }
  const firebaseDir = await validateFirebaseDir(parsed.firebaseDir);
  const runtime = createProductionReadonlyFirebaseServer({
    firebaseDir,
    projectSource: parsed.projectSource,
    firebaseProjectId: parsed.firebaseProjectId,
  });
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= runtime.close();
    return shutdownPromise;
  };
  const terminate = () => {
    void shutdown().then(
      () => process.exit(0),
      () => {
        process.stderr.write("[firebase-readonly-mcp] failed to close safely\n");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  process.stdin.once("close", () => {
    void shutdown().catch(() => {
      process.stderr.write("[firebase-readonly-mcp] failed to close safely\n");
      process.exitCode = 1;
    });
  });
  await runtime.server.connect(transport);
}

function isDirectExecution(argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(argvPath) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution(process.argv[1])) {
  main().catch(() => {
    process.stderr.write("[firebase-readonly-mcp] failed to start safely\n");
    process.exitCode = 1;
  });
}
