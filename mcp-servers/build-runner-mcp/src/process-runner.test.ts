import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ProcessRunError, ProcessRunner, runProcess } from "./process-runner.js";

const TEST_TIMINGS = {
  terminationGraceMs: 40,
  forceCloseGraceMs: 80,
  finalSettleGraceMs: 40,
  cleanupPollMs: 5,
} as const;

test("bounded process returns non-zero exits without treating them as containment failures", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(7)"], {
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
    env: {},
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "failed");
  assert.equal(
    result.stderrRawSha256,
    createHash("sha256").update(Buffer.from("failed")).digest("hex"),
  );
});

test("raw output digests distinguish byte streams that decode to the same UTF-8 text", async () => {
  const outputs = await Promise.all([0x80, 0x81].map((byte) => (
    runProcess(
      process.execPath,
      ["-e", `process.stdout.write(Buffer.from([${byte}]))`],
      { timeoutMs: 5_000, maxOutputBytes: 4096, env: {} },
    )
  )));
  assert.equal(outputs[0]!.stdout, outputs[1]!.stdout);
  assert.notEqual(outputs[0]!.stdoutRawSha256, outputs[1]!.stdoutRawSha256);
  assert.equal(
    outputs[0]!.stdoutRawSha256,
    createHash("sha256").update(Buffer.from([0x80])).digest("hex"),
  );
  assert.equal(
    outputs[1]!.stdoutRawSha256,
    createHash("sha256").update(Buffer.from([0x81])).digest("hex"),
  );
});

test("bounded process terminates timeout and output floods", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
      timeoutMs: 100,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "TIMEOUT",
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {
      timeoutMs: 5_000,
      maxOutputBytes: 128,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "OUTPUT_LIMIT",
  );
});

test("abort kills the admitted process group and leaves a reusable runner", async () => {
  const runner = new ProcessRunner({ testOnlyTimings: TEST_TIMINGS });
  const controller = new AbortController();
  const running = runner.run(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
    env: {},
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(new Error("test abort")), 30);
  await assert.rejects(
    running,
    (error: unknown) => error instanceof ProcessRunError && error.code === "ABORTED",
  );
  assert.deepEqual(runner.status(), {
    activeProcesses: 0,
    unresolvedProcesses: 0,
    poisoned: false,
    cleaning: false,
    closing: false,
    closed: false,
  });

  const afterAbort = await runner.run(process.execPath, ["-e", "process.stdout.write('ok')"], {
    timeoutMs: 2_000,
    maxOutputBytes: 4096,
    env: {},
  });
  assert.equal(afterAbort.stdout, "ok");
  await runner.close();
});

test("background process in the original group is killed and reported as a leak", async () => {
  const runner = new ProcessRunner({ testOnlyTimings: TEST_TIMINGS });
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      stdio: "ignore"
    });
    child.unref();
  `;
  await assert.rejects(
    runner.run(process.execPath, ["-e", script], {
      timeoutMs: 2_000,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "PROCESS_LEAK",
  );
  assert.equal(runner.status().activeProcesses, 0);
  assert.equal(runner.status().poisoned, false);
  await runner.close();
});

test("an unproved group poisons admission, cleanup can recover, and close is permanent", async () => {
  let groupPresent = true;
  const observedSignals: NodeJS.Signals[] = [];
  const runner = new ProcessRunner({
    testOnlyTimings: TEST_TIMINGS,
    testOnlyHooks: {
      processGroupExists: () => groupPresent,
      signalProcessGroup: (_processGroupId, signal) => {
        observedSignals.push(signal);
      },
    },
  });

  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "PROCESS_STUCK",
  );
  assert.deepEqual(observedSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(runner.status().poisoned, true);
  assert.equal(runner.status().unresolvedProcesses, 1);

  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "PROCESS_RUNNER_POISONED",
  );

  // Once the old group is absent, cleanup may forget the retained record. It
  // must not send the old PGID again after leader exit (PID-reuse defense).
  groupPresent = false;
  await runner.cleanup();
  assert.deepEqual(observedSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(runner.status().poisoned, false);
  assert.equal(runner.status().activeProcesses, 0);

  const recovered = await runner.run(process.execPath, ["-e", "process.stdout.write('recovered')"], {
    timeoutMs: 2_000,
    maxOutputBytes: 4096,
    env: {},
  });
  assert.equal(recovered.stdout, "recovered");
  await runner.close();
  assert.equal(runner.status().closed, true);
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "PROCESS_RUNNER_CLOSED",
  );
});

test("failed close remains retryable while admission stays closed", async () => {
  let groupPresent = true;
  const runner = new ProcessRunner({
    testOnlyTimings: TEST_TIMINGS,
    testOnlyHooks: {
      processGroupExists: () => groupPresent,
      signalProcessGroup: () => undefined,
    },
  });
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "PROCESS_STUCK",
  );
  await assert.rejects(
    runner.close(),
    (error: unknown) => error instanceof ProcessRunError
      && error.code === "PROCESS_CLEANUP_INCOMPLETE",
  );
  assert.equal(runner.status().closing, true);
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 2_000,
      maxOutputBytes: 4096,
      env: {},
    }),
    (error: unknown) => error instanceof ProcessRunError && error.code === "PROCESS_RUNNER_CLOSED",
  );

  groupPresent = false;
  await runner.close();
  assert.equal(runner.status().closed, true);
  assert.equal(runner.status().activeProcesses, 0);
});
