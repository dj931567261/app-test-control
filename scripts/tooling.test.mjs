import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isEnoent,
  isValidDeviceUdid,
  isWdaReadyJson,
  looksLikeCliHelp,
  sanitizeDiagnostic,
} from "./doctor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WDA_SCRIPT = path.join(HERE, "ios-wda-up.sh");
const INSTALL_SKILLS_SCRIPT = path.join(HERE, "install-skills.mjs");
const VALID_UDID = "00008030-0011223344556677";
const WDA_BUNDLE = "com.example.wda.runner.xctrunner";

test("doctor strictly accepts only boolean ready=true", () => {
  assert.equal(isWdaReadyJson('{"value":{"ready":true}}'), true);
  assert.equal(isWdaReadyJson('{"ready":true}'), true);
  assert.equal(isWdaReadyJson('{"value":{"ready":"true"}}'), false);
  assert.equal(isWdaReadyJson('{"sessionId":"abc","state":"success"}'), false);
  assert.equal(isWdaReadyJson("not-json"), false);
});

test("doctor recognizes non-zero CLI help without hiding real failures", () => {
  assert.equal(looksLikeCliHelp({ ok: false, code: 1, out: "Usage: tool OPTIONS", stderr: "" }), true);
  assert.equal(looksLikeCliHelp({ ok: false, code: 64, out: "", stderr: "OPTIONS:\n  -h --help" }), true);
  assert.equal(looksLikeCliHelp({ ok: false, code: "ENOENT", out: "", stderr: "" }), false);
  assert.equal(looksLikeCliHelp({ ok: false, code: 1, signal: "SIGSEGV", out: "Usage:", stderr: "" }), false);
  assert.equal(looksLikeCliHelp({ ok: false, code: 1, out: "", stderr: "dyld: missing library" }), false);
  assert.equal(isEnoent({ ok: false, code: "ENOENT" }), true);
});

test("doctor rejects malformed UDIDs and neutralizes terminal controls", () => {
  assert.equal(isValidDeviceUdid(VALID_UDID), true);
  assert.equal(isValidDeviceUdid("warning\u001b[2J"), false);
  assert.equal(sanitizeDiagnostic("line\n\u001b[2Jnext"), "line \\x1b[2Jnext");
  assert.equal(sanitizeDiagnostic("a".repeat(1005), 10), "aaaaaaaaaa…");
});

test("install-skills keeps Codex project/global scopes isolated", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "app-test-install-skills-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const scriptsDir = path.join(root, "scripts");
  const skillDir = path.join(root, "skills", "fixture-skill");
  const fakeHome = path.join(root, "home");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(skillDir, { recursive: true }),
    mkdir(fakeHome, { recursive: true }),
  ]);
  const fixtureScript = path.join(scriptsDir, "install-skills.mjs");
  await copyFile(INSTALL_SKILLS_SCRIPT, fixtureScript);
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fixture-skill\ndescription: fixture\n---\n\nFixture body.\n",
    "utf8",
  );
  const env = { ...process.env, HOME: fakeHome };

  const projectOnly = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--project", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(
    projectOnly.status,
    0,
    `${projectOnly.stdout}\n${projectOnly.stderr}`,
  );
  const agentsPath = path.join(root, "AGENTS.md");
  const agentsBefore = await readFile(agentsPath, "utf8");
  assert.match(agentsBefore, /Fixture body\./);
  await assert.rejects(
    readFile(path.join(fakeHome, ".codex", "skills", "fixture-skill", "SKILL.md")),
    /ENOENT/,
  );

  const globalOnly = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(globalOnly.status, 0, `${globalOnly.stdout}\n${globalOnly.stderr}`);
  assert.match(
    await readFile(
      path.join(fakeHome, ".codex", "skills", "fixture-skill", "SKILL.md"),
      "utf8",
    ),
    /Fixture body\./,
  );
  assert.equal(await readFile(agentsPath, "utf8"), agentsBefore);

  const conflicting = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--project", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(conflicting.status, 2);
  assert.match(conflicting.stderr, /互斥/);

  const wrongClientScope = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "cursor", "--project", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(wrongClientScope.status, 2);
  assert.match(wrongClientScope.stderr, /只适用于/);

  const globalSkill = path.join(
    fakeHome,
    ".codex",
    "skills",
    "fixture-skill",
    "SKILL.md",
  );
  const victim = path.join(root, "victim.txt");
  await writeFile(victim, "do-not-overwrite", "utf8");
  await unlink(globalSkill);
  await symlink(victim, globalSkill);
  const symlinkOverwrite = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(symlinkOverwrite.status, 1);
  assert.match(symlinkOverwrite.stderr, /拒绝覆盖符号链接/);
  assert.equal(await readFile(victim, "utf8"), "do-not-overwrite");

  await unlink(globalSkill);
  await link(victim, globalSkill);
  const hardlinkOverwrite = spawnSync(
    process.execPath,
    [fixtureScript, "--client", "codex", "--global", "--force"],
    { env, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(hardlinkOverwrite.status, 1);
  assert.match(hardlinkOverwrite.stderr, /拒绝覆盖硬链接/);
  assert.equal(await readFile(victim, "utf8"), "do-not-overwrite");
});

async function writeExecutable(file, content) {
  await writeFile(file, content, { mode: 0o700 });
  await chmod(file, 0o700);
}

async function makeMockEnvironment({ runner = "reliable", curlReady = true, wrapper = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "app-test-tooling-"));
  const bin = path.join(root, "bin");
  const runtime = path.join(root, "runtime");
  const logs = path.join(root, "logs");
  await Promise.all([
    mkdir(bin, { mode: 0o700 }),
    mkdir(runtime, { mode: 0o700 }),
    mkdir(logs, { mode: 0o700 }),
  ]);

  const trace = path.join(root, "ios.trace");
  const runwdaPid = path.join(root, "runwda.pid");
  const runwdaWorkerPid = path.join(root, "runwda-worker.pid");
  const forwardLauncherPid = path.join(root, "forward-launcher.pid");
  const forwardPid = path.join(root, "forward.pid");

  await writeExecutable(path.join(bin, "idevice_id"), `#!/usr/bin/env bash
printf '%s\\n' "$MOCK_UDID"
printf '%s\\n' 'mock diagnostic on stderr' >&2
`);

  await writeExecutable(path.join(bin, "ideviceinfo"), `#!/usr/bin/env bash
printf '%s\\n' '16.6'
`);

  await writeExecutable(path.join(bin, "ideviceinstaller"), `#!/usr/bin/env bash
case "$MOCK_RUNNER_KIND" in
  reliable) printf '%s, 1, WebDriverAgentRunner-Runner\\n' "$MOCK_WDA_BUNDLE" ;;
  generic) printf '%s\\n' 'com.example.OtherUITests.xctrunner, 1, OtherUITests' ;;
  none) : ;;
esac
`);

  await writeExecutable(path.join(bin, "ios"), `#!/usr/bin/env bash
printf '%s %s\\n' "$$" "$*" >>"$MOCK_TRACE"
case "\${1:-}" in
  runwda)
    printf '%s\\n' "$$" >"$MOCK_RUNWDA_PID"
    worker_file="$MOCK_RUNWDA_WORKER_PID"
    ;;
  forward)
    printf '%s\\n' "$$" >"$MOCK_FORWARD_LAUNCHER_PID"
    worker_file="$MOCK_FORWARD_PID"
    ;;
  *) exit 2 ;;
esac
child_pid=""
trap '[[ -z "$child_pid" ]] || kill "$child_pid" 2>/dev/null || true; exit 0' INT TERM
if [[ "$MOCK_WRAPPER" == "1" ]]; then
  /bin/bash -c '
    printf "%s\\n" "$$" >"$1"
    trap "exit 0" INT TERM
    while :; do sleep 1; done
  ' mock-worker "$worker_file" &
  child_pid=$!
  wait "$child_pid" || true
  exit 0
fi
printf '%s\\n' "$$" >"$worker_file"
while :; do
  sleep 1 &
  child_pid=$!
  wait "$child_pid" || true
done
`);

  await writeExecutable(path.join(bin, "curl"), `#!/usr/bin/env bash
if [[ "$MOCK_CURL_READY" == "1" && -s "$MOCK_FORWARD_PID" ]]; then
  printf '%s\\n' '{"value":{"ready":true}}'
  exit 0
fi
exit 7
`);

  await writeExecutable(path.join(bin, "lsof"), `#!/usr/bin/env bash
if [[ " $* " == *" -tiTCP:8100 "* ]]; then
  if [[ -n "\${MOCK_LISTENER_PID:-}" ]]; then
    printf '%s\\n' "$MOCK_LISTENER_PID"
  elif [[ -s "$MOCK_FORWARD_PID" ]]; then
    listener_pid="$(cat "$MOCK_FORWARD_PID")"
    kill -0 "$listener_pid" 2>/dev/null && printf '%s\\n' "$listener_pid"
  fi
  exit 0
fi
if [[ " $* " == *" -d txt "* ]]; then
  printf 'p%s\\nn%s\\n' "\${MOCK_LISTENER_PID:-0}" "$MOCK_PROCESS_EXECUTABLE"
  exit 0
fi
exit 0
`);

  await writeExecutable(path.join(bin, "ps"), `#!/usr/bin/env bash
args=" $* "
if [[ "$args" == *" -axo pid=,ppid= "* ]]; then
  if [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_FORWARD_PID" && -s "$MOCK_FORWARD_LAUNCHER_PID" ]]; then
    printf '%s %s\\n' "$(cat "$MOCK_FORWARD_PID")" "$(cat "$MOCK_FORWARD_LAUNCHER_PID")"
  fi
  if [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_RUNWDA_WORKER_PID" && -s "$MOCK_RUNWDA_PID" ]]; then
    printf '%s %s\\n' "$(cat "$MOCK_RUNWDA_WORKER_PID")" "$(cat "$MOCK_RUNWDA_PID")"
  fi
  exit 0
fi
pid=""
previous=""
for arg in "$@"; do
  [[ "$previous" == "-p" ]] && pid="$arg"
  previous="$arg"
done
if [[ "$args" == *" uid= "* ]]; then
  printf '%s\\n' "$MOCK_UID"
elif [[ "$args" == *" ppid= "* ]]; then
  if [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_FORWARD_PID" && "$pid" == "$(cat "$MOCK_FORWARD_PID")" && -s "$MOCK_FORWARD_LAUNCHER_PID" ]]; then
    cat "$MOCK_FORWARD_LAUNCHER_PID"
  elif [[ "$MOCK_WRAPPER" == "1" && -s "$MOCK_RUNWDA_WORKER_PID" && "$pid" == "$(cat "$MOCK_RUNWDA_WORKER_PID")" && -s "$MOCK_RUNWDA_PID" ]]; then
    cat "$MOCK_RUNWDA_PID"
  else
    printf '%s\\n' '1'
  fi
elif [[ "$args" == *" lstart= "* ]]; then
  printf 'Mon Jul 28 12:34:56 2026 pid-%s\\n' "$pid"
elif [[ "$args" == *" command= "* ]]; then
  printf '%s %s\\n' "$MOCK_PROCESS_EXECUTABLE" "$pid"
else
  exit 1
fi
`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: runtime,
    WDA_LOG_DIR: logs,
    MOCK_UDID: VALID_UDID,
    MOCK_WDA_BUNDLE: WDA_BUNDLE,
    MOCK_RUNNER_KIND: runner,
    MOCK_CURL_READY: curlReady ? "1" : "0",
    MOCK_TRACE: trace,
    MOCK_RUNWDA_PID: runwdaPid,
    MOCK_RUNWDA_WORKER_PID: runwdaWorkerPid,
    MOCK_FORWARD_LAUNCHER_PID: forwardLauncherPid,
    MOCK_FORWARD_PID: forwardPid,
    MOCK_IOS_PATH: path.join(bin, "ios"),
    MOCK_PROCESS_EXECUTABLE: process.execPath,
    MOCK_UID: String(process.getuid()),
    MOCK_WRAPPER: wrapper ? "1" : "0",
  };

  return {
    root,
    bin,
    runtime,
    logs,
    trace,
    runwdaPid,
    runwdaWorkerPid,
    forwardLauncherPid,
    forwardPid,
    env,
  };
}

function runWda(env, timeout = 30_000, args = []) {
  return spawnSync("/bin/bash", [WDA_SCRIPT, ...args], {
    env,
    encoding: "utf8",
    timeout,
  });
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  assert.fail(`process ${pid} did not exit within ${timeoutMs}ms`);
}

async function stopRecordedProcesses(...pidFiles) {
  for (const file of pidFiles) {
    let pid;
    try {
      pid = Number((await readFile(file, "utf8")).trim());
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        pid = null;
        break;
      }
    }
    if (pid) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

async function withMockEnvironment(options, fn) {
  const mock = await makeMockEnvironment(options);
  try {
    await fn(mock);
  } finally {
    await stopRecordedProcesses(
      mock.forwardPid,
      mock.forwardLauncherPid,
      mock.runwdaWorkerPid,
      mock.runwdaPid,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(mock.root, { recursive: true, force: true });
  }
}

test("ios-wda keeps stderr out of UDIDs and creates private unique logs", async () => {
  await withMockEnvironment({}, async (mock) => {
    const result = runWda(mock.env);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`目标设备：${VALID_UDID}`));
    assert.match(result.stderr, /mock diagnostic on stderr/);

    const runDirs = await readdir(mock.logs);
    assert.equal(runDirs.length, 1);
    assert.match(runDirs[0], /^app-test-ctrl-wda\./);
    const privateDir = path.join(mock.logs, runDirs[0]);
    const dirStat = await lstat(privateDir);
    assert.equal(dirStat.isDirectory(), true);
    assert.equal(dirStat.isSymbolicLink(), false);
    assert.equal(dirStat.mode & 0o777, 0o700);

    const logFiles = await readdir(privateDir);
    assert.equal(logFiles.length, 2);
    for (const name of logFiles) {
      const fileStat = await lstat(path.join(privateDir, name));
      assert.equal(fileStat.isFile(), true);
      assert.equal(fileStat.isSymbolicLink(), false);
      assert.equal(fileStat.mode & 0o777, 0o600);
    }

    const trace = await readFile(mock.trace, "utf8");
    assert.match(trace, new RegExp(`runwda --udid=${VALID_UDID}`));
    assert.match(trace, new RegExp(`--bundleid=${WDA_BUNDLE}`));
    assert.match(trace, new RegExp(`forward 8100 8100 --udid=${VALID_UDID}`));
  });
});

test("ios-wda refuses an unverified generic xctrunner", async () => {
  await withMockEnvironment({ runner: "generic", curlReady: false }, async (mock) => {
    const result = runWda(mock.env);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /没有任何候选具备可靠 WDA 身份/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda rejects malformed device-list data before process matching", async () => {
  await withMockEnvironment({}, async (mock) => {
    const result = runWda({ ...mock.env, MOCK_UDID: "warning-from-stdout" });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /返回了非法 UDID/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda refuses a symlink log parent", async () => {
  await withMockEnvironment({}, async (mock) => {
    const realLogs = path.join(mock.root, "real-logs");
    const linkLogs = path.join(mock.root, "linked-logs");
    await mkdir(realLogs, { mode: 0o700 });
    await symlink(realLogs, linkLogs);
    const result = runWda({ ...mock.env, WDA_LOG_DIR: linkLogs });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /WDA_LOG_DIR 不能是符号链接/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda serializes concurrent starts with a per-port lock", async () => {
  await withMockEnvironment({}, async (mock) => {
    const stateDir = path.join(mock.runtime, `app-test-ctrl-wda-state-${process.getuid()}`);
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(path.join(stateDir, "port-8100.lock"), { mode: 0o700 });
    const result = runWda(mock.env);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /另一个 WDA 启动流程/);
    await assert.rejects(readFile(mock.trace, "utf8"), /ENOENT/);
  });
});

test("ios-wda managed stop refuses a symlink state file", async () => {
  await withMockEnvironment({}, async (mock) => {
    const stateDir = path.join(mock.runtime, `app-test-ctrl-wda-state-${process.getuid()}`);
    await mkdir(stateDir, { mode: 0o700 });
    const victim = path.join(mock.root, "state-victim");
    await writeFile(victim, "not-managed-state\n", { mode: 0o600 });
    await symlink(victim, path.join(stateDir, "port-8100.state"));

    const result = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /托管状态文件不安全/);
    assert.equal(await readFile(victim, "utf8"), "not-managed-state\n");
  });
});

test("ios-wda never kills an unknown listener without managed state", async () => {
  await withMockEnvironment({ curlReady: false }, async (mock) => {
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const result = runWda({ ...mock.env, MOCK_LISTENER_PID: String(sleeper.pid) });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /未知进程或另一台设备占用/);
      assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
    } finally {
      try { sleeper.kill("SIGTERM"); } catch {}
    }
  });
});

test("ios-wda reuses an npm-style wrapper whose listener is a child process", async () => {
  await withMockEnvironment({ wrapper: true }, async (mock) => {
    assert.notEqual(mock.env.MOCK_PROCESS_EXECUTABLE, mock.env.MOCK_IOS_PATH);

    const first = runWda(mock.env);
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    const launcherPid = Number((await readFile(mock.forwardLauncherPid, "utf8")).trim());
    const listenerPid = Number((await readFile(mock.forwardPid, "utf8")).trim());
    assert.notEqual(listenerPid, launcherPid);

    const traceBefore = await readFile(mock.trace, "utf8");
    assert.equal(traceBefore.trim().split("\n").length, 2);

    const second = runWda(mock.env);
    assert.equal(second.error, undefined);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /无需重复拉起/);

    const traceAfter = await readFile(mock.trace, "utf8");
    assert.equal(traceAfter, traceBefore, "幂等复用不应再启动 runwda/forward");
  });
});

test("ios-wda managed stop rejects hard-linked state then stops wrapper trees", async () => {
  await withMockEnvironment({ wrapper: true }, async (mock) => {
    const first = runWda(mock.env);
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /ios-wda-up\.sh --stop/);

    const stateDir = path.join(mock.runtime, `app-test-ctrl-wda-state-${process.getuid()}`);
    const stateFile = path.join(stateDir, "port-8100.state");
    const originalState = await readFile(stateFile, "utf8");
    const extraLink = path.join(mock.root, "state-hardlink");
    await link(stateFile, extraLink);

    const refused = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(refused.status, 1, `${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stderr, /hard links are not allowed/);

    const launcherPids = await Promise.all([
      mock.forwardLauncherPid,
      mock.runwdaPid,
    ].map(async (file) => Number((await readFile(file, "utf8")).trim())));
    for (const pid of launcherPids) {
      assert.doesNotThrow(() => process.kill(pid, 0), "拒绝不安全状态时不得停止进程");
    }

    await unlink(extraLink);
    const stateLines = originalState.trimEnd().split("\n");
    stateLines[4] = "0".repeat(64);
    await writeFile(stateFile, `${stateLines.join("\n")}\n`, "utf8");
    const reusedPidRefused = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(reusedPidRefused.status, 1);
    assert.match(reusedPidRefused.stderr, /身份不匹配/);
    for (const pid of launcherPids) {
      assert.doesNotThrow(
        () => process.kill(pid, 0),
        "任一身份不匹配时都应在发信号前整体中止",
      );
    }
    await writeFile(stateFile, originalState, "utf8");

    const workerPids = await Promise.all([
      mock.forwardPid,
      mock.runwdaWorkerPid,
    ].map(async (file) => Number((await readFile(file, "utf8")).trim())));

    const stopped = runWda(mock.env, 10_000, ["--stop"]);
    assert.equal(stopped.error, undefined);
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stdout, /已安全停止/);
    await assert.rejects(readFile(stateFile, "utf8"), /ENOENT/);

    for (const pid of [...launcherPids, ...workerPids]) {
      await waitForProcessExit(pid);
    }
  });
});
