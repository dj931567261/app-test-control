// Unit tests for the pure helpers behind ios_pull_device_crashes.
// These guard the since_minutes filtering — the logic that decides whether a
// real crash is surfaced or dropped — without needing a physical device.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCopiedReports,
  parseReportTimestamp,
  filterReportsSince,
} from "./ios-device.js";

test("parseCopiedReports extracts paths from 'Copy:' lines, stripping leading slash", () => {
  const stdout = [
    "DeviceName ...",
    "Copy: /Runner-2025-04-27-173725.ips",
    "Copy: /ExcUserFault_Zalo-2025-04-22-141141.ips",
    "Copy:/no-space-2025-01-01-000000.ips",
    "Done.",
  ].join("\n");
  assert.deepEqual(parseCopiedReports(stdout), [
    "Runner-2025-04-27-173725.ips",
    "ExcUserFault_Zalo-2025-04-22-141141.ips",
    "no-space-2025-01-01-000000.ips",
  ]);
});

test("parseCopiedReports returns [] when nothing was copied", () => {
  assert.deepEqual(parseCopiedReports("DeviceName foo\nNothing to copy\n"), []);
});

test("parseReportTimestamp parses the embedded wall-clock stamp", () => {
  const ts = parseReportTimestamp("Runner-2025-04-27-173725.ips");
  assert.notEqual(ts, null);
  // Local time 2025-04-27 17:37:25 — compare via the same local constructor.
  assert.equal(ts, new Date(2025, 3, 27, 17, 37, 25).getTime());
});

test("parseReportTimestamp tolerates prefixes/suffixes around the stamp", () => {
  assert.notEqual(
    parseReportTimestamp("ExcUserFault_Zalo-2025-04-22-141141.ips"),
    null,
  );
  assert.notEqual(
    parseReportTimestamp("Analytics-Journal-90Day-2025-05-18-080418.ips.ca"),
    null,
  );
});

test("parseReportTimestamp returns null when there is no stamp", () => {
  assert.equal(parseReportTimestamp("log-bb-stats.plist"), null);
  assert.equal(parseReportTimestamp("README"), null);
});

test("filterReportsSince keeps only reports within the window", () => {
  const now = new Date(2025, 3, 27, 18, 0, 0).getTime(); // 18:00
  const files = [
    "App-2025-04-27-175500.ips", // 5 min ago — keep
    "App-2025-04-27-173000.ips", // 30 min ago — drop (window 10)
    "App-2025-04-20-120000.ips", // days ago — drop
  ];
  assert.deepEqual(filterReportsSince(files, 10, now), [
    "App-2025-04-27-175500.ips",
  ]);
});

test("filterReportsSince keeps unparseable names (never silently drop a crash)", () => {
  const now = new Date(2025, 3, 27, 18, 0, 0).getTime();
  const files = [
    "weird-name-no-stamp.ips", // unparseable — keep
    "App-2025-04-20-120000.ips", // old — drop
  ];
  assert.deepEqual(filterReportsSince(files, 10, now), [
    "weird-name-no-stamp.ips",
  ]);
});

test("filterReportsSince includes reports exactly at the cutoff boundary", () => {
  const now = new Date(2025, 3, 27, 18, 0, 0).getTime();
  const files = ["App-2025-04-27-175000.ips"]; // exactly 10 min ago
  assert.deepEqual(filterReportsSince(files, 10, now), [
    "App-2025-04-27-175000.ips",
  ]);
});
