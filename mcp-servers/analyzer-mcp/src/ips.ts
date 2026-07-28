// Parse Apple .ips crash files into our ParsedStack shape.
//
// .ips structure (post macOS 11 / iOS 14):
//   line 1: header JSON  { name, app_name, bundleID, app_identifier, timestamp,
//                          bug_type, os_version, ... }
//   line 2+: body  JSON  { exception, faultingThread, threads[], usedImages[], ... }
//
// We extract:
//   - exception.type / signal / subtype
//   - faultingThread (or any thread with triggered=true) → up to 32 frames
//   - frames symbolicate to "symbol+symbolLocation" when available, else
//     "<image-name>+<offset>" using imageIndex → usedImages lookup.

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { ParsedStack } from "./signature.js";

/**
 * Apple crash reports are normally a few MiB. Keep enough headroom for reports
 * with many threads while preventing special files or corrupt reports from
 * making the MCP process buffer unbounded input.
 */
export const MAX_IPS_FILE_BYTES = 64 * 1024 * 1024;

/** Preserve enough of the faulting thread to get past common exception trampolines. */
export const MAX_RETAINED_IPS_FRAMES = 32;

/** Bound every identity/output-bearing scalar inside an otherwise bounded file. */
export const MAX_IPS_FIELD_CHARS = 16 * 1024;
const MAX_SCANNED_IPS_COLLECTION_ITEMS = 4096;

const FILE_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Apply the same byte limit to inline content as to file-backed reports.
 * Counting UTF-8 bytes (rather than JavaScript UTF-16 code units) keeps the
 * two MCP entry points consistent for non-ASCII crash metadata.
 */
export function assertIpsContentSize(
  raw: string,
  maxBytes: number = MAX_IPS_FILE_BYTES,
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Error(`.ips content exceeds ${maxBytes} byte size limit`);
  }
}

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
  /** First app-owned frame when identifiable, otherwise the fourth frame. */
  identity_frame?: string;
  bundle_id?: string;
  proc_name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > MAX_IPS_FIELD_CHARS) {
    throw new Error(`.ips string field exceeds ${MAX_IPS_FIELD_CHARS} character limit`);
  }
  const normalized = value.replace(/[\r\n]+/g, " ").trim();
  return normalized || undefined;
}

function sanitizeHeader(raw: Record<string, unknown>): IpsHeader {
  const header: IpsHeader = {};
  const assign = (key: keyof IpsHeader) => {
    const value = nonEmptyString(raw[key]);
    if (value !== undefined) header[key] = value;
  };
  assign("name");
  assign("procName");
  assign("app_name");
  assign("bundleID");
  assign("app_identifier");
  assign("timestamp");
  assign("bug_type");
  assign("os_version");
  return header;
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function parseIpsContent(raw: string): ParsedIps {
  assertIpsContentSize(raw);
  const firstBreak = raw.indexOf("\n");
  if (firstBreak < 0) throw new Error(".ips file appears malformed (no newline)");
  const headerText = raw.slice(0, firstBreak).trim();
  const bodyText = raw.slice(firstBreak + 1).trim();
  if (!headerText || !bodyText) throw new Error(".ips file empty header or body");

  const rawHeader: unknown = JSON.parse(headerText);
  const rawBody: unknown = JSON.parse(bodyText);
  if (!isRecord(rawHeader) || !isRecord(rawBody)) {
    throw new Error(".ips file malformed header or body JSON object");
  }
  const header = sanitizeHeader(rawHeader);
  const body = rawBody as IpsBody;

  const ft = safeNonNegativeInteger(body.faultingThread);
  const threads = Array.isArray(body.threads) ? body.threads : [];
  let thread: IpsThread | undefined;
  if (ft !== undefined && isRecord(threads[ft])) {
    thread = threads[ft] as IpsThread;
  } else {
    for (
      let index = 0;
      index < Math.min(threads.length, MAX_SCANNED_IPS_COLLECTION_ITEMS);
      index++
    ) {
      const candidate = threads[index];
      if (isRecord(candidate) && candidate["triggered"] === true) {
        thread = candidate as IpsThread;
        break;
      }
    }
  }

  const frames: IpsFrame[] = [];
  const rawFrames = Array.isArray(thread?.frames) ? thread.frames : [];
  for (
    let index = 0;
    index < Math.min(rawFrames.length, MAX_SCANNED_IPS_COLLECTION_ITEMS);
    index++
  ) {
    const frame = rawFrames[index];
    if (!isRecord(frame)) continue;
    frames.push(frame as IpsFrame);
    if (frames.length >= MAX_RETAINED_IPS_FRAMES) break;
  }
  // Preserve original usedImages indexes without copying an attacker-sized
  // sparse/null array into millions of new objects. Retained frames lazily read
  // only the handful of referenced entries.
  const images: unknown[] = Array.isArray(body.usedImages) ? body.usedImages : [];
  const top_frames = frames.map((f) => formatFrame(f, images));

  const proc = nonEmptyString(header.name)
    ?? nonEmptyString(header.procName)
    ?? nonEmptyString(body.procName)
    ?? nonEmptyString(header.app_name);
  const bundle = nonEmptyString(header.bundleID) ?? nonEmptyString(header.app_identifier);
  const identityFrame = findIdentityFrame(frames, images, top_frames, [
    header.name,
    header.procName,
    body.procName,
    header.app_name,
  ]);
  const exceptionType = nonEmptyString(body.exception?.type);
  const signal = nonEmptyString(body.exception?.signal);
  const subtype = nonEmptyString(body.exception?.subtype);

  return {
    header,
    ...(exceptionType !== undefined ? { exception_type: exceptionType } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(subtype !== undefined ? { subtype } : {}),
    ...(ft !== undefined
      ? { faulting_thread_index: ft }
      : {}),
    ...(nonEmptyString(thread?.name) !== undefined
      ? { faulting_thread_name: nonEmptyString(thread?.name)! }
      : {}),
    top_frames,
    ...(identityFrame !== undefined ? { identity_frame: identityFrame } : {}),
    ...(bundle !== undefined ? { bundle_id: bundle } : {}),
    ...(proc !== undefined ? { proc_name: proc } : {}),
  };
}

function findIdentityFrame(
  frames: IpsFrame[],
  images: unknown[],
  formattedFrames: string[],
  processNames: unknown[],
): string | undefined {
  const appNames = new Set(
    processNames
      .map(nonEmptyString)
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase()),
  );

  if (appNames.size > 0) {
    const appFrameIndex = frames.findIndex((frame) => {
      const image = imageAt(images, frame.imageIndex);
      const imageName = nonEmptyString(image?.name);
      const imagePathValue = nonEmptyString(image?.path);
      const imageNames = [
        imageName,
        imagePathValue ? imgBasename(imagePathValue) : undefined,
      ]
        .map(nonEmptyString)
        .filter((name): name is string => name !== undefined)
        .map((name) => name.toLowerCase());
      if (imageNames.some((name) => appNames.has(name))) return true;

      const imagePath = imagePathValue?.toLowerCase();
      if (imagePath) {
        for (const appName of appNames) {
          if (
            imagePath.includes(`/${appName}.app/`) ||
            imagePath.endsWith(`/${appName}`)
          ) {
            return true;
          }
        }
      }

      const symbol = nonEmptyString(frame.symbol)?.toLowerCase();
      return symbol !== undefined && Array.from(appNames).some(
        (appName) => symbol.startsWith(`${appName}.`) || symbol.startsWith(`${appName}::`),
      );
    });
    if (appFrameIndex >= 0) return formattedFrames[appFrameIndex];
  }

  // Even when image metadata is missing, the fourth frame is commonly the
  // first frame below iOS exception trampolines and must influence identity.
  return formattedFrames[3];
}

function formatFrame(f: IpsFrame, images: unknown[]): string {
  const symbol = nonEmptyString(f.symbol);
  const symbolLocation = safeNonNegativeInteger(f.symbolLocation) ?? 0;
  if (symbol) {
    return `${symbol}+${symbolLocation}`;
  }
  const imageIndex = safeNonNegativeInteger(f.imageIndex);
  const img = imageAt(images, imageIndex);
  const imageName = nonEmptyString(img?.name);
  const imagePath = nonEmptyString(img?.path);
  const imgName = imageName ?? (imagePath
    ? imgBasename(imagePath)
    : `image-${imageIndex ?? "?"}`);
  return `${imgName}+${safeNonNegativeInteger(f.imageOffset) ?? 0}`;
}

function imageAt(images: unknown[], index: unknown): IpsImage | undefined {
  const safeIndex = safeNonNegativeInteger(index);
  if (safeIndex === undefined) return undefined;
  const image = images[safeIndex];
  return isRecord(image) ? image as IpsImage : undefined;
}

function imgBasename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export async function parseIpsFile(filePath: string): Promise<ParsedIps> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(".ips file_path must be absolute");
  }

  // O_NONBLOCK prevents opening a FIFO from hanging before we can inspect it.
  // open() follows symlinks, while fstat() validates the actual opened target.
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
  );
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(".ips path must resolve to a regular file");
    }
    if (fileStat.size > MAX_IPS_FILE_BYTES) {
      throw new Error(
        `.ips file exceeds ${MAX_IPS_FILE_BYTES} byte size limit`,
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = MAX_IPS_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_IPS_FILE_BYTES) {
        throw new Error(
          `.ips file exceeds ${MAX_IPS_FILE_BYTES} byte size limit`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return parseIpsContent(Buffer.concat(chunks, totalBytes).toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Convert ParsedIps into our generic ParsedStack so computeSignature works. */
export function ipsToParsedStack(p: ParsedIps): ParsedStack {
  const identity = signatureIdentity(p);
  return {
    kind: "ios",
    ...(identity.exceptionType !== undefined
      ? { exception_class: identity.exceptionType }
      : {}),
    top_frames: identity.frames,
    ...(identity.signal !== undefined ? { signal: identity.signal } : {}),
    process: identity.processName,
    ...(identity.identityFrame !== undefined
      ? { identity_frames: [identity.identityFrame] }
      : {}),
  };
}

interface IpsSignatureIdentity {
  exceptionType?: string;
  signal?: string;
  processName: string;
  frames: string[];
  identityFrame?: string;
}

function signatureIdentity(p: ParsedIps): IpsSignatureIdentity {
  const exceptionType = nonEmptyString(p.exception_type);
  const signal = nonEmptyString(p.signal);
  const processName = nonEmptyString(p.bundle_id) ?? nonEmptyString(p.proc_name);
  const frames = Array.isArray(p.top_frames)
    ? p.top_frames
      .map(nonEmptyString)
      .filter((frame): frame is string => frame !== undefined)
    : [];
  const identityFrame = nonEmptyString(p.identity_frame);

  const missing: string[] = [];
  if (!exceptionType && !signal) missing.push("Exception Type or Signal");
  if (!processName) missing.push("Process");
  if (frames.length === 0) missing.push("at least one Frame");
  if (missing.length > 0) {
    throw new Error(`.ips crash lacks required signature fields: ${missing.join(", ")}`);
  }

  return {
    ...(exceptionType !== undefined ? { exceptionType } : {}),
    ...(signal !== undefined ? { signal } : {}),
    processName: processName!,
    frames,
    ...(identityFrame !== undefined ? { identityFrame } : {}),
  };
}

/**
 * Serialize an iOS crash into a compact, stable text block suitable for
 * report-mcp's required `stack` field.  The format is intentionally explicit
 * so signature.parseStack can reconstruct the same ParsedStack later when a
 * session is re-opened for deduplication.
 *
 * This is not the full (often very large) .ips JSON.  The original .ips file
 * remains archived separately; this block contains the identity-bearing
 * fields used by the analyzer.
 */
export function ipsToStackText(p: ParsedIps): string {
  const identity = signatureIdentity(p);
  const lines = ["iOS Crash"];

  if (identity.exceptionType) lines.push(`Exception Type: ${identity.exceptionType}`);
  if (identity.signal) lines.push(`Signal: ${identity.signal}`);
  const subtype = nonEmptyString(p.subtype);
  if (subtype) lines.push(`Exception Subtype: ${subtype}`);
  lines.push(`Process: ${identity.processName}`);
  const faultingThreadName = nonEmptyString(p.faulting_thread_name);
  if (faultingThreadName) {
    lines.push(`Faulting Thread: ${faultingThreadName}`);
  } else if (p.faulting_thread_index !== undefined) {
    lines.push(`Faulting Thread: ${p.faulting_thread_index}`);
  }
  if (identity.identityFrame) {
    lines.push(`Identity Frame: ${identity.identityFrame}`);
  }
  for (const [index, frame] of identity.frames.entries()) {
    lines.push(`Frame ${index}: ${frame}`);
  }
  return lines.join("\n");
}
