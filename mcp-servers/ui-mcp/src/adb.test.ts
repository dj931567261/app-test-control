import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  adbErrorFromFailure,
  AdbAbortError,
  AdbError,
  AdbDeadlineError,
  clearFocusedText,
  inputText,
  runAdb,
} from "./adb.js";
import { dumpHierarchy } from "./uiautomator.js";
import { waitForElementCore } from "./wait-for-element.js";

async function installSlowFakeAdb(t: TestContext): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ui-mcp-fake-adb-"));
  const executable = path.join(dir, "adb");
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\nserial-1\\tdevice\\n'
  exit 0
fi
case "$*" in
  *KEYCODE_MOVE_END*) /bin/sleep 0.10; exit 0 ;;
  *) exec /bin/sleep 2 ;;
esac
`);
  await chmod(executable, 0o755);
  const previous = process.env["ADB_BIN"];
  process.env["ADB_BIN"] = executable;
  t.after(async () => {
    if (previous === undefined) delete process.env["ADB_BIN"];
    else process.env["ADB_BIN"] = previous;
    await rm(dir, { recursive: true, force: true });
  });
}

async function installSelfTerminatingFakeAdb(t: TestContext): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ui-mcp-signaled-adb-"));
  const executable = path.join(dir, "adb");
  await writeFile(executable, "#!/bin/sh\nkill -TERM $$\n");
  await chmod(executable, 0o755);
  const previous = process.env["ADB_BIN"];
  process.env["ADB_BIN"] = executable;
  t.after(async () => {
    if (previous === undefined) delete process.env["ADB_BIN"];
    else process.env["ADB_BIN"] = previous;
    await rm(dir, { recursive: true, force: true });
  });
}

async function installStdinRecordingFakeAdb(t: TestContext): Promise<{
  argvFile: string;
  stdinFile: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ui-mcp-stdin-adb-"));
  const executable = path.join(dir, "adb");
  const argvFile = path.join(dir, "argv.txt");
  const stdinFile = path.join(dir, "stdin.txt");
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\nserial-1\\tdevice\\n'
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_ADB_ARGV_FILE"
/bin/cat > "$FAKE_ADB_STDIN_FILE"
`);
  await chmod(executable, 0o755);
  const previous = process.env["ADB_BIN"];
  const previousArgv = process.env["FAKE_ADB_ARGV_FILE"];
  const previousStdin = process.env["FAKE_ADB_STDIN_FILE"];
  process.env["ADB_BIN"] = executable;
  process.env["FAKE_ADB_ARGV_FILE"] = argvFile;
  process.env["FAKE_ADB_STDIN_FILE"] = stdinFile;
  t.after(async () => {
    if (previous === undefined) delete process.env["ADB_BIN"];
    else process.env["ADB_BIN"] = previous;
    if (previousArgv === undefined) delete process.env["FAKE_ADB_ARGV_FILE"];
    else process.env["FAKE_ADB_ARGV_FILE"] = previousArgv;
    if (previousStdin === undefined) delete process.env["FAKE_ADB_STDIN_FILE"];
    else process.env["FAKE_ADB_STDIN_FILE"] = previousStdin;
    await rm(dir, { recursive: true, force: true });
  });
  return { argvFile, stdinFile };
}

async function installTermIgnoringFakeAdb(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ui-mcp-term-ignoring-adb-"));
  const executable = path.join(dir, "adb");
  const pidFile = path.join(dir, "pids.json");
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\nserial-1\\tdevice\\n'
  exit 0
fi
trap '' TERM
(
  trap '' TERM
  while :; do /bin/sleep 1; done
) &
grandchild=$!
printf '[%s,%s]' "$$" "$grandchild" > "$FAKE_ADB_PID_FILE"
while :; do /bin/sleep 1; done
`);
  await chmod(executable, 0o755);
  const previous = process.env["ADB_BIN"];
  const previousPidFile = process.env["FAKE_ADB_PID_FILE"];
  process.env["ADB_BIN"] = executable;
  process.env["FAKE_ADB_PID_FILE"] = pidFile;
  t.after(async () => {
    if (previous === undefined) delete process.env["ADB_BIN"];
    else process.env["ADB_BIN"] = previous;
    if (previousPidFile === undefined) delete process.env["FAKE_ADB_PID_FILE"];
    else process.env["FAKE_ADB_PID_FILE"] = previousPidFile;
    try {
      const pids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    } catch { /* fixture may fail before publishing PIDs */ }
    await rm(dir, { recursive: true, force: true });
  });
  return pidFile;
}

async function assertRecordedProcessesGone(pidFile: string): Promise<void> {
  const pids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
  assert.equal(pids.length, 2, "fixture must publish parent and grandchild PIDs");
  for (const pid of pids) {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (Date.now() >= deadline) {
        assert.fail(`process ${pid} survived UI ADB cleanup`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

test("clearFocusedText shares one hard deadline across successive adb commands", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX fake adb fixture");
    return;
  }
  await installSlowFakeAdb(t);
  const started = Date.now();
  await assert.rejects(
    clearFocusedText({
      device: "serial-1",
      observedCharacters: 1,
      deadlineAtMs: Date.now() + 300,
    }),
    AdbDeadlineError,
  );
  assert.ok(Date.now() - started < 1200, "deadline should interrupt the second adb command");
});

test("clearFocusedText locks delete uncertainty before an abortable DEL command", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  await installSlowFakeAdb(t);
  const controller = new AbortController();
  let deleteStarted = false;
  await assert.rejects(
    clearFocusedText({
      device: "serial-1",
      observedCharacters: 1,
      signal: controller.signal,
      onDeleteStarted: () => {
        deleteStarted = true;
        controller.abort();
      },
    }),
    AdbAbortError,
  );
  assert.equal(deleteStarted, true);
});

test("dumpHierarchy applies the same deadline to device lookup and dump adb calls", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX fake adb fixture");
    return;
  }
  await installSlowFakeAdb(t);
  const started = Date.now();
  await assert.rejects(
    dumpHierarchy({
      device: "serial-1",
      retry: 1,
      deadlineAtMs: Date.now() + 200,
    }),
    AdbDeadlineError,
  );
  assert.ok(Date.now() - started < 1200, "deadline should interrupt hierarchy capture");
});

test("runAdb kills a TERM-ignoring descendant that inherits adb pipes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  const pidFile = await installTermIgnoringFakeAdb(t);
  const started = Date.now();
  await assert.rejects(runAdb(["hang"], { timeoutMs: 2_000 }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, "a pipe-inheriting adb descendant must not hang the request");
  await assertRecordedProcessesGone(pidFile);
});

test("shared UI deadline remains hard when adb ignores SIGTERM", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  const pidFile = await installTermIgnoringFakeAdb(t);
  const started = Date.now();
  await assert.rejects(
    runAdb(["hang"], {
      timeoutMs: 30_000,
      deadlineAtMs: Date.now() + 10_000,
    }),
    AdbDeadlineError,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 13_000, "hard deadline must escalate to SIGKILL");
  await assertRecordedProcessesGone(pidFile);
});

test("request abort kills a TERM-ignoring adb process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  const pidFile = await installTermIgnoringFakeAdb(t);
  const controller = new AbortController();
  const rejection = assert.rejects(
    runAdb(["hang"], { timeoutMs: 10_000, signal: controller.signal }),
    AdbAbortError,
  );
  const publishDeadline = Date.now() + 5_000;
  let published = false;
  while (true) {
    try {
      await readFile(pidFile, "utf8");
      published = true;
      break;
    } catch {
      if (Date.now() >= publishDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  controller.abort();
  await rejection;
  assert.equal(published, true, "fixture did not publish PIDs");
  if (published) await assertRecordedProcessesGone(pidFile);
});

test("waitForElementCore shares timeout across a slow hierarchy dump", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  await installSlowFakeAdb(t);
  const started = Date.now();
  const result = await waitForElementCore({
    device: "serial-1",
    strategies: [{ by: "text", value: "never" }],
    timeoutMs: 200,
    pollMs: 50,
    expect: "appear",
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.ok(Date.now() - started < 1_500, "one slow dump must not overrun the poll timeout");
});

test("an early adb signal is not misclassified as a shared-deadline timeout", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  await installSelfTerminatingFakeAdb(t);
  const started = Date.now();
  const deadlineAtMs = started + 5_000;
  await assert.rejects(
    runAdb(["die"], {
      timeoutMs: 10_000,
      deadlineAtMs,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AdbError);
      assert.ok(!(error instanceof AdbDeadlineError));
      assert.match(error.message, /signal SIGTERM/);
      return true;
    },
  );
  assert.ok(Date.now() < deadlineAtMs, "fixture must fail before the shared deadline");
});

test("inputText keeps sensitive text out of the host adb argv", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX executable fixture");
    return;
  }
  const { argvFile, stdinFile } = await installStdinRecordingFakeAdb(t);
  const secret = "token secret;echo injected|'quoted'";
  await inputText({ device: "serial-1", text: secret });
  const argv = await readFile(argvFile, "utf8");
  const stdin = await readFile(stdinFile, "utf8");
  assert.equal(argv.includes(secret), false);
  assert.equal(argv.includes("token"), false);
  assert.match(argv, /shell/);
  assert.match(stdin, /^input text /);
  assert.match(stdin, /exit\n$/);
  assert.ok(stdin.includes("token%ssecret"), "the quoted remote command is delivered over stdin");
});

test("adb diagnostics cannot amplify a bounded child buffer into a huge MCP error", () => {
  const stderr = "x".repeat(1024 * 1024);
  const error = adbErrorFromFailure(
    ["devices"],
    Object.assign(new Error("failed"), { stderr }),
  );
  assert.ok(error.stderr);
  assert.ok(Buffer.byteLength(error.stderr, "utf8") < 70 * 1024);
  assert.match(error.stderr, /truncated/);
});
