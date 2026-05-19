import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHierarchyXml } from "./uiautomator.js";
import { findOne, findFirst, findAll } from "./finder.js";
import { pageFingerprint } from "./page-fingerprint.js";

const SAMPLE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="com.example.app:id/root" class="android.widget.LinearLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,100][1080,2300]">
      <node index="0" text="登录" resource-id="com.example.app:id/login_btn" class="android.widget.Button" package="com.example.app" content-desc="Login button" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][500,300]"/>
      <node index="1" text="注册" resource-id="com.example.app:id/register_btn" class="android.widget.Button" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[600,200][1000,300]"/>
      <node index="2" text="" resource-id="com.example.app:id/phone" class="android.widget.EditText" package="com.example.app" content-desc="Phone number" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,400][1000,500]"/>
      <node index="3" text="禁用按钮" resource-id="com.example.app:id/disabled_btn" class="android.widget.Button" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,600][500,700]"/>
    </node>
  </node>
</hierarchy>`;

test("parseHierarchyXml computes bounds and center", () => {
  const { elements, rotation } = parseHierarchyXml(SAMPLE);
  assert.equal(rotation, 0);
  assert.ok(elements.length >= 5);
  const btn = elements.find((e) => e.resource_id === "com.example.app:id/login_btn")!;
  assert.equal(btn.text, "登录");
  assert.equal(btn.clickable, true);
  assert.deepEqual(btn.bounds, { x1: 100, y1: 200, x2: 500, y2: 300 });
  assert.deepEqual(btn.center, { x: 300, y: 250 });
  assert.equal(btn.width, 400);
  assert.equal(btn.height, 100);
});

test("findOne by identifier", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findOne(elements, { by: "identifier", value: "com.example.app:id/login_btn" });
  assert.equal(r.matched, true);
  assert.equal(r.element!.text, "登录");
});

test("findOne by text", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findOne(elements, { by: "text", value: "注册" });
  assert.equal(r.matched, true);
  assert.equal(r.element!.resource_id, "com.example.app:id/register_btn");
});

test("findOne by label (content-desc)", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findOne(elements, { by: "label", value: "Phone number" });
  assert.equal(r.matched, true);
  assert.equal(r.element!.class, "android.widget.EditText");
});

test("only_clickable filters", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findOne(elements, { by: "text", value: "禁用按钮", only_clickable: true });
  assert.equal(r.matched, false);
});

test("only_enabled=true (default) excludes disabled", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findOne(elements, { by: "identifier", value: "com.example.app:id/disabled_btn" });
  assert.equal(r.matched, false);
});

test("only_enabled=false includes disabled", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findOne(elements, {
    by: "identifier",
    value: "com.example.app:id/disabled_btn",
    only_enabled: false,
  });
  assert.equal(r.matched, true);
});

test("findFirst tries strategies in order", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findFirst(elements, [
    { by: "identifier", value: "nonexistent" },
    { by: "text", value: "登录" },
    { by: "label", value: "Phone number" },
  ]);
  assert.equal(r.matched, true);
  assert.equal(r.used!.by, "text");
  assert.equal(r.element!.text, "登录");
});

test("findFirst returns matched=false when none hit", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const r = findFirst(elements, [
    { by: "identifier", value: "nope1" },
    { by: "text", value: "nope2" },
  ]);
  assert.equal(r.matched, false);
});

test("findAll returns multiple matches", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const all = findAll(elements, { by: "class", value: "android.widget.Button", only_clickable: true });
  assert.equal(all.length, 2); // login + register; disabled excluded
});

test("pageFingerprint is stable for same content", () => {
  const a = parseHierarchyXml(SAMPLE).elements;
  const b = parseHierarchyXml(SAMPLE).elements;
  const fpA = pageFingerprint(a);
  const fpB = pageFingerprint(b);
  assert.equal(fpA.hash, fpB.hash);
  assert.ok(fpA.visible_count > 0);
});

test("pageFingerprint differs when text changes", () => {
  const { elements: a } = parseHierarchyXml(SAMPLE);
  const altered = parseHierarchyXml(SAMPLE.replace("登录", "登入")).elements;
  assert.notEqual(pageFingerprint(a).hash, pageFingerprint(altered).hash);
});
