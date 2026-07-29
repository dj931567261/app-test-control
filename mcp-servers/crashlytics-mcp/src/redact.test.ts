import assert from "node:assert/strict";
import test from "node:test";

import { redactText } from "./redact.js";

test("redactText masks URLs, PII and common secrets", () => {
  const result = redactText(
    "visit https://example.test/u?id=42 email dev@example.test phone +86 138-0013-8000 "
      + "Authorization Bearer abc.def.ghi password=hunter2 ip 192.168.1.2",
  );
  assert.ok(result);
  assert.doesNotMatch(result.value, /example\.test|138-0013|hunter2|192\.168/);
  assert.match(result.value, /REDACTED_URL/);
  assert.match(result.value, /REDACTED_EMAIL/);
  assert.match(result.value, /REDACTED_PHONE/);
  assert.match(result.value, /REDACTED_AUTH/);
  assert.match(result.value, /REDACTED_SECRET/);
  assert.match(result.value, /REDACTED_IP/);
  assert.ok(result.count >= 6);
});

test("redactText enforces a UTF-8 byte bound", () => {
  const result = redactText("测".repeat(100), 32);
  assert.ok(result?.truncated);
  assert.ok(Buffer.byteLength(result.value, "utf8") <= 32);
});

test("redactText masks Windows user directories and IPv6 addresses", () => {
  const result = redactText(
    "C:\\Users\\Alice\\workspace\\Main.kt connected from 2001:db8:85a3::8a2e:370:7334 "
      + "token=topsecret otp=123456 password=\"two words secret\" Cookie: sid=abc123",
  );
  assert.ok(result);
  assert.doesNotMatch(result.value, /Alice|2001:db8|topsecret|123456|two words|abc123/i);
  assert.match(result.value, /REDACTED_USER/);
  assert.match(result.value, /REDACTED_IP/);
  assert.match(result.value, /REDACTED_SECRET/);
  assert.match(result.value, /REDACTED_COOKIE/);
});

test("redactText expands capture references without leaking literal replacement tokens", () => {
  const result = redactText("/Users/alice/work/Main.kt password=two-words");
  assert.ok(result);
  assert.match(result.value, /\/Users\/\[REDACTED_USER\]\/work\/Main\.kt/);
  assert.match(result.value, /password=\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.value, /alice|two-words|\$1/);
});

test("redactText masks JSON-style identifiers, UUIDs and precise coordinates", () => {
  const result = redactText(
    '{"password":"json secret","user_id":"person-42",'
      + '"installationUuid":"install-99","account-id":"acct-7",'
      + '"device_uuid":"device-8","location":"private place"} '
      + "idfa=550e8400-e29b-41d4-a716-446655440000 "
      + "trace 123e4567-e89b-42d3-a456-426614174000 at 37.7749,-122.4194",
  );
  assert.ok(result);
  assert.doesNotMatch(
    result.value,
    /json secret|person-42|install-99|acct-7|device-8|private place|550e8400|37\.7749|122\.4194/i,
  );
  assert.match(result.value, /REDACTED_SECRET/);
  assert.match(result.value, /REDACTED_UUID/);
  assert.match(result.value, /REDACTED_LOCATION/);
});
