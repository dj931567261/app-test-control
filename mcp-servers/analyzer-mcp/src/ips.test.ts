import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_IPS_FIELD_CHARS,
  MAX_IPS_FILE_BYTES,
  assertIpsContentSize,
  parseIpsContent,
  parseIpsFile,
  ipsToParsedStack,
  ipsToStackText,
} from "./ips.js";
import { computeSignature, parseStack } from "./signature.js";
import { dedupCrashes } from "./dedup.js";

const execFileAsync = promisify(execFile);

const SAMPLE = [
  JSON.stringify({
    app_name: "MyApp",
    timestamp: "2026-05-14 16:00:00.00 +0800",
    app_version: "1.2.3",
    bundleID: "com.example.myapp",
    bug_type: "309",
    os_version: "iOS 17.5 (21F79)",
    name: "MyApp",
  }),
  JSON.stringify({
    procName: "MyApp",
    exception: {
      type: "EXC_BAD_ACCESS",
      signal: "SIGSEGV",
      subtype: "KERN_INVALID_ADDRESS at 0x00000000000001c0",
      codes: "0x1, 0x1c0",
    },
    faultingThread: 0,
    threads: [
      {
        triggered: true,
        name: "main",
        frames: [
          { imageOffset: 12345, imageIndex: 1 },
          { imageOffset: 67890, imageIndex: 2, symbol: "FooViewController.tap", symbolLocation: 42 },
          { imageOffset: 11111, imageIndex: 1 },
        ],
      },
      // a non-triggered thread to make sure we pick the right one
      { name: "queue:com.apple.main-thread", frames: [{ imageOffset: 99, imageIndex: 0 }] },
    ],
    usedImages: [
      { name: "libsystem_kernel.dylib", path: "/usr/lib/system/libsystem_kernel.dylib" },
      { name: "MyApp", path: "/Applications/MyApp.app/MyApp" },
      { name: "Foundation", path: "/System/Library/Frameworks/Foundation.framework/Foundation" },
    ],
  }),
].join("\n");

function sampleWithFrames(frames: unknown[]): string {
  return [
    JSON.stringify({
      app_name: "MyApp",
      bundleID: "com.example.myapp",
      bug_type: "309",
      name: "MyApp",
    }),
    JSON.stringify({
      procName: "MyApp",
      exception: { type: "EXC_CRASH", signal: "SIGABRT" },
      faultingThread: 0,
      threads: [{ triggered: true, name: "main", frames }],
      usedImages: [
        {
          name: "CoreFoundation",
          path: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
        },
        { name: "MyApp", path: "/Applications/MyApp.app/MyApp" },
      ],
    }),
  ].join("\n");
}

function commonExceptionPrefix(fourthSymbol: string): string {
  return sampleWithFrames([
    { imageIndex: 0, symbol: "__exceptionPreprocess", symbolLocation: 1 },
    { imageIndex: 0, symbol: "objc_exception_throw", symbolLocation: 2 },
    { imageIndex: 0, symbol: "common_raise", symbolLocation: 3 },
    { imageIndex: 1, symbol: fourthSymbol, symbolLocation: 4 },
    { imageIndex: 0, symbol: "UIApplicationMain", symbolLocation: 5 },
  ]);
}

test("parseIpsContent extracts header + exception", () => {
  const p = parseIpsContent(SAMPLE);
  assert.equal(p.proc_name, "MyApp");
  assert.equal(p.bundle_id, "com.example.myapp");
  assert.equal(p.exception_type, "EXC_BAD_ACCESS");
  assert.equal(p.signal, "SIGSEGV");
  assert.match(p.subtype!, /KERN_INVALID_ADDRESS/);
  assert.equal(p.header.timestamp, "2026-05-14 16:00:00.00 +0800");
  assert.equal(p.header.bug_type, "309");
  assert.equal(p.faulting_thread_index, 0);
  assert.equal(p.faulting_thread_name, "main");
});

test("parseIpsContent sanitizes header output fields and rejects oversized scalars", () => {
  const body = SAMPLE.split("\n")[1]!;
  const sanitized = parseIpsContent([
    JSON.stringify({
      name: "MyApp",
      bundleID: "com.example.myapp",
      timestamp: { attacker: [1, 2, 3] },
      bug_type: ["309"],
      os_version: false,
    }),
    body,
  ].join("\n"));
  assert.equal(sanitized.header.timestamp, undefined);
  assert.equal(sanitized.header.bug_type, undefined);
  assert.equal(sanitized.header.os_version, undefined);

  assert.throws(
    () => parseIpsContent([
      JSON.stringify({
        name: "x".repeat(MAX_IPS_FIELD_CHARS + 1),
        bundleID: "com.example.myapp",
      }),
      body,
    ].join("\n")),
    /string field exceeds/i,
  );
});

test("parseIpsContent bounds malformed collection scanning and scalar coercion", () => {
  const rawFrames: unknown[] = Array.from({ length: 5000 }, () => null);
  rawFrames[4999] = { imageIndex: 0, symbol: "too-late" };
  const parsed = parseIpsContent([
    JSON.stringify({ name: "MyApp", bundleID: "com.example.myapp" }),
    JSON.stringify({
      exception: { type: "EXC_CRASH", signal: "SIGABRT" },
      faultingThread: 0,
      threads: [{ triggered: true, frames: rawFrames }],
      usedImages: Array.from({ length: 5000 }, () => null),
    }),
  ].join("\n"));
  assert.deepEqual(parsed.top_frames, []);

  const malformedSymbol = parseIpsContent(sampleWithFrames([
    { imageIndex: 1, imageOffset: 7, symbol: { attacker: true } },
  ]));
  assert.equal(malformedSymbol.top_frames[0], "MyApp+7");

  const malformedImagePath = JSON.parse(sampleWithFrames([
    { imageIndex: 1, imageOffset: 9 },
  ]).split("\n")[1]!) as { usedImages: Array<Record<string, unknown>> };
  malformedImagePath.usedImages[1]!["path"] = { attacker: true };
  const safelyParsed = parseIpsContent([
    sampleWithFrames([]).split("\n")[0]!,
    JSON.stringify(malformedImagePath),
  ].join("\n"));
  assert.equal(safelyParsed.top_frames[0], "MyApp+9");
});

test("parseIpsContent symbolicates when symbol present, else image+offset", () => {
  const p = parseIpsContent(SAMPLE);
  assert.equal(p.top_frames.length, 3);
  assert.equal(p.top_frames[0], "MyApp+12345");
  assert.equal(p.top_frames[1], "FooViewController.tap+42");
  assert.equal(p.top_frames[2], "MyApp+11111");
});

test("falls back to triggered=true when faultingThread index missing", () => {
  const body = JSON.parse(SAMPLE.split("\n")[1]!);
  delete body.faultingThread;
  const reframed = [SAMPLE.split("\n")[0], JSON.stringify(body)].join("\n");
  const p = parseIpsContent(reframed);
  assert.equal(p.top_frames[0], "MyApp+12345");
});

test("signature stable across timestamp / offset differences in non-key fields", () => {
  const a = computeSignature(ipsToParsedStack(parseIpsContent(SAMPLE)));
  // Change timestamp + a non-top-3 detail (shouldn't matter)
  const altered = SAMPLE.replace("2026-05-14", "2026-12-25");
  const b = computeSignature(ipsToParsedStack(parseIpsContent(altered)));
  assert.equal(a.fingerprint, b.fingerprint);
});

test("signature differs when exception_type changes", () => {
  const a = computeSignature(ipsToParsedStack(parseIpsContent(SAMPLE)));
  const altered = SAMPLE.replace("EXC_BAD_ACCESS", "EXC_CRASH");
  const b = computeSignature(ipsToParsedStack(parseIpsContent(altered)));
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("signature differs when top frame changes", () => {
  const a = computeSignature(ipsToParsedStack(parseIpsContent(SAMPLE)));
  const altered = SAMPLE.replace('"imageOffset":12345', '"imageOffset":99999');
  const b = computeSignature(ipsToParsedStack(parseIpsContent(altered)));
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("fourth app frame distinguishes crashes with the same three system frames", () => {
  const first = parseIpsContent(commonExceptionPrefix("MyApp.Payment.submit"));
  const second = parseIpsContent(commonExceptionPrefix("MyApp.Profile.save"));

  assert.equal(first.top_frames.length, 5);
  assert.deepEqual(first.top_frames.slice(0, 3), second.top_frames.slice(0, 3));
  assert.notEqual(first.top_frames[3], second.top_frames[3]);
  assert.equal(first.identity_frame, "MyApp.Payment.submit+4");
  assert.equal(second.identity_frame, "MyApp.Profile.save+4");

  const firstObjectSignature = computeSignature(ipsToParsedStack(first));
  const secondObjectSignature = computeSignature(ipsToParsedStack(second));
  assert.notEqual(firstObjectSignature.fingerprint, secondObjectSignature.fingerprint);

  // Persisting through report-mcp's canonical stack must retain the distinction.
  const firstTextSignature = computeSignature(ipsToStackText(first));
  const secondTextSignature = computeSignature(ipsToStackText(second));
  assert.equal(firstTextSignature.fingerprint, firstObjectSignature.fingerprint);
  assert.equal(secondTextSignature.fingerprint, secondObjectSignature.fingerprint);
  assert.notEqual(firstTextSignature.fingerprint, secondTextSignature.fingerprint);
});

test("iOS v2 exposes a legacy lookup fingerprint without merging across signature versions", () => {
  const parsed = parseIpsContent(commonExceptionPrefix("MyApp.Payment.submit"));
  const canonical = ipsToStackText(parsed);
  const legacyCanonical = canonical
    .split("\n")
    .filter((line) => !line.startsWith("Identity Frame:"))
    .filter((line) => {
      const match = /^Frame (\d+):/.exec(line);
      return !match || Number(match[1]) < 3;
    })
    .join("\n");

  const v2 = computeSignature(canonical);
  const v1 = computeSignature(legacyCanonical);
  assert.equal(v2.signature_version, "ios-v2");
  assert.equal(v1.signature_version, "v1");
  assert.notEqual(v2.fingerprint, v1.fingerprint);
  assert.equal(v2.legacy_fingerprint, v1.fingerprint);

  const deduped = dedupCrashes([
    { id: "old", kind: "ios", stack: legacyCanonical },
    { id: "new", kind: "ios", stack: canonical },
  ]);
  assert.equal(deduped.unique, 2);
  const oldGroup = deduped.groups.find((group) => group.instance_ids.includes("old"));
  const newGroup = deduped.groups.find((group) => group.instance_ids.includes("new"));
  assert.equal(oldGroup?.signature_version, "v1");
  assert.equal(newGroup?.signature_version, "ios-v2");
  assert.equal(oldGroup?.occurrences, 1);
  assert.equal(newGroup?.occurrences, 1);
  assert.equal(newGroup?.legacy_fingerprint, oldGroup?.fingerprint);
});

test("legacy iOS identities never participate in primary grouping", () => {
  const first = ipsToStackText(
    parseIpsContent(commonExceptionPrefix("MyApp.Payment.submit")),
  );
  const second = ipsToStackText(
    parseIpsContent(commonExceptionPrefix("MyApp.Profile.save")),
  );
  const legacy = first
    .split("\n")
    .filter((line) => !line.startsWith("Identity Frame:"))
    .filter((line) => {
      const match = /^Frame (\d+):/.exec(line);
      return !match || Number(match[1]) < 3;
    })
    .join("\n");

  const deduped = dedupCrashes([
    { id: "new-a", kind: "ios", stack: first },
    { id: "new-b", kind: "ios", stack: second },
    { id: "old-ambiguous", kind: "ios", stack: legacy },
  ]);
  assert.equal(deduped.unique, 3);
  const oldGroup = deduped.groups.find((group) =>
    group.instance_ids.includes("old-ambiguous")
  );
  assert.deepEqual(oldGroup?.instance_ids, ["old-ambiguous"]);
  assert.equal(oldGroup?.signature_version, "v1");
});

test("short v2 is domain-separated and its legacy lookup never changes primary grouping", () => {
  const legacy = [
    "iOS Crash",
    "Exception Type: EXC_BAD_ACCESS",
    "Signal: SIGSEGV",
    "Process: com.example.MyApp",
    "Frame 0: libsystem_kernel.dylib+1",
    "Frame 1: libobjc.A.dylib+2",
    "Frame 2: MyApp.Payment.submit+3",
  ].join("\n");
  const shortV2 = [
    "iOS Crash",
    "Exception Type: EXC_BAD_ACCESS",
    "Signal: SIGSEGV",
    "Process: com.example.MyApp",
    "Identity Frame: MyApp.Payment.submit+3",
    "Frame 0: libsystem_kernel.dylib+1",
    "Frame 1: libobjc.A.dylib+2",
    "Frame 2: MyApp.Payment.submit+3",
  ].join("\n");
  const otherV2 = [
    "iOS Crash",
    "Exception Type: EXC_BAD_ACCESS",
    "Signal: SIGSEGV",
    "Process: com.example.MyApp",
    "Identity Frame: MyApp.Profile.save+9",
    "Frame 0: libsystem_kernel.dylib+1",
    "Frame 1: libobjc.A.dylib+2",
    "Frame 2: MyApp.Payment.submit+3",
    "Frame 3: UIKitCore+4",
    "Frame 4: MyApp.Profile.save+9",
  ].join("\n");

  const legacySig = computeSignature(legacy);
  const shortSig = computeSignature(shortV2);
  assert.equal(legacySig.signature_version, "v1");
  assert.equal(shortSig.signature_version, "ios-v2");
  assert.notEqual(shortSig.fingerprint, legacySig.fingerprint);
  assert.equal(shortSig.legacy_fingerprint, legacySig.fingerprint);

  const deduped = dedupCrashes([
    { id: "new-short", kind: "ios", stack: shortV2 },
    { id: "new-other", kind: "ios", stack: otherV2 },
    { id: "old-ambiguous", kind: "ios", stack: legacy },
  ]);
  assert.equal(deduped.unique, 3);
  const oldGroup = deduped.groups.find((group) =>
    group.instance_ids.includes("old-ambiguous")
  );
  assert.deepEqual(oldGroup?.instance_ids, ["old-ambiguous"]);
  assert.equal(oldGroup?.signature_version, "v1");
});

test("first app-owned frame beyond the primary prefix participates in identity", () => {
  const withAppFrame = (symbol: string) => sampleWithFrames([
    { imageIndex: 0, symbol: "system_0", symbolLocation: 0 },
    { imageIndex: 0, symbol: "system_1", symbolLocation: 1 },
    { imageIndex: 0, symbol: "system_2", symbolLocation: 2 },
    { imageIndex: 0, symbol: "system_3", symbolLocation: 3 },
    { imageIndex: 0, symbol: "system_4", symbolLocation: 4 },
    { imageIndex: 1, symbol, symbolLocation: 5 },
  ]);
  const first = parseIpsContent(withAppFrame("MyApp.Flow.one"));
  const second = parseIpsContent(withAppFrame("MyApp.Flow.two"));

  assert.deepEqual(first.top_frames.slice(0, 4), second.top_frames.slice(0, 4));
  assert.equal(first.identity_frame, "MyApp.Flow.one+5");
  assert.equal(second.identity_frame, "MyApp.Flow.two+5");
  assert.notEqual(
    computeSignature(ipsToParsedStack(first)).fingerprint,
    computeSignature(ipsToParsedStack(second)).fingerprint,
  );
});

test("label is human-readable iOS form", () => {
  const sig = computeSignature(ipsToParsedStack(parseIpsContent(SAMPLE)));
  assert.match(sig.label, /EXC_BAD_ACCESS/);
  assert.match(sig.label, /MyApp\+12345/);
  assert.match(sig.label, /com\.example\.myapp/);
});

test("kind is 'ios'", () => {
  const stack = ipsToParsedStack(parseIpsContent(SAMPLE));
  assert.equal(stack.kind, "ios");
});

test("canonical stack text round-trips the iOS signature", () => {
  const parsed = parseIpsContent(SAMPLE);
  const stackText = ipsToStackText(parsed);
  assert.match(stackText, /^iOS Crash/m);
  assert.match(stackText, /^Exception Type: EXC_BAD_ACCESS$/m);
  assert.match(stackText, /^Frame 0: MyApp\+12345$/m);

  const fromObject = computeSignature(ipsToParsedStack(parsed));
  const fromText = computeSignature(parseStack(stackText));
  assert.equal(fromText.kind, "ios");
  assert.equal(fromText.fingerprint, fromObject.fingerprint);
  assert.equal(fromText.label, fromObject.label);
});

test("indented canonical iOS stack keeps all identity fields", () => {
  const parsed = parseIpsContent(commonExceptionPrefix("MyApp.Payment.submit"));
  const canonical = ipsToStackText(parsed);
  const indented = canonical
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

  const normal = computeSignature(canonical);
  const fromIndented = computeSignature(indented);
  assert.equal(fromIndented.fingerprint, normal.fingerprint);
  assert.deepEqual(parseStack(indented), parseStack(canonical));
});

test("canonical iOS stack rejects missing identity-bearing fields", () => {
  assert.throws(
    () => computeSignature("iOS Crash"),
    /missing Exception Type or Signal, Process, at least one Frame/i,
  );
  assert.throws(
    () => computeSignature("iOS Crash\nException Type: EXC_CRASH\nProcess: com.example.app"),
    /missing at least one Frame/i,
  );
  assert.throws(
    () => computeSignature("iOS Crash\nSignal: SIGABRT\nFrame 0: MyApp.crash+0"),
    /missing Process/i,
  );
  assert.throws(
    () => computeSignature({ kind: "ios", top_frames: [] }),
    /missing Exception Type or Signal, Process, at least one Frame/i,
  );
});

test("session dedup can re-hash stored canonical iOS stack text", () => {
  const stack = ipsToStackText(parseIpsContent(SAMPLE));
  const result = dedupCrashes([
    { id: "c1", kind: "ios", stack },
    { id: "c2", kind: "ios", stack },
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.unique, 1);
  assert.equal(result.groups[0]?.kind, "ios");
  assert.equal(result.groups[0]?.occurrences, 2);
});

test("missing body throws sensible error", () => {
  assert.throws(() => parseIpsContent("only-header"), /malformed/i);
  assert.throws(() => parseIpsContent(""), /malformed/i);
});

test("inline .ips content uses a UTF-8 byte limit", () => {
  assert.doesNotThrow(() => assertIpsContentSize("中", 3));
  assert.throws(() => assertIpsContentSize("中", 2), /exceeds 2 byte size limit/i);
  assert.throws(() => assertIpsContentSize("x", 0), /positive safe integer/i);
});

test("parseIpsFile requires an absolute path", async () => {
  await assert.rejects(parseIpsFile("relative/report.ips"), /must be absolute/i);
});

test("parseIpsFile reads regular files and follows a regular-file symlink", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "analyzer-ips-file-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "target.ips");
  await writeFile(target, SAMPLE, "utf8");
  assert.equal((await parseIpsFile(target)).bundle_id, "com.example.myapp");

  if (process.platform !== "win32") {
    const link = path.join(dir, "linked.ips");
    await symlink(target, link);
    assert.equal((await parseIpsFile(link)).proc_name, "MyApp");
  }
});

test("parseIpsFile rejects files larger than the hard limit", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "analyzer-ips-large-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const oversized = path.join(dir, "oversized.ips");
  await writeFile(oversized, "", "utf8");
  await truncate(oversized, MAX_IPS_FILE_BYTES + 1);

  await assert.rejects(parseIpsFile(oversized), /exceeds .* size limit/i);
});

test("parseIpsFile rejects character devices and FIFOs without blocking", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX special-file test");
    return;
  }

  await assert.rejects(parseIpsFile("/dev/null"), /regular file/i);

  const dir = await mkdtemp(path.join(os.tmpdir(), "analyzer-ips-fifo-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, "report.ips");
  await execFileAsync("mkfifo", [fifo]);
  await assert.rejects(parseIpsFile(fifo), /regular file/i);
});
