import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  parseHierarchyXml,
  redactSensitiveHierarchyXml,
} from "./uiautomator.js";
import {
  elementAnchor,
  findOne,
  findFirst,
  findAll,
  hasStableAnchor,
  hasPresentCandidates,
  locateElementByAnchor,
  normalizeLabel,
} from "./finder.js";
import { pageFingerprint } from "./page-fingerprint.js";
import {
  ambiguityForOutput,
  cancellationForOutput,
  clearDeadlineForOutput,
  MAX_AMBIGUITY_ELEMENTS,
  pruneForOutput,
} from "./element-output.js";
import {
  MAX_ELEMENT_OUTPUT_FIELD_BYTES,
  MAX_EXPLICIT_CANDIDATE_INDEX,
  MAX_FINGERPRINT_OUTPUT_SIGNALS,
  MAX_HIERARCHY_DEPTH,
  MAX_HIERARCHY_ELEMENTS,
  MAX_HIERARCHY_XML_BYTES,
} from "./limits.js";
import {
  adbErrorFromFailure,
  deleteKeyEvents,
  quoteAdbShellArg,
} from "./adb.js";

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

test("parseHierarchyXml rejects oversized, overly deep, and overpopulated trees", () => {
  assert.throws(
    () => parseHierarchyXml("x".repeat(MAX_HIERARCHY_XML_BYTES + 1)),
    /byte limit/,
  );

  const tooDeep = `<hierarchy>${"<node>".repeat(MAX_HIERARCHY_DEPTH + 2)}${
    "</node>".repeat(MAX_HIERARCHY_DEPTH + 2)
  }</hierarchy>`;
  assert.throws(
    () => parseHierarchyXml(tooDeep),
    /depth limit|Maximum nested tags exceeded/,
  );

  const tooMany = `<hierarchy>${'<node index="0"/>'.repeat(MAX_HIERARCHY_ELEMENTS + 1)}</hierarchy>`;
  assert.throws(() => parseHierarchyXml(tooMany), /element limit/);
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

test("exact identifier, text, and label matches require an explicit candidate index", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const original = elements.find(
    (element) => element.resource_id === "com.example.app:id/login_btn",
  )!;
  const duplicate = {
    ...original,
    index: 999,
    bounds: { x1: 100, y1: 800, x2: 500, y2: 900 },
    center: { x: 300, y: 850 },
  };
  const duplicated = [...elements, duplicate];

  for (const strategy of [
    { by: "identifier" as const, value: original.resource_id },
    { by: "text" as const, value: original.text },
    { by: "label" as const, value: original.content_desc },
  ]) {
    const ambiguous = findOne(duplicated, strategy);
    assert.equal(ambiguous.matched, false);
    assert.equal(ambiguous.ambiguous, true);
    assert.equal(ambiguous.candidates, 2);

    const selected = findOne(duplicated, { ...strategy, index: 1 });
    assert.equal(selected.matched, true);
    assert.equal(selected.element?.index, 999);
  }
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

test("pageFingerprint preserves tuple and record boundaries", () => {
  const original = parseHierarchyXml(SAMPLE).elements[0]!;
  const oneRecord = [{
    ...original,
    resource_id: "a",
    text: "",
    content_desc: "b||",
  }];
  const twoRecords = [
    { ...original, resource_id: "a", text: "", content_desc: "" },
    { ...original, resource_id: "b", text: "", content_desc: "" },
  ];
  assert.notEqual(pageFingerprint(oneRecord).hash, pageFingerprint(twoRecords).hash);
});

test("pageFingerprint bounds debug signals without changing the full visible count", () => {
  const original = parseHierarchyXml(SAMPLE).elements[0]!;
  const elements = Array.from(
    { length: MAX_FINGERPRINT_OUTPUT_SIGNALS + 1 },
    (_, index) => ({
      ...original,
      resource_id: `${"界".repeat(1_000)}-${index}`,
      text: "",
      content_desc: "",
    }),
  );
  const fp = pageFingerprint(elements);
  assert.equal(fp.visible_count, elements.length);
  assert.equal(fp.signals.length, MAX_FINGERPRINT_OUTPUT_SIGNALS);
  assert.equal(fp.signals_truncated, true);
  assert.equal(fp.signal_fields_truncated, true);
  assert.ok(
    fp.signals.every((signal) => Buffer.byteLength(signal, "utf8") <=
      MAX_ELEMENT_OUTPUT_FIELD_BYTES + 2),
  );
  assert.ok(fp.signals.every((signal) => !signal.includes("�")));
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

test("findFirst never resolves ambiguity to an unrelated unique element", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const unrelated = {
    ...elements[0]!,
    index: 999,
    text: "无关唯一操作",
    content_desc: "",
    resource_id: "com.example.app:id/unrelated",
    bounds: { x1: 0, y1: 300, x2: 500, y2: 400 },
    center: { x: 250, y: 350 },
  };
  const r = findFirst([...elements, unrelated], [
    { by: "label", value: "状态" },
    { by: "text", value: "无关唯一操作" },
  ]);
  assert.equal(r.matched, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.used?.by, "label");
});

test("element anchors safely relocate a cleared input without mutable text", () => {
  const { elements } = parseHierarchyXml(SAMPLE);
  const phone = elements.find((element) =>
    element.resource_id === "com.example.app:id/phone"
  )!;
  const original = { ...phone, text: "13800138000", focused: true };
  const anchor = elementAnchor(original);
  assert.equal(hasStableAnchor(anchor), true);

  const cleared = { ...phone, text: "", focused: true };
  assert.equal(
    locateElementByAnchor(
      elements.map((element) => element === phone ? cleared : element),
      anchor,
      false,
    ),
    cleared,
  );

  const textOnly = elementAnchor({
    ...original,
    resource_id: "",
    content_desc: "",
  });
  assert.equal(hasStableAnchor(textOnly), false);
  assert.equal(locateElementByAnchor([cleared], textOnly, false), undefined);

  const siblingWithSameId = {
    ...cleared,
    bounds: { x1: 100, y1: 600, x2: 1000, y2: 700 },
    center: { x: 550, y: 650 },
  };
  assert.equal(
    locateElementByAnchor([siblingWithSameId], anchor, false),
    undefined,
  );

  const shiftedFocused = {
    ...original,
    bounds: { x1: 100, y1: 250, x2: 1000, y2: 350 },
    center: { x: 550, y: 300 },
  };
  assert.equal(
    locateElementByAnchor([shiftedFocused], anchor, true, false),
    shiftedFocused,
  );
  assert.equal(locateElementByAnchor([shiftedFocused], anchor, true), undefined);
});

test("presence helper distinguishes absent results from ambiguous candidates", () => {
  assert.equal(hasPresentCandidates({ matched: false, candidates: 0 }), false);
  assert.equal(hasPresentCandidates({ matched: true, candidates: 1 }), true);
  assert.equal(
    hasPresentCandidates({ matched: false, candidates: 2, ambiguous: true }),
    true,
  );
});

test("ambiguity output exposes candidate-array indexes, not hierarchy indexes", () => {
  const { elements } = parseHierarchyXml(AMBIGUOUS_LABEL_SAMPLE);
  const result = findOne(elements, { by: "label", value: "状态" });
  const output = ambiguityForOutput(result)! as {
    elements: Array<{ candidate_index: number; index: number; content_desc: string }>;
    elements_truncated: boolean;
    hint: string;
  };

  assert.deepEqual(
    output.elements.map((element) => element.candidate_index),
    [0, 1],
  );
  assert.notDeepEqual(
    output.elements.map((element) => element.candidate_index),
    output.elements.map((element) => element.index),
  );
  assert.equal(output.elements_truncated, false);
  assert.match(output.hint, /candidate_index/);
  assert.equal(MAX_AMBIGUITY_ELEMENTS, 20);
  assert.equal(MAX_EXPLICIT_CANDIDATE_INDEX, 19);
});

test("explicit indexes cannot select candidates hidden by output truncation", () => {
  const original = parseHierarchyXml(SAMPLE).elements.find(
    (element) => element.resource_id === "com.example.app:id/login_btn",
  )!;
  const candidates = Array.from({ length: MAX_AMBIGUITY_ELEMENTS + 1 }, (_, index) => ({
    ...original,
    index: 100 + index,
    bounds: { x1: 0, y1: index * 10, x2: 100, y2: index * 10 + 9 },
    center: { x: 50, y: index * 10 + 5 },
  }));

  assert.equal(findOne(candidates, {
    by: "text",
    value: "登录",
    index: MAX_EXPLICIT_CANDIDATE_INDEX,
  }).matched, true);
  assert.equal(findOne(candidates, {
    by: "text",
    value: "登录",
    index: MAX_EXPLICIT_CANDIDATE_INDEX + 1,
  }).matched, false);
});

test("password nodes are redacted from element, XML, and fingerprint outputs", () => {
  const phone = parseHierarchyXml(SAMPLE).elements.find(
    (element) => element.resource_id === "com.example.app:id/phone",
  )!;
  const firstSecret = {
    ...phone,
    password: true,
    text: "token-super-secret-a",
    content_desc: "token-super-secret-a",
  };
  const secondSecret = {
    ...firstSecret,
    text: "token-super-secret-b",
    content_desc: "token-super-secret-b",
  };

  const output = pruneForOutput(firstSecret);
  assert.equal(output["text"], undefined);
  assert.equal(output["content_desc"], undefined);
  assert.equal(output["sensitive_text_redacted"], true);

  const xml = `<hierarchy><node text="token-super-secret-a" content-desc="token-super-secret-a" password="true"/><node text="public" content-desc="label" password="false"/></hierarchy>`;
  const redactedXml = redactSensitiveHierarchyXml(xml);
  assert.equal(redactedXml.includes("token-super-secret-a"), false);
  assert.match(redactedXml, /text="\[REDACTED\]"/);
  assert.match(redactedXml, /text="public"/);

  const firstFingerprint = pageFingerprint([firstSecret]);
  const secondFingerprint = pageFingerprint([secondSecret]);
  assert.equal(firstFingerprint.hash, secondFingerprint.hash);
  assert.deepEqual(firstFingerprint.signals, secondFingerprint.signals);
  assert.equal(JSON.stringify(firstFingerprint).includes("token-super-secret"), false);
  assert.deepEqual(firstFingerprint.signals, [
    "com.example.app:id/phone|[password-redacted]|",
  ]);
});

test("element output bounds attacker-controlled accessibility strings by UTF-8 bytes", () => {
  const original = parseHierarchyXml(SAMPLE).elements[0]!;
  const output = pruneForOutput({
    ...original,
    class: "界".repeat(1_000),
    text: "界".repeat(1_000),
    content_desc: "界".repeat(1_000),
    resource_id: "界".repeat(1_000),
    package: "界".repeat(1_000),
  });
  for (const field of ["class", "text", "content_desc", "resource_id", "package"]) {
    const value = String(output[field]);
    assert.ok(Buffer.byteLength(value, "utf8") <= MAX_ELEMENT_OUTPUT_FIELD_BYTES);
    assert.equal(value.includes("�"), false);
  }
  assert.equal(output["output_fields_truncated"], true);
});

test("post-input deadline output preserves mutation uncertainty and forbids blind retry", () => {
  const afterInput = clearDeadlineForOutput(3, true, true);
  assert.equal(afterInput["input_may_have_applied"], true);
  assert.equal(afterInput["input_sent"], true);
  assert.equal(afterInput["verification"], "timed_out");
  assert.match(String(afterInput["hint"]), /Do not blindly retry/i);

  const duringInput = clearDeadlineForOutput(3, true, false);
  assert.equal(duringInput["input_may_have_applied"], true);
  assert.equal(duringInput["input_sent"], false);
  assert.match(String(duringInput["hint"]), /may have applied/i);

  const beforeInput = clearDeadlineForOutput(1, false, false);
  assert.equal(beforeInput["input_may_have_applied"], false);
  assert.equal(beforeInput["verification"], "not_started");
});

test("request cancellation preserves possible input mutation state", () => {
  const duringInput = cancellationForOutput(2, true, false);
  assert.equal(duringInput["reason"], "cancelled");
  assert.equal(duringInput["field_may_have_changed"], true);
  assert.equal(duringInput["input_may_have_applied"], true);
  assert.equal(duringInput["input_sent"], false);
  assert.match(String(duringInput["hint"]), /do not blindly/i);

  const beforeMutation = cancellationForOutput(0, false, false);
  assert.equal(beforeMutation["field_may_have_changed"], false);
  assert.equal(beforeMutation["input_may_have_applied"], false);

  const duringDelete = cancellationForOutput(0, false, false, true);
  assert.equal(duringDelete["delete_may_have_applied"], true);
  assert.equal(duringDelete["field_may_have_changed"], true);
  assert.match(String(duringDelete["hint"]), /do not blindly/i);
});

test("adb shell quoting preserves metacharacters as one literal argument", () => {
  assert.equal(quoteAdbShellArg("hello;id"), "'hello;id'");
  assert.equal(quoteAdbShellArg("a'b&c|d\nnext"), `'a'"'"'b&c|d\nnext'`);
  assert.throws(() => quoteAdbShellArg("bad\0value"), /NUL/);

  const payload = "hello;printf INJECTED&whoami|cat\nnext 'quoted' $HOME";
  const command = `set -- ${quoteAdbShellArg(payload)}; test "$#" -eq 1; printf %s "$1"`;
  assert.equal(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }), payload);
});

test("clear emits exactly the observed number of deletes", () => {
  assert.deepEqual(deleteKeyEvents(0), []);
  assert.deepEqual(deleteKeyEvents(2), ["KEYCODE_DEL", "KEYCODE_DEL"]);
  assert.throws(() => deleteKeyEvents(-1), /between 0 and 10000/);
  assert.throws(() => deleteKeyEvents(10_001), /between 0 and 10000/);
});

test("input-text adb failures redact the secret from every diagnostic field", () => {
  const secret = "token-very-secret";
  const error = adbErrorFromFailure(
    ["shell", `input text '${secret}'`],
    Object.assign(new Error(`Command failed with ${secret}`), {
      code: 1,
      stderr: `remote echoed ${secret}`,
    }),
    {
      displayArgs: ["shell", "input text '[REDACTED]'"],
      redactFailureOutput: true,
    },
  );
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.cmd.includes(secret), false);
  assert.equal(error.stderr?.includes(secret), false);
});
