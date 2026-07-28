import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIpsContent, ipsToParsedStack, ipsToStackText } from "./ips.js";
import { computeSignature, parseStack } from "./signature.js";
import { dedupCrashes } from "./dedup.js";

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
