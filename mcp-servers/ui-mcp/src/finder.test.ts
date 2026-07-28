import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHierarchyXml } from "./uiautomator.js";
import {
  findOne,
  findFirst,
  findAll,
  hasPresentCandidates,
  normalizeLabel,
} from "./finder.js";
import { pageFingerprint } from "./page-fingerprint.js";

// Real Flutter (sub2api) sample: bottom tabs carry TalkBack noise in
// content-desc ("概览\n第 1 个标签，共 5 个"), and there is a plain "概览" View
// as well. resource-id is always empty (Flutter). &#10; decodes to \n.
const FLUTTER_SAMPLE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.sub2api.sub2api_admin" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="" class="android.view.View" package="com.sub2api.sub2api_admin" content-desc="概览" clickable="false" enabled="true" bounds="[40,120][200,180]"/>
    <node index="1" text="" resource-id="" class="android.widget.Button" package="com.sub2api.sub2api_admin" content-desc="概览&#10;第 1 个标签，共 5 个" clickable="true" enabled="true" bounds="[0,2200][216,2340]"/>
    <node index="2" text="" resource-id="" class="android.widget.Button" package="com.sub2api.sub2api_admin" content-desc="监控&#10;第 2 个标签，共 5 个" clickable="true" enabled="true" bounds="[216,2200][432,2340]"/>
    <node index="3" text="" resource-id="" class="android.view.View" package="com.sub2api.sub2api_admin" content-desc="RPM(每分钟请求)&#10;12&#10;TPM&#10;111.4k" clickable="false" enabled="true" bounds="[40,400][1040,560]"/>
  </node>
</hierarchy>`;

// The first lines are intentionally identical while the remaining semantics
// differ. A clean "状态" query is useful shorthand, but not unique enough for
// findOne to select safely.
const AMBIGUOUS_LABEL_SAMPLE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node index="0" text="" resource-id="com.example.app:id/online" class="android.widget.Button" package="com.example.app" content-desc="状态&#10;在线" clickable="true" enabled="true" bounds="[0,100][500,200]"/>
    <node index="1" text="" resource-id="com.example.app:id/offline" class="android.widget.Button" package="com.example.app" content-desc="状态&#10;离线" clickable="true" enabled="true" bounds="[580,100][1080,200]"/>
  </node>
</hierarchy>`;

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

test("parseHierarchyXml decodes exactly one XML entity layer", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <node text="line&#10;next | hex&#xA;next | literal &amp;#10; | nested &amp;amp;" resource-id="" class="android.view.View" package="com.example.app" content-desc="&quot;quoted&quot; &amp; &lt;tag&gt; &apos;single&apos;" clickable="false" enabled="true" bounds="[0,0][100,100]"/>
</hierarchy>`;

  const element = parseHierarchyXml(xml).elements[0]!;
  assert.equal(
    element.text,
    "line\nnext | hex\nnext | literal &#10; | nested &amp;",
  );
  assert.equal(element.content_desc, `"quoted" & <tag> 'single'`);
});

test("parseHierarchyXml preserves invalid numeric entities without throwing", () => {
  const invalid = [
    "&#0;",          // forbidden XML control code point
    "&#55296;",      // UTF-16 surrogate U+D800
    "&#1114112;",    // above Unicode maximum
    "&#xD800;",      // hexadecimal surrogate
    "&#x110000;",    // hexadecimal out of range
    "&#999999999999999999999999999999999;", // not a safe integer
    "&#-1;",         // malformed decimal reference
    "&#xZZ;",        // malformed hexadecimal reference
  ];
  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
  <node text="${invalid.join("|")}" resource-id="" class="android.view.View" package="com.example.app" content-desc="" clickable="false" enabled="true" bounds="[0,0][100,100]"/>
</hierarchy>`;

  assert.doesNotThrow(() => parseHierarchyXml(xml));
  assert.equal(parseHierarchyXml(xml).elements[0]!.text, invalid.join("|"));
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

test("empty strategy values never match arbitrary elements", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  for (const by of [
    "identifier",
    "text",
    "label",
    "text_contains",
    "label_contains",
    "class",
  ] as const) {
    const strategy = { by, value: "" };
    assert.equal(findOne(elements, strategy).matched, false, by);
    assert.deepEqual(findAll(elements, strategy), [], by);
  }
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

// --- Flutter/TalkBack normalized label matching ---

test("normalizeLabel strips accessibility noise after first line", () => {
  assert.equal(normalizeLabel("概览\n第 1 个标签，共 5 个"), "概览");
  assert.equal(normalizeLabel("RPM(每分钟请求)\n12\nTPM\n111.4k"), "RPM(每分钟请求)");
  assert.equal(normalizeLabel("  Agree  "), "Agree");
  assert.equal(normalizeLabel("Agree"), "Agree");
  assert.equal(normalizeLabel(""), "");
});

test("by:label matches Flutter tab despite TalkBack suffix", () => {
  const { elements } = parseHierarchyXml(FLUTTER_SAMPLE);
  const r = findOne(elements, { by: "label", value: "监控", only_clickable: true });
  assert.equal(r.matched, true);
  assert.equal(r.element!.class, "android.widget.Button");
  assert.equal(r.element!.content_desc, "监控\n第 2 个标签，共 5 个");
});

test("by:label prefers exact content-desc over normalized fallback", () => {
  const { elements } = parseHierarchyXml(FLUTTER_SAMPLE);
  // Two elements normalize to "概览": the plain View (exact) and the tab Button.
  // Exact match must win and be returned alone.
  const r = findOne(elements, { by: "label", value: "概览" });
  assert.equal(r.matched, true);
  assert.equal(r.element!.content_desc, "概览"); // the exact View, not the tab
  assert.equal(r.candidates, 1); // normalized-only Button excluded once exact hits
});

test("by:label normalized fallback still respects only_clickable", () => {
  const { elements } = parseHierarchyXml(FLUTTER_SAMPLE);
  // With only_clickable, the exact plain View (not clickable) is filtered out,
  // so the clickable tab Button is matched via normalization.
  const r = findOne(elements, { by: "label", value: "概览", only_clickable: true });
  assert.equal(r.matched, true);
  assert.equal(r.element!.class, "android.widget.Button");
});

test("by:label exact match on multi-line value still works", () => {
  const { elements } = parseHierarchyXml(FLUTTER_SAMPLE);
  const r = findOne(elements, { by: "label", value: "监控\n第 2 个标签，共 5 个" });
  assert.equal(r.matched, true);
  assert.equal(r.element!.class, "android.widget.Button");
});

test("by:label returns no match for absent normalized value", () => {
  const { elements } = parseHierarchyXml(FLUTTER_SAMPLE);
  const r = findOne(elements, { by: "label", value: "设置" });
  assert.equal(r.matched, false);
});

test("by:label does not normalize a multi-line query after exact miss", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const r = findOne(elements, { by: "label", value: "状态\n维护中" });
  assert.equal(r.matched, false);
  assert.equal(r.candidates, 0);
  assert.deepEqual(
    findAll(elements, { by: "label", value: "状态\n维护中" }),
    [],
  );
});

test("by:label normalized fallback rejects a dirty single-line query", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const r = findOne(elements, { by: "label", value: " 状态 " });
  assert.equal(r.matched, false);
  assert.equal(r.candidates, 0);
});

test("findOne reports ambiguous normalized labels instead of picking first", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const r = findOne(elements, { by: "label", value: "状态" });
  assert.equal(r.matched, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates, 2);
  assert.equal(r.element, undefined);
  assert.deepEqual(
    r.others?.map((e) => e.content_desc),
    ["状态\n在线", "状态\n离线"],
  );
});

test("findAll exposes every normalized candidate and index disambiguates findOne", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const all = findAll(elements, { by: "label", value: "状态" });
  assert.deepEqual(
    all.map((e) => e.content_desc),
    ["状态\n在线", "状态\n离线"],
  );

  const selected = findOne(elements, { by: "label", value: "状态", index: 1 });
  assert.equal(selected.matched, true);
  assert.equal(selected.element!.content_desc, "状态\n离线");
});

test("findFirst stops on normalized-label ambiguity before broader fallback", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const r = findFirst(elements, [
    { by: "label", value: "状态" },
    { by: "label_contains", value: "状态" },
  ]);
  assert.equal(r.matched, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.used?.by, "label");
  assert.equal(hasPresentCandidates(r), true);
});

test("findFirst lets a later unique strategy resolve label ambiguity", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const r = findFirst(elements, [
    { by: "label", value: "状态" },
    { by: "identifier", value: "com.example.app:id/offline" },
  ]);
  assert.equal(r.matched, true);
  assert.equal(r.used?.by, "identifier");
  assert.equal(r.element?.content_desc, "状态\n离线");
});

test("presence helper distinguishes absent results from ambiguous candidates", () => {
  assert.equal(hasPresentCandidates({ matched: false, candidates: 0 }), false);
  assert.equal(hasPresentCandidates({ matched: true, candidates: 1 }), true);
  assert.equal(
    hasPresentCandidates({ matched: false, candidates: 2, ambiguous: true }),
    true,
  );
});
