import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { RunnerConfig } from "./config.js";
import { DockerBackend, type SocketIdentity } from "./docker-backend.js";
import { ProcessRunner } from "./process-runner.js";

const DIGEST = "a".repeat(64);
const IMAGE_ID = "b".repeat(64);
const IMAGE = `example/android@sha256:${DIGEST}`;
const TEST_OWNED_SWEEP_SETTLE_MS = 5;
type FakePurpose = "probe" | "toolchain" | "gradle" | "artifact";

interface FakeDockerOptions {
  securityOptions?: readonly string[];
  runtimes?: Readonly<Record<string, unknown>>;
  failVersionMessage?: string;
  delayVersionMs?: number;
  corruptCreatePurpose?: FakePurpose;
  inspectDriftPurpose?: FakePurpose;
  inspectRuntimeDriftPurpose?: FakePurpose;
  inspectEnvironmentDriftPurpose?: FakePurpose;
  inspectEnvironmentDriftKind?: "extra" | "duplicate";
  failThreeRemovesPurpose?: FakePurpose;
  failThreeRemovesCommand?: string;
  delayCreatePurpose?: FakePurpose;
  delayCreateCommand?: string;
  createDelayMs?: number;
  quotaAttestor?: () => Promise<boolean>;
  processRunner?: ProcessRunner;
  socketIdentityReader?: () => Promise<SocketIdentity>;
}

interface FakeDocker {
  bin: string;
  log: string;
  state: string;
  dockerHost: string;
  close(): Promise<void>;
}

async function fakeDocker(root: string, options: FakeDockerOptions = {}): Promise<FakeDocker> {
  const bin = path.join(root, "fake-docker");
  const log = path.join(root, "docker-argv.log");
  const state = path.join(root, "docker-state.json");
  const socketPath = path.join(await realpath(root), "docker.sock");
  const serializedOptions = {
    securityOptions: options.securityOptions ?? ["name=seccomp,profile=builtin"],
    runtimes: options.runtimes ?? { runc: { path: "runc" } },
    failVersionMessage: options.failVersionMessage ?? "",
    delayVersionMs: options.delayVersionMs ?? 0,
    corruptCreatePurpose: options.corruptCreatePurpose ?? "",
    inspectDriftPurpose: options.inspectDriftPurpose ?? "",
    inspectRuntimeDriftPurpose: options.inspectRuntimeDriftPurpose ?? "",
    inspectEnvironmentDriftPurpose: options.inspectEnvironmentDriftPurpose ?? "",
    inspectEnvironmentDriftKind: options.inspectEnvironmentDriftKind ?? "extra",
    failThreeRemovesPurpose: options.failThreeRemovesPurpose ?? "",
    failThreeRemovesCommand: options.failThreeRemovesCommand ?? "",
    delayCreatePurpose: options.delayCreatePurpose ?? "",
    delayCreateCommand: options.delayCreateCommand ?? "",
    createDelayMs: options.createDelayMs ?? 0,
  };
  const script = `#!${process.execPath}
const fs=require('fs'), crypto=require('crypto'), path=require('path');
const log=${JSON.stringify(log)}, statePath=${JSON.stringify(state)}, image=${JSON.stringify(IMAGE)};
const imageId=${JSON.stringify(IMAGE_ID)}, options=${JSON.stringify(serializedOptions)};
const argv=process.argv.slice(2); fs.appendFileSync(log, JSON.stringify(argv)+'\\n');
let state={containers:{},removeFailures:{}}; try { state=JSON.parse(fs.readFileSync(statePath,'utf8')); } catch {}
state.containers ||= {}; state.removeFailures ||= {};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const out=(v)=>process.stdout.write(v+'\\n');
const values=(flag)=>argv.flatMap((value,index)=>value===flag&&index+1<argv.length?[argv[index+1]]:[]);
const value=(flag)=>values(flag).at(-1);
const pairs=(entries)=>Object.fromEntries(entries.map(entry=>{const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)]}));
const find=(ref)=>state.containers[ref]||Object.values(state.containers).find(item=>item.id===ref);
const size=(raw)=>{const match=/^(\\d+)m$/.exec(raw||'');return match?Number(match[1])*1024*1024:0};
if(argv[0]==='version'){
 if(options.delayVersionMs>0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,options.delayVersionMs)}
 if(options.failVersionMessage){process.stderr.write(options.failVersionMessage+'\\n');process.exit(1)}
 out('27.0.0|27.0.0');process.exit(0)
}
if(argv[0]==='info'){
 out(JSON.stringify({os:'linux',security_options:options.securityOptions,runtimes:options.runtimes}));process.exit(0)
}
if(argv[0]==='image'&&argv[1]==='inspect'){out('sha256:'+imageId+'|'+image+'|linux');process.exit(0)}
if(argv[0]==='create'){
 const id=crypto.randomBytes(32).toString('hex');
 const name=value('--name'), labels=pairs(values('--label')), purpose=labels['io.app-test-ctrl.build-runner.purpose'];
 const imageIndex=argv.indexOf(image), command=argv.slice(imageIndex+1);
 if(options.createDelayMs>0&&(options.delayCreatePurpose===purpose
   ||(options.delayCreateCommand&&command.includes(options.delayCreateCommand)))){
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,options.createDelayMs);
 }
 const mounts=values('--mount').map(raw=>{
   const parsed={}; for(const token of raw.split(',')){const i=token.indexOf('=');if(i>=0)parsed[token.slice(0,i)]=token.slice(i+1);else parsed[token]=true}
   const readOnly=parsed.ro===true;
   return {Type:'bind',Source:parsed.src,Destination:parsed.dst,Mode:readOnly?'ro':'rw',RW:!readOnly,Propagation:'rprivate'};
 });
 const tmpfs={}; for(const raw of values('--tmpfs')){const i=raw.indexOf(':');tmpfs[raw.slice(0,i)]=raw.slice(i+1)}
 const inspect={
   Id:id,Name:'/'+name,Image:'sha256:'+imageId,State:{Status:'created',Running:false},
   Config:{
     Image:image,User:value('--user'),WorkingDir:value('--workdir'),
     Entrypoint:[value('--entrypoint')],Cmd:command,
     Labels:{'image.label':'retained',...labels},
     Env:values('--env'),
     Healthcheck:{Test:['NONE']},Volumes:null,
   },
   HostConfig:{
     NetworkMode:value('--network'),ReadonlyRootfs:argv.includes('--read-only'),Privileged:false,
     CapDrop:values('--cap-drop'),CapAdd:null,SecurityOpt:values('--security-opt'),
     PidsLimit:Number(value('--pids-limit')),Memory:size(value('--memory')),
     MemorySwap:size(value('--memory-swap')),NanoCpus:Number(value('--cpus'))*1000000000,
     Init:argv.includes('--init'),LogConfig:{Type:value('--log-driver'),Config:{}},
     RestartPolicy:{Name:value('--restart'),MaximumRetryCount:0},
     Runtime:value('--runtime'),
     Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:null,
     PortBindings:{},PublishAllPorts:false,Tmpfs:tmpfs,
   },
   Mounts:mounts,
 };
 if(options.inspectDriftPurpose===purpose) inspect.HostConfig.NetworkMode='bridge';
 if(options.inspectRuntimeDriftPurpose===purpose) inspect.HostConfig.Runtime='unexpected-runtime';
 if(options.inspectEnvironmentDriftPurpose===purpose){
   if(options.inspectEnvironmentDriftKind==='duplicate') inspect.Config.Env.push(inspect.Config.Env[0]);
   else inspect.Config.Env.push('UNPLANNED_ENVIRONMENT=1');
 }
 state.containers[name]={id,name,purpose,argv,inspect}; save();
 out(options.corruptCreatePurpose===purpose?'corrupt-create-output':id); process.exit(0)
}
if(argv[0]==='start'){
 const name=argv.at(-1), item=state.containers[name]; if(!item){process.stderr.write('Error: No such container\\n');process.exit(1)}
 if(item.purpose==='probe'){
   const mount=item.inspect.Mounts.find(entry=>entry.Destination==='/workspace');
   const token=item.inspect.Config.Cmd.at(-1);
   fs.writeFileSync(path.join(mount.Source,'allowed'),token); process.stdout.write('probe-ok'); process.exit(0)
 }
 if(item.purpose==='toolchain'){
   process.stdout.write([
     'app-test-ctrl/android-toolchain-probe/v2',
     'app-test-ctrl:java-version:begin',
     'openjdk 17',
     'app-test-ctrl:java-version:end',
     'app-test-ctrl:cmdline-tools-pkg-revision:begin',
     '19.0',
     'app-test-ctrl:cmdline-tools-pkg-revision:end',
     'app-test-ctrl:apkanalyzer-help-contract:begin',
     'apkanalyzer',
     'manifest',
     'app-test-ctrl:apkanalyzer-help-contract:end',
     'app-test-ctrl:apksigner-version:begin',
     '0.9',
     'app-test-ctrl:apksigner-version:end',
     'app-test-ctrl:android-toolchain-probe:end',
     '',
   ].join('\\n')); process.exit(0)
 }
 process.stdout.write('BUILD_OK'); process.exit(0)
}
if(argv[0]==='rm'){
 const ref=argv.at(-1), item=find(ref);
 const failureKey=item&&(options.failThreeRemovesPurpose===item.purpose
   ? item.purpose
   : options.failThreeRemovesCommand&&item.argv.includes(options.failThreeRemovesCommand)?item.name:'');
 if(failureKey&&(state.removeFailures[failureKey]||0)<3){
   state.removeFailures[failureKey]=(state.removeFailures[failureKey]||0)+1; save(); process.stderr.write('forced fake removal failure\\n'); process.exit(1)
 }
 if(item) delete state.containers[item.name]; save(); out(ref); process.exit(0)
}
if(argv[0]==='container'&&argv[1]==='inspect'){
 const ref=argv.at(-1), item=find(ref);
 if(item){out(JSON.stringify([item.inspect]));process.exit(0)}
 process.stderr.write('Error: No such container: '+ref+'\\n'); process.exit(1)
}
if(argv[0]==='container'&&argv[1]==='ls'){
 const filter=value('--filter')||'';
 const match=/^label=([^=]+)=(.+)$/.exec(filter);
 if(!match){process.stderr.write('unsupported fake docker filter\\n');process.exit(2)}
 const [,labelKey,labelValue]=match;
 for(const item of Object.values(state.containers)){
   if(item.inspect?.Config?.Labels?.[labelKey]===labelValue) out(item.id);
 }
 process.exit(0)
}
process.stderr.write('unsupported fake docker command: '+argv.join(' ')+'\\n'); process.exit(2);
`;
  await writeFile(bin, script, { mode: 0o700 });
  await chmod(bin, 0o700);
  return {
    bin,
    log,
    state,
    dockerHost: `unix://${socketPath}`,
    close: async () => undefined,
  };
}

function config(dockerBin: string, dockerHost: string): RunnerConfig {
  return {
    backend: "docker",
    dockerBin,
    dockerHost,
    ociRuntime: "runc",
    image: IMAGE,
    javaHome: "/opt/java/openjdk",
    androidSdkRoot: "/opt/android-sdk",
    apkAnalyzer: "/opt/android-sdk/cmdline-tools/latest/bin/apkanalyzer",
    apkSigner: "/opt/android-sdk/build-tools/latest/apksigner",
    maxMemoryMb: 1024,
    maxCpus: 2,
    maxPids: 128,
    gradleHomeMb: 1024,
    tmpMb: 128,
    maxOutputBytes: 64 * 1024,
  };
}

async function readCalls(log: string): Promise<string[][]> {
  const content = await readFile(log, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

async function waitForCall(log: string, predicate: (call: string[]) => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await readCalls(log)).some(predicate)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for fake Docker call");
}

async function createBackend(
  t: TestContext,
  options: FakeDockerOptions = {},
): Promise<{ root: string; fake: FakeDocker; backend: DockerBackend }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-docker-test-"));
  const fake = await fakeDocker(root, options);
  const backend = new DockerBackend(config(fake.bin, fake.dockerHost), {
    testOnlyOwnedSweepSettleMs: TEST_OWNED_SWEEP_SETTLE_MS,
    readSocketIdentity: options.socketIdentityReader ?? (async () => ({
      device: 1,
      inode: 2,
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      mode: 0o600,
    })),
    testOnlyAttestHostWorkspaceDiskQuota: options.quotaAttestor ?? (async () => true),
    ...(options.processRunner === undefined
      ? {}
      : { testOnlyProcessRunner: options.processRunner }),
  });
  t.after(async () => {
    await backend.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  });
  await backend.initialize();
  return { root, fake, backend };
}

test("Docker backend rejects invalid test-only owner-sweep timings", () => {
  for (const value of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    "5",
  ] as unknown[]) {
    assert.throws(
      () => new DockerBackend(config("/bin/false", "unix:///tmp/docker.sock"), {
        testOnlyOwnedSweepSettleMs: value as number,
      }),
      /testOnlyOwnedSweepSettleMs must be a positive safe integer/,
    );
  }
});

test("Docker backend probes isolation and renders one inspected fail-closed Gradle plan", async (t) => {
  const { root, fake, backend } = await createBackend(t);
  const capability = await backend.probe();
  assert.equal(capability.available, true, JSON.stringify(capability));
  assert.equal(capability.identity?.dockerImageDigest, DIGEST);
  assert.equal(capability.identity?.dockerClientVersion, "27.0.0");
  assert.match(capability.identity?.dockerCliSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(capability.identity?.dockerSocketIdentitySha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(capability.identity?.ociRuntime, "runc");
  assert.match(capability.identity?.ociRuntimeDescriptorSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(capability.identity?.toolchainProbeSha256 ?? "", /^[a-f0-9]{64}$/);
  const profile = backend.sandboxProfile(capability.identity!);
  assert.equal(profile.oci_runtime, "runc");
  assert.equal(profile.oci_runtime_descriptor_ref, capability.identity?.ociRuntimeDescriptorSha256);

  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(cache, { mode: 0o500 });
  const result = await backend.runContainer({
    workspace,
    cacheSeed: cache,
    workdir: "/workspace",
    command: ["/bin/sh", "./gradlew", "--offline", "--no-daemon", "assembleDebug"],
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "BUILD_OK");

  const calls = await readCalls(fake.log);
  const createCalls = calls.filter((call) => call[0] === "create");
  const toolchainCreate = createCalls.find((call) =>
    call.some((value) => value === "io.app-test-ctrl.build-runner.purpose=toolchain"));
  assert.ok(toolchainCreate);
  assert.deepEqual(toolchainCreate.slice(-4), [
    IMAGE,
    "/opt/java/openjdk/bin/java",
    "/opt/android-sdk/cmdline-tools/latest/bin/apkanalyzer",
    "/opt/android-sdk/build-tools/latest/apksigner",
  ]);
  const buildCreate = createCalls.find((call) => call.includes("assembleDebug"));
  assert.ok(buildCreate);
  assert.deepEqual(buildCreate.slice(buildCreate.indexOf("--pull"), buildCreate.indexOf("--pull") + 2), [
    "--pull", "never",
  ]);
  assert.deepEqual(
    buildCreate.slice(buildCreate.indexOf("--runtime"), buildCreate.indexOf("--runtime") + 2),
    ["--runtime", "runc"],
  );
  assert.ok(buildCreate.includes("none"));
  assert.ok(buildCreate.includes("--read-only"));
  assert.ok(buildCreate.includes("ALL"));
  assert.ok(buildCreate.includes("no-new-privileges"));
  assert.equal(buildCreate.some((value) => value.startsWith("seccomp=")), false);
  assert.ok(buildCreate.includes("--no-healthcheck"));
  assert.ok(buildCreate.includes("--log-driver"));
  assert.ok(buildCreate.includes("--memory-swap"));
  assert.match(buildCreate[buildCreate.indexOf("--name") + 1] ?? "", /^app-test-ctrl-[a-f0-9]{32}$/);
  assert.ok(buildCreate.some((value) => value.startsWith(`${OWNER_LABEL_FOR_TEST()}=`)));
  assert.ok(buildCreate.some((value) => value.includes("dst=/workspace,rw")));
  assert.ok(buildCreate.some((value) => value.includes("dst=/cache-seed,ro")));
  assert.ok(buildCreate.some((value) => value.startsWith("/gradle-home:rw,")));
  assert.equal(buildCreate.some((value) => /GOOGLE_APPLICATION_CREDENTIALS|SSH_AUTH_SOCK/.test(value)), false);
  assert.deepEqual(buildCreate.slice(-6), [
    IMAGE,
    "/bin/sh",
    "./gradlew",
    "--offline",
    "--no-daemon",
    "assembleDebug",
  ]);
  const buildName = buildCreate[buildCreate.indexOf("--name") + 1];
  assert.ok(calls.some((call) => call[0] === "container" && call[1] === "inspect" && call.at(-1) === buildName));
  assert.ok(calls.some((call) => call[0] === "start" && call.at(-1) === buildName));
});

function OWNER_LABEL_FOR_TEST(): string {
  return "io.app-test-ctrl.build-runner.owner";
}

test("production Docker backend fails closed while the host workspace quota is unenforced", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-quota-test-"));
  const fake = await fakeDocker(root);
  const backend = new DockerBackend(config(fake.bin, fake.dockerHost), {
    testOnlyOwnedSweepSettleMs: TEST_OWNED_SWEEP_SETTLE_MS,
    readSocketIdentity: async () => ({
      device: 1,
      inode: 2,
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      mode: 0o600,
    }),
  });
  t.after(async () => {
    await backend.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  });
  await backend.initialize();

  const capability = await backend.probe();
  assert.deepEqual(capability, {
    available: false,
    backend: "docker",
    reasons: ["HOST_WORKSPACE_DISK_QUOTA_UNENFORCED"],
  });

  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);
  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/true"],
      timeoutMs: 1_000,
      maxOutputBytes: 4096,
    }),
    /must be probed before container creation/i,
  );
});

test("Docker container admission rejects workspace quota drift after a successful probe", async (t) => {
  let quotaEnforced = true;
  const { root, fake, backend } = await createBackend(t, {
    quotaAttestor: async () => quotaEnforced,
  });
  assert.equal((await backend.probe()).available, true);
  quotaEnforced = false;

  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);
  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/true"],
      timeoutMs: 1_000,
      maxOutputBytes: 4096,
    }),
    /HOST_WORKSPACE_DISK_QUOTA_UNENFORCED/,
  );

  const calls = await readCalls(fake.log);
  assert.equal(calls.some((call) => call[0] === "create" && call.includes("/bin/true")), false);
});

test("Docker probe requires the configured OCI runtime to be registered", async (t) => {
  const { fake, backend } = await createBackend(t, {
    runtimes: { "other-runtime": { path: "other-runtime" } },
  });
  const capability = await backend.probe();
  assert.equal(capability.available, false);
  assert.ok(capability.reasons.includes("DOCKER_OCI_RUNTIME_NOT_REGISTERED"));
  const calls = await readCalls(fake.log);
  assert.equal(calls.some((call) => call[0] === "create"), false);
});

test("Docker backend snapshots and freezes its configuration at construction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-config-freeze-test-"));
  const fake = await fakeDocker(root);
  const mutable = config(fake.bin, fake.dockerHost);
  const backend = new DockerBackend(mutable, {
    testOnlyOwnedSweepSettleMs: TEST_OWNED_SWEEP_SETTLE_MS,
    readSocketIdentity: async () => ({
      device: 1,
      inode: 2,
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      mode: 0o600,
    }),
    testOnlyAttestHostWorkspaceDiskQuota: async () => true,
  });
  mutable.ociRuntime = "other-runtime";
  mutable.apkAnalyzer = "/mutated/bin/apkanalyzer";
  t.after(async () => {
    await backend.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  });
  await backend.initialize();
  const capability = await backend.probe();
  assert.equal(capability.available, true, JSON.stringify(capability));
  assert.equal(capability.identity?.ociRuntime, "runc");
  assert.equal(backend.config.apkAnalyzer, "/opt/android-sdk/cmdline-tools/latest/bin/apkanalyzer");
});

test("Docker inspect requires the exact OCI runtime before start", async (t) => {
  const { fake, backend } = await createBackend(t, { inspectRuntimeDriftPurpose: "probe" });
  const capability = await backend.probe();
  assert.equal(capability.available, false);
  assert.match(capability.reasons.join(" "), /OCI_RUNTIME/);
  const calls = await readCalls(fake.log);
  const probeCreate = calls.find((call) =>
    call[0] === "create"
    && call.some((value) => value === "io.app-test-ctrl.build-runner.purpose=probe"));
  assert.ok(probeCreate);
  const name = probeCreate[probeCreate.indexOf("--name") + 1];
  assert.equal(calls.some((call) => call[0] === "start" && call.at(-1) === name), false);
});

test("Docker inspect rejects extra and duplicate environment entries", async (t) => {
  for (const kind of ["extra", "duplicate"] as const) {
    await t.test(kind, async (subtest) => {
      const { fake, backend } = await createBackend(subtest, {
        inspectEnvironmentDriftPurpose: "probe",
        inspectEnvironmentDriftKind: kind,
      });
      const capability = await backend.probe();
      assert.equal(capability.available, false);
      assert.match(
        capability.reasons.join(" "),
        kind === "duplicate" ? /ENVIRONMENT_DUPLICATE/ : /ENVIRONMENT_DRIFT/,
      );
      const calls = await readCalls(fake.log);
      const probeCreate = calls.find((call) =>
        call[0] === "create"
        && call.some((value) => value === "io.app-test-ctrl.build-runner.purpose=probe"));
      assert.ok(probeCreate);
      const name = probeCreate[probeCreate.indexOf("--name") + 1];
      assert.equal(calls.some((call) => call[0] === "start" && call.at(-1) === name), false);
    });
  }
});

test("Docker probe diagnostics do not expose a local socket path", async (t) => {
  const { backend } = await createBackend(t, {
    failVersionMessage: "cannot connect to unix:///Users/example/.docker/run/docker.sock",
  });
  const capability = await backend.probe();
  assert.equal(capability.available, false);
  const reasons = capability.reasons.join(" ");
  assert.equal(reasons.includes("/Users/example"), false);
  assert.match(reasons, /<DOCKER_SOCKET>/);
});

test("Docker probe rejects an unconfined seccomp daemon", async (t) => {
  const { fake, backend } = await createBackend(t, {
    securityOptions: ["name=seccomp,profile=unconfined"],
  });
  const capability = await backend.probe();
  assert.equal(capability.available, false);
  assert.ok(capability.reasons.includes("DOCKER_SECCOMP_UNCONFINED"));
  assert.ok(capability.reasons.includes("DOCKER_SECCOMP_BUILTIN_REQUIRED"));
  const calls = await readCalls(fake.log);
  assert.equal(calls.some((call) => call[0] === "create"), false);
});

test("Docker initialization rejects a regular file masquerading as its Unix socket", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-socket-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const bin = path.join(canonicalRoot, "fake-docker");
  const socket = path.join(canonicalRoot, "not-a-socket");
  await writeFile(bin, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  await writeFile(socket, "", { mode: 0o600 });
  const backend = new DockerBackend(config(bin, `unix://${socket}`));
  await assert.rejects(backend.initialize(), /non-symlink Unix socket/);
});

test("close during initialization prevents a late backend publication", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "build-runner-init-close-test-"));
  const fake = await fakeDocker(root);
  t.after(async () => rm(root, { recursive: true, force: true }));
  let announceSocketRead!: () => void;
  const socketReadStarted = new Promise<void>((resolve) => {
    announceSocketRead = resolve;
  });
  let releaseSocketRead!: () => void;
  const socketReadGate = new Promise<void>((resolve) => {
    releaseSocketRead = resolve;
  });
  const backend = new DockerBackend(config(fake.bin, fake.dockerHost), {
    readSocketIdentity: async () => {
      announceSocketRead();
      await socketReadGate;
      return {
        device: 1,
        inode: 2,
        uid: process.getuid?.() ?? 501,
        gid: process.getgid?.() ?? 20,
        mode: 0o600,
      };
    },
  });

  const initializing = backend.initialize();
  const rejectedInitialization = assert.rejects(initializing, /closed during initialization/i);
  await socketReadStarted;
  await backend.close();
  releaseSocketRead();
  await rejectedInitialization;
  await assert.rejects(backend.initialize(), /closing or closed/i);
});

test("Docker socket ancestor trust is rechecked across the runtime TOCTOU boundary", async (t) => {
  const root = await mkdtemp(path.join(
    await realpath("/tmp"),
    "build-runner-socket-ancestor-test-",
  ));
  const fake = await fakeDocker(root);
  let socketReads = 0;
  const backend = new DockerBackend(config(fake.bin, fake.dockerHost), {
    testOnlyOwnedSweepSettleMs: TEST_OWNED_SWEEP_SETTLE_MS,
    testOnlyAttestHostWorkspaceDiskQuota: async () => true,
    readSocketIdentity: async () => {
      socketReads += 1;
      if (socketReads === 2) await chmod(root, 0o770);
      return {
        device: 1,
        inode: 2,
        uid: process.getuid?.() ?? 501,
        gid: process.getgid?.() ?? 20,
        mode: 0o600,
      };
    },
  });
  t.after(async () => {
    await chmod(root, 0o700).catch(() => undefined);
    await backend.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  });
  await backend.initialize();

  const capability = await (async () => {
    try {
      return await backend.probe();
    } finally {
      await chmod(root, 0o700);
    }
  })();
  assert.equal(capability.available, false);
  assert.match(capability.reasons.join(" "), /Docker socket has an unsafe writable ancestor/);
  assert.equal(socketReads, 2);
});

test("Docker probe rejects CLI content drift after initialization", async (t) => {
  const { fake, backend } = await createBackend(t);
  const originalDockerCli = await readFile(fake.bin);
  await writeFile(fake.bin, "\n// post-initialize drift\n", { flag: "a" });
  const capability = await (async () => {
    try {
      return await backend.probe();
    } finally {
      await writeFile(fake.bin, originalDockerCli);
    }
  })();
  assert.equal(capability.available, false);
  assert.match(capability.reasons.join(" "), /Docker CLI content changed/);
});

test("corrupt docker create stdout poisons admission until close completes its owner sweep", async (t) => {
  const { root, fake, backend } = await createBackend(t, { corruptCreatePurpose: "gradle" });
  assert.equal((await backend.probe()).available, true);
  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);
  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/sh", "./gradlew", "--offline", "--no-daemon", "assembleDebug"],
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    }),
    /create outcome is unproven/,
  );
  const callsBeforeBlockedAdmission = await readCalls(fake.log);
  const buildCreate = callsBeforeBlockedAdmission.find(
    (call) => call[0] === "create" && call.includes("assembleDebug"),
  );
  assert.ok(buildCreate);
  const name = buildCreate[buildCreate.indexOf("--name") + 1];
  assert.ok(callsBeforeBlockedAdmission.some((call) => call[0] === "rm" && call.at(-1) === name));
  assert.ok(callsBeforeBlockedAdmission.some((call) =>
    call[0] === "container" && call[1] === "inspect" && call.at(-1) === name));

  assert.deepEqual(await backend.probe(), {
    available: false,
    backend: "docker",
    reasons: ["DOCKER_OWNED_CONTAINER_CLEANUP_UNPROVEN"],
  });
  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/sh", "./gradlew", "--offline", "must-not-run"],
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    }),
    /cleanup.*unproven/i,
  );
  assert.deepEqual(await readCalls(fake.log), callsBeforeBlockedAdmission);

  await backend.close();
  const callsAfterClose = await readCalls(fake.log);
  assert.ok(callsAfterClose.filter((call) =>
    call[0] === "container" && call[1] === "ls").length >= 6);
  assert.ok(callsAfterClose.filter((call) => call[0] === "rm" && call.at(-1) === name).length >= 2);
  const stateAfterClose = JSON.parse(await readFile(fake.state, "utf8")) as {
    containers: Record<string, unknown>;
  };
  assert.equal(Object.keys(stateAfterClose.containers).length, 0);
});

test("parent-side inspect drift blocks start and still removes the container", async (t) => {
  const { root, fake, backend } = await createBackend(t, { inspectDriftPurpose: "gradle" });
  assert.equal((await backend.probe()).available, true);
  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);
  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/sh", "./gradlew", "--offline", "--no-daemon", "assembleDebug"],
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    }),
    /NETWORK_MODE/,
  );
  const calls = await readCalls(fake.log);
  const buildCreate = calls.find((call) => call[0] === "create" && call.includes("assembleDebug"));
  assert.ok(buildCreate);
  const name = buildCreate[buildCreate.indexOf("--name") + 1];
  assert.equal(calls.some((call) => call[0] === "start" && call.at(-1) === name), false);
  assert.ok(calls.some((call) => call[0] === "rm" && call.at(-1) === name));
  assert.equal((await backend.probe()).available, true);
});

test("failed owned-container cleanup poisons concurrent admission until close retries proof", async (t) => {
  const { root, fake, backend } = await createBackend(t, {
    failThreeRemovesCommand: "poison-first",
    delayCreateCommand: "delayed-second",
    createDelayMs: 2_000,
  });
  assert.equal((await backend.probe()).available, true);
  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);

  const delayedRun = backend.runContainer({
    workspace,
    cacheSeed: cache,
    workdir: "/workspace",
    command: ["/bin/sh", "./gradlew", "--offline", "delayed-second"],
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
  });
  const rejectedDelayedRun = assert.rejects(
    delayedRun,
    /aborted|cleanup.*unproven|create outcome.*unproven/i,
  );
  await waitForCall(fake.log, (call) => call[0] === "create" && call.includes("delayed-second"));

  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/sh", "./gradlew", "--offline", "poison-first"],
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    }),
    /containment cleanup failed/,
  );
  await rejectedDelayedRun;
  const callsAfterPoison = await readCalls(fake.log);
  const delayedCreate = callsAfterPoison.find(
    (call) => call[0] === "create" && call.includes("delayed-second"),
  );
  assert.ok(delayedCreate);
  const delayedName = delayedCreate[delayedCreate.indexOf("--name") + 1];
  assert.equal(
    callsAfterPoison.some((call) => call[0] === "start" && call.at(-1) === delayedName),
    false,
  );
  const before = JSON.parse(await readFile(fake.state, "utf8")) as { containers: Record<string, unknown> };
  assert.equal(Object.keys(before.containers).length, 1);

  const callsBeforeBlockedAdmission = await readCalls(fake.log);
  const createCountBeforeBlockedAdmission = callsBeforeBlockedAdmission.filter(
    (call) => call[0] === "create",
  ).length;
  await Promise.all([
    assert.rejects(
      backend.runContainer({
        workspace,
        cacheSeed: cache,
        workdir: "/workspace",
        command: ["/bin/sh", "./gradlew", "--offline", "poisoned-one"],
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
      }),
      /cleanup.*unproven|unresolved.*cleanup/i,
    ),
    assert.rejects(
      backend.runContainer({
        workspace,
        cacheSeed: cache,
        workdir: "/workspace",
        command: ["/bin/sh", "./gradlew", "--offline", "poisoned-two"],
        timeoutMs: 5_000,
        maxOutputBytes: 4096,
      }),
      /cleanup.*unproven|unresolved.*cleanup/i,
    ),
  ]);
  const poisonedProbe = await backend.probe();
  assert.deepEqual(poisonedProbe, {
    available: false,
    backend: "docker",
    reasons: ["DOCKER_OWNED_CONTAINER_CLEANUP_UNPROVEN"],
  });
  const callsAfterBlockedAdmission = await readCalls(fake.log);
  assert.equal(
    callsAfterBlockedAdmission.filter((call) => call[0] === "create").length,
    createCountBeforeBlockedAdmission,
  );
  assert.equal(callsAfterBlockedAdmission.length, callsBeforeBlockedAdmission.length);

  await backend.close();
  const after = JSON.parse(await readFile(fake.state, "utf8")) as { containers: Record<string, unknown> };
  assert.equal(Object.keys(after.containers).length, 0);
  const callsAfterClose = await readCalls(fake.log);
  assert.ok(callsAfterClose.length > callsAfterBlockedAdmission.length);
});

test("close binds cleanup to the initialized socket identity and retries only after restoration", async (t) => {
  const uid = process.getuid?.() ?? 501;
  const gid = process.getgid?.() ?? 20;
  const identityA: SocketIdentity = {
    device: 1,
    inode: 2,
    uid,
    gid,
    mode: 0o600,
  };
  const identityB: SocketIdentity = { ...identityA, inode: 3 };
  let currentIdentity = identityA;
  const { root, fake, backend } = await createBackend(t, {
    failThreeRemovesPurpose: "gradle",
    socketIdentityReader: async () => ({ ...currentIdentity }),
  });
  assert.equal((await backend.probe()).available, true);
  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);
  await assert.rejects(
    backend.runContainer({
      workspace,
      cacheSeed: cache,
      workdir: "/workspace",
      command: ["/bin/sh", "./gradlew", "--offline", "identity-bound-cleanup"],
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
    }),
    /containment cleanup failed/,
  );
  const stateBeforeClose = JSON.parse(await readFile(fake.state, "utf8")) as {
    containers: Record<string, unknown>;
  };
  assert.equal(Object.keys(stateBeforeClose.containers).length, 1);
  const callsBeforeClose = await readCalls(fake.log);
  const create = callsBeforeClose.find(
    (call) => call[0] === "create" && call.includes("identity-bound-cleanup"),
  );
  assert.ok(create);
  const ownerLabel = create.find((entry) => entry.startsWith(`${OWNER_LABEL_FOR_TEST()}=`));
  assert.ok(ownerLabel);

  currentIdentity = identityB;
  await assert.rejects(backend.close(), /cleanup runtime identity drifted/i);
  assert.deepEqual(await readCalls(fake.log), callsBeforeClose);
  const stateAfterFailedClose = JSON.parse(await readFile(fake.state, "utf8")) as {
    containers: Record<string, unknown>;
  };
  assert.equal(Object.keys(stateAfterFailedClose.containers).length, 1);

  currentIdentity = identityA;
  await backend.close();
  const callsAfterRetry = await readCalls(fake.log);
  assert.ok(callsAfterRetry.some((call) =>
    call[0] === "container"
    && call[1] === "ls"
    && call.includes(`label=${ownerLabel}`)));
  const stateAfterRetry = JSON.parse(await readFile(fake.state, "utf8")) as {
    containers: Record<string, unknown>;
  };
  assert.equal(Object.keys(stateAfterRetry.containers).length, 0);
});

test("close sweeps an owned orphan that is absent from the active-name registry", async (t) => {
  const { fake, backend } = await createBackend(t);
  assert.equal((await backend.probe()).available, true);

  const callsBefore = await readCalls(fake.log);
  const create = callsBefore.find((call) => call[0] === "create");
  assert.ok(create);
  const ownerEntry = create[create.findIndex((value) =>
    value.startsWith(`${OWNER_LABEL_FOR_TEST()}=`))];
  assert.ok(ownerEntry);
  const ownerId = ownerEntry.slice(`${OWNER_LABEL_FOR_TEST()}=`.length);
  assert.match(ownerId, /^[a-f0-9]{32}$/);

  const orphanId = "c".repeat(64);
  const orphanName = "daemon-late-owned-orphan";
  const state = JSON.parse(await readFile(fake.state, "utf8")) as {
    containers: Record<string, unknown>;
    removeFailures: Record<string, number>;
  };
  state.containers[orphanName] = {
    id: orphanId,
    name: orphanName,
    purpose: "gradle",
    argv: [],
    inspect: {
      Config: {
        Labels: {
          [OWNER_LABEL_FOR_TEST()]: ownerId,
        },
      },
    },
  };
  await writeFile(fake.state, JSON.stringify(state));

  await backend.close();

  const calls = await readCalls(fake.log);
  const ownerLists = calls.filter((call) =>
    call[0] === "container"
    && call[1] === "ls"
    && call.includes(`label=${OWNER_LABEL_FOR_TEST()}=${ownerId}`));
  assert.ok(ownerLists.length >= 3);
  assert.ok(calls.some((call) => call[0] === "rm" && call.at(-1) === orphanId));
  const after = JSON.parse(await readFile(fake.state, "utf8")) as {
    containers: Record<string, unknown>;
  };
  assert.equal(Object.keys(after.containers).length, 0);
});

test("close aborts an admitted delayed create and prevents a later container start", async (t) => {
  const { root, fake, backend } = await createBackend(t, {
    delayCreatePurpose: "gradle",
    createDelayMs: 2_000,
  });
  assert.equal((await backend.probe()).available, true);
  const workspace = path.join(root, "workspace");
  const cache = path.join(root, "cache");
  await mkdir(workspace);
  await mkdir(cache);

  const running = backend.runContainer({
    workspace,
    cacheSeed: cache,
    workdir: "/workspace",
    command: ["/bin/sh", "./gradlew", "--offline", "--no-daemon", "assembleDebug"],
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
  });
  const rejectedRun = assert.rejects(running, /aborted|closing|create outcome.*unproven/i);
  await waitForCall(fake.log, (call) => call[0] === "create" && call.includes("assembleDebug"));

  await backend.close();
  await rejectedRun;

  const calls = await readCalls(fake.log);
  const buildCreate = calls.find((call) => call[0] === "create" && call.includes("assembleDebug"));
  assert.ok(buildCreate);
  const name = buildCreate[buildCreate.indexOf("--name") + 1];
  assert.equal(calls.some((call) => call[0] === "start" && call.at(-1) === name), false);
  assert.ok(calls.some((call) => call[0] === "container" && call[1] === "ls"));
  const state = JSON.parse(await readFile(fake.state, "utf8")) as { containers: Record<string, unknown> };
  assert.equal(Object.keys(state.containers).length, 0);
});

test("close retains Docker identity and retries a poisoned CLI cleanup proof", async (t) => {
  let groupPresent = false;
  const processRunner = new ProcessRunner({
    testOnlyTimings: {
      terminationGraceMs: 20,
      forceCloseGraceMs: 40,
      finalSettleGraceMs: 20,
      cleanupPollMs: 5,
    },
    testOnlyHooks: {
      processGroupExists: () => groupPresent,
      signalProcessGroup: () => undefined,
    },
  });
  const { fake, backend } = await createBackend(t, { processRunner });
  assert.equal((await backend.probe()).available, true);

  // Make the next Docker CLI group impossible to prove absent. The first close
  // must fail closed and retain enough backend state for a later retry.
  groupPresent = true;
  await assert.rejects(backend.close(), /survived|cleanup|process group/i);
  assert.equal(processRunner.status().poisoned, true);
  assert.equal(processRunner.status().closed, false);
  const callsAfterFailure = await readCalls(fake.log);
  assert.ok(callsAfterFailure.some((call) => call[0] === "container" && call[1] === "ls"));

  // Absence is now provable. Backend.close() first recovers the retained
  // registry, repeats the owner-label sweep, and finally closes its runner.
  groupPresent = false;
  await backend.close();
  assert.equal(processRunner.status().poisoned, false);
  assert.equal(processRunner.status().closed, true);
  const callsAfterRetry = await readCalls(fake.log);
  assert.ok(callsAfterRetry.length > callsAfterFailure.length);
  assert.ok(callsAfterRetry.filter((call) =>
    call[0] === "container" && call[1] === "ls").length >= 4);
});

test("close stops an admitted probe CLI and blocks every later probe command", async (t) => {
  const { fake, backend } = await createBackend(t, { delayVersionMs: 2_000 });
  const probing = backend.probe();
  await waitForCall(fake.log, (call) => call[0] === "version");

  await backend.close();
  const capability = await probing;
  assert.equal(capability.available, false);
  assert.match(capability.reasons.join(" "), /closing|cleanup|aborted/i);

  const calls = await readCalls(fake.log);
  assert.equal(calls.filter((call) => call[0] === "version").length, 1);
  assert.equal(calls.some((call) => call[0] === "info"), false);
  assert.equal(calls.some((call) => call[0] === "image" && call[1] === "inspect"), false);
});
