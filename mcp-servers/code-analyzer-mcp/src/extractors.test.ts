import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractAndroid } from "./android.js";
import { extractFlutter } from "./flutter.js";
import { detectPlatform } from "./platform.js";

async function newDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "code-analyzer-"));
}

describe("Android extractor", () => {
  it("finds activities, view click handlers, retrofit endpoints", async () => {
    const dir = await newDir();
    try {
      await mkdir(join(dir, "app/src/main/java/com/x"), { recursive: true });
      // Manifest with launcher
      await mkdir(join(dir, "app/src/main"), { recursive: true });
      await writeFile(
        join(dir, "app/src/main/AndroidManifest.xml"),
        `<manifest><application><activity android:name=".LoginActivity"><intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter></activity></application></manifest>`,
      );
      // Kotlin source — Login activity with two buttons
      await writeFile(
        join(dir, "app/src/main/java/com/x/LoginActivity.kt"),
        `package com.x
import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import android.widget.TextView

class LoginActivity : AppCompatActivity() {
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        val btn = findViewById<TextView>(R.id.btn_login)
        btn.setOnClickListener {
            startActivity(android.content.Intent(this, HomeActivity::class.java))
        }
        findViewById<TextView>(R.id.btn_register).setOnClickListener {
            startActivity(android.content.Intent(this, RegisterActivity::class.java))
        }
    }
}

interface AuthApi {
    @retrofit2.http.POST("/api/login")
    suspend fun login(): String
}
`,
      );

      const r = await extractAndroid(dir);
      assert.equal(r.pages.length, 1);
      assert.equal(r.pages[0]!.name, "LoginActivity");
      assert.equal(r.pages[0]!.is_launcher, true);

      const ids = r.handlers.map((h) => h.target_id);
      assert.ok(ids.includes("R.id.btn_login"), "btn_login handler found");
      assert.ok(ids.includes("R.id.btn_register"), "btn_register handler found");
      for (const h of r.handlers) {
        assert.equal(h.page, "LoginActivity");
      }

      const apiPaths = r.apis.map((a) => a.path);
      assert.ok(apiPaths.includes("/api/login"), "retrofit endpoint found");

      const routeTargets = r.routes.map((rt) => rt.target_page);
      assert.ok(routeTargets.includes("HomeActivity"));
      assert.ok(routeTargets.includes("RegisterActivity"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Flutter extractor", () => {
  it("finds pages, GoRouter routes, button texts", async () => {
    const dir = await newDir();
    try {
      await mkdir(join(dir, "lib/pages"), { recursive: true });
      await mkdir(join(dir, "lib/router"), { recursive: true });
      await writeFile(
        join(dir, "lib/pages/login_page.dart"),
        `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class LoginPage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(body: Column(children: [
      ElevatedButton(onPressed: () => context.go('/home'), child: Text('Sign In')),
      TextButton(onPressed: () => context.go('/register'), child: Text('Forgot Password?')),
    ]));
  }
}
`,
      );
      await writeFile(
        join(dir, "lib/pages/home_page.dart"),
        `import 'package:flutter/material.dart';
class HomePage extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container();
  }
}
`,
      );
      await writeFile(
        join(dir, "lib/router/app_router.dart"),
        `import 'package:go_router/go_router.dart';
final appRouter = GoRouter(routes: [
  GoRoute(path: '/login', builder: (_, __) => null),
  GoRoute(path: '/home', builder: (_, __) => null),
]);
`,
      );

      const r = await extractFlutter(dir);

      const names = r.pages.map((p) => p.name);
      assert.ok(names.includes("LoginPage"));
      assert.ok(names.includes("HomePage"));

      const routeNames = r.routes.map((rt) => rt.name);
      assert.ok(routeNames.includes("/home"));
      assert.ok(routeNames.includes("/register"));
      assert.ok(routeNames.includes("/login"));

      const texts = r.handlers.map((h) => h.text);
      assert.ok(texts.includes("Sign In"));
      assert.ok(texts.includes("Forgot Password?"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectPlatform", () => {
  it("recognises flutter project from pubspec.yaml", async () => {
    const dir = await newDir();
    try {
      await writeFile(
        join(dir, "pubspec.yaml"),
        "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      );
      const r = await detectPlatform(dir);
      assert.equal(r.platform, "flutter");
      assert.equal(r.app_name, "my_app");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recognises android-native from app/build.gradle.kts", async () => {
    const dir = await newDir();
    try {
      await mkdir(join(dir, "app"), { recursive: true });
      await writeFile(
        join(dir, "build.gradle.kts"),
        "android { namespace = \"com.example.demo\" }",
      );
      await writeFile(
        join(dir, "app/build.gradle.kts"),
        "android {\n  defaultConfig { applicationId = \"com.example.demo\" }\n}\n",
      );
      const r = await detectPlatform(dir);
      assert.equal(r.platform, "android-native");
      assert.equal(r.package_or_bundle, "com.example.demo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
