import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PREFIXED_ART_CRASH = `\
07-30 18:11:51.919 17753 17753 E AndroidRuntime: FATAL EXCEPTION: main
07-30 18:11:51.919 17753 17753 E AndroidRuntime: Process: com.example.app, PID: 17753
07-30 18:11:51.919 17753 17753 E AndroidRuntime: java.lang.RuntimeException: wrapper
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread.handleReceiver(ActivityThread.java:5017)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread.-$$Nest$mhandleReceiver(Unknown Source:0)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat android.app.ActivityThread$H.handleMessage(ActivityThread.java:2667)
07-30 18:11:51.919 17753 17753 E AndroidRuntime: Caused by: java.lang.IllegalStateException: root
07-30 18:11:51.919 17753 17753 E AndroidRuntime: \tat com.example.app.DebugCrashReceiver.onReceive(DebugCrashReceiver.kt:20)
`;

test("compute_signature preserves the raw Java legacy fingerprint", { timeout: 10_000 }, async () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(sourceDir, "index.ts")],
  });
  const client = new Client({ name: "analyzer-index-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "compute_signature",
      arguments: { stack: PREFIXED_ART_CRASH },
    });
    assert.notEqual(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    const payload = JSON.parse(text) as {
      signature_version?: unknown;
      legacy_fingerprint?: unknown;
    };
    assert.equal(payload.signature_version, "java-v2");
    assert.equal(payload.legacy_fingerprint, "e4823a51cd4e");

    const privateMarker = "analyzer-private-path-marker";
    const missingResult = await client.callTool({
      name: "analyze_session",
      arguments: {
        session_dir: path.join(os.tmpdir(), privateMarker, "missing-session"),
      },
    });
    assert.equal(missingResult.isError, true);
    const diagnostic = (missingResult.content as Array<{ type: string; text?: string }>)
      .map((item) => item.text ?? "")
      .join("\n");
    assert.equal(diagnostic.includes(privateMarker), false);
    assert.match(diagnostic, /<PATH>/);
  } finally {
    await client.close();
  }
});
