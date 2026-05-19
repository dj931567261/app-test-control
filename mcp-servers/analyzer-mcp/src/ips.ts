// Parse Apple .ips crash files into our ParsedStack shape.
//
// .ips structure (post macOS 11 / iOS 14):
//   line 1: header JSON  { name, app_name, bundleID, app_identifier, timestamp,
//                          bug_type, os_version, ... }
//   line 2+: body  JSON  { exception, faultingThread, threads[], usedImages[], ... }
//
// We extract:
//   - exception.type / signal / subtype
//   - faultingThread (or any thread with triggered=true) → top 3 frames
//   - frames symbolicate to "symbol+symbolLocation" when available, else
//     "<image-name>+<offset>" using imageIndex → usedImages lookup.

import { readFile } from "node:fs/promises";
import type { ParsedStack } from "./signature.js";

interface IpsHeader {
  name?: string;
  procName?: string;
  app_name?: string;
  bundleID?: string;
  app_identifier?: string;
  timestamp?: string;
  bug_type?: string;
  os_version?: string;
}

interface IpsFrame {
  imageOffset?: number;
  imageIndex?: number;
  symbol?: string;
  symbolLocation?: number;
  sourceFile?: string;
  sourceLine?: number;
}

interface IpsThread {
  triggered?: boolean;
  name?: string;
  queue?: string;
  frames?: IpsFrame[];
}

interface IpsImage {
  name?: string;
  path?: string;
  base?: number;
  uuid?: string;
}

interface IpsBody {
  exception?: {
    type?: string;
    signal?: string;
    subtype?: string;
    codes?: string;
    rawCodes?: number[];
  };
  faultingThread?: number;
  threads?: IpsThread[];
  usedImages?: IpsImage[];
  procName?: string;
}

export interface ParsedIps {
  header: IpsHeader;
  exception_type?: string;
  signal?: string;
  subtype?: string;
  faulting_thread_index?: number;
  faulting_thread_name?: string;
  top_frames: string[];
  bundle_id?: string;
  proc_name?: string;
}

export function parseIpsContent(raw: string): ParsedIps {
  const firstBreak = raw.indexOf("\n");
  if (firstBreak < 0) throw new Error(".ips file appears malformed (no newline)");
  const headerText = raw.slice(0, firstBreak).trim();
  const bodyText = raw.slice(firstBreak + 1).trim();
  if (!headerText || !bodyText) throw new Error(".ips file empty header or body");

  const header = JSON.parse(headerText) as IpsHeader;
  const body = JSON.parse(bodyText) as IpsBody;

  const ft = body.faultingThread;
  let thread: IpsThread | undefined;
  if (typeof ft === "number" && body.threads && body.threads[ft]) {
    thread = body.threads[ft];
  } else {
    thread = (body.threads ?? []).find((t) => t?.triggered);
  }

  const frames = (thread?.frames ?? []).slice(0, 3);
  const images: IpsImage[] = body.usedImages ?? [];
  const top_frames = frames.map((f) => formatFrame(f, images));

  const proc = header.name ?? header.procName ?? body.procName ?? header.app_name;
  const bundle = header.bundleID ?? header.app_identifier;

  return {
    header,
    ...(body.exception?.type !== undefined ? { exception_type: body.exception.type } : {}),
    ...(body.exception?.signal !== undefined ? { signal: body.exception.signal } : {}),
    ...(body.exception?.subtype !== undefined ? { subtype: body.exception.subtype } : {}),
    ...(ft !== undefined ? { faulting_thread_index: ft } : {}),
    ...(thread?.name !== undefined ? { faulting_thread_name: thread.name } : {}),
    top_frames,
    ...(bundle !== undefined ? { bundle_id: bundle } : {}),
    ...(proc !== undefined ? { proc_name: proc } : {}),
  };
}

function formatFrame(f: IpsFrame, images: IpsImage[]): string {
  if (f.symbol) {
    return `${f.symbol}+${f.symbolLocation ?? 0}`;
  }
  const img = typeof f.imageIndex === "number" ? images[f.imageIndex] : undefined;
  const imgName = img?.name ?? (img?.path ? imgBasename(img.path) : `image-${f.imageIndex ?? "?"}`);
  return `${imgName}+${f.imageOffset ?? 0}`;
}

function imgBasename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export async function parseIpsFile(filePath: string): Promise<ParsedIps> {
  const raw = await readFile(filePath, "utf8");
  return parseIpsContent(raw);
}

/** Convert ParsedIps into our generic ParsedStack so computeSignature works. */
export function ipsToParsedStack(p: ParsedIps): ParsedStack {
  return {
    kind: "ios",
    ...(p.exception_type !== undefined ? { exception_class: p.exception_type } : {}),
    top_frames: p.top_frames,
    ...(p.signal !== undefined ? { signal: p.signal } : {}),
    ...(p.bundle_id ?? p.proc_name
      ? { process: p.bundle_id ?? p.proc_name }
      : {}),
  };
}
