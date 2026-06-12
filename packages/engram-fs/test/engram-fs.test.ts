import { describe, expect, test } from "bun:test";
import { EngramFs, FsPathError, normPath, liveKey, casKey, resolve } from "../src/index.js";
import { FakeManifest, FakeR2 } from "./fakes.js";

function mk(doId = "do-a") {
  const r2 = new FakeR2();
  const manifest = new FakeManifest();
  const fs = new EngramFs({ r2, manifest, doId, cell: () => 7, nowMs: () => 1234 });
  return { fs, r2, manifest };
}

describe("normPath / resolve — /workspace canonicalization", () => {
  test("collapses ., //, leading/trailing slash (bare-/ -> rel, back-compat)", () => {
    expect(normPath("/a//b/./c/")).toBe("a/b/c");
    expect(normPath("")).toBe("");
    expect(normPath("a/b/..")).toBe("a");
  });
  test("THE RULE: relative resolves against cwd (default /workspace)", () => {
    expect(resolve("x.txt")).toBe("x.txt"); // cwd=/workspace
    expect(resolve("dir/x")).toBe("dir/x");
    expect(resolve("./x")).toBe("x");
  });
  test("THREE FORMS SAME KEY at cwd=/workspace", () => {
    // "x.txt", "/x.txt", "/workspace/x.txt" all collapse to the same rel "x.txt".
    expect(resolve("x.txt")).toBe("x.txt");
    expect(resolve("/x.txt")).toBe("x.txt");
    expect(resolve("/workspace/x.txt")).toBe("x.txt");
    expect(liveKey("do-a", "x.txt")).toBe("fs/do-a/x.txt");
    expect(liveKey("do-a", "/x.txt")).toBe("fs/do-a/x.txt");
    expect(liveKey("do-a", "/workspace/x.txt")).toBe("fs/do-a/x.txt");
  });
  test("cwd=/workspace/proj changes RELATIVE resolution, NOT absolute", () => {
    expect(resolve("x.txt", "/workspace/proj")).toBe("proj/x.txt"); // relative -> under cwd
    expect(resolve("dir/x", "/workspace/proj")).toBe("proj/dir/x");
    expect(resolve("/x.txt", "/workspace/proj")).toBe("x.txt"); // absolute is ROOT-relative
    expect(resolve("/workspace/x.txt", "/workspace/proj")).toBe("x.txt");
  });
  test("rejects traversal that ESCAPES /workspace", () => {
    expect(() => normPath("../etc")).toThrow(FsPathError);
    expect(() => normPath("../etc")).toThrow(/escapes \/workspace/);
    expect(() => normPath("a/../../b")).toThrow(/escapes \/workspace/);
    expect(() => resolve("../../etc/passwd")).toThrow(FsPathError);
  });
  test("`..` WITHIN /workspace is fine (does not escape)", () => {
    expect(resolve("a/b/../c")).toBe("a/c");
    expect(resolve("../x", "/workspace/proj")).toBe("x"); // climbs proj -> workspace, stays in
  });
  test("rejects NUL (EINVAL)", () => {
    expect(() => normPath("a" + String.fromCharCode(0) + "b")).toThrow(/NUL/);
    try {
      normPath("a\0b");
    } catch (e) {
      expect((e as FsPathError).code).toBe("EINVAL");
    }
  });
  test("a normal path with a space is fine (NUL != space)", () => {
    expect(normPath("my file.txt")).toBe("my file.txt");
  });
});

describe("EngramFs cwd / chdir — session CWD under /workspace", () => {
  test("default cwd is /workspace; relative writes land at root", async () => {
    const { fs, r2 } = mk();
    expect(fs.cwd()).toBe("/workspace");
    await fs.writeFile("rel.txt", "x");
    expect(r2.store.get("fs/do-a/rel.txt")).toBeDefined();
  });
  test("chdir changes relative resolution; absolute stays root-relative", async () => {
    const { fs, r2 } = mk();
    expect(fs.chdir("proj")).toBe("/workspace/proj");
    expect(fs.cwd()).toBe("/workspace/proj");
    await fs.writeFile("a.txt", "1"); // relative -> /workspace/proj/a.txt
    await fs.writeFile("/b.txt", "2"); // absolute -> /workspace/b.txt
    expect(r2.store.get("fs/do-a/proj/a.txt")).toBeDefined();
    expect(r2.store.get("fs/do-a/b.txt")).toBeDefined();
  });
  test("chdir is CLAMPED under /workspace (escape throws EACCES)", () => {
    const { fs } = mk();
    expect(() => fs.chdir("../../etc")).toThrow(FsPathError);
    expect(() => fs.chdir("../../etc")).toThrow(/escapes \/workspace/);
    expect(fs.cwd()).toBe("/workspace"); // unchanged
  });
  test("constructor cwd opt is clamped + applied", () => {
    const r2 = new FakeR2();
    const fs = new EngramFs({ r2, manifest: new FakeManifest(), doId: "do-a", cwd: "/workspace/sub" });
    expect(fs.cwd()).toBe("/workspace/sub");
  });
});

describe("key scheme — cross-session isolation (FLAT fs/<doId>/<rel>)", () => {
  test("keys are doId-rooted, FLAT (no live/), differ per session", () => {
    expect(liveKey("do-a", "x.txt")).toBe("fs/do-a/x.txt");
    expect(liveKey("do-b", "x.txt")).toBe("fs/do-b/x.txt");
    expect(liveKey("do-a", "x.txt")).not.toBe(liveKey("do-b", "x.txt"));
  });
  test("no path can escape into another session's prefix", () => {
    // even a crafted path can't climb out of fs/<doId>/ (above /workspace)
    expect(() => liveKey("do-a", "../../do-b/secret")).toThrow(FsPathError);
  });
  test("casKey requires a real sha256", () => {
    expect(() => casKey("do-a", "nothex")).toThrow(/sha256/);
    expect(casKey("do-a", "a".repeat(64))).toBe(`fs/do-a/cas/${"a".repeat(64)}`);
  });
});

describe("direct writes", () => {
  test("writeFile direct -> R2 body + manifest row + version bump + pointer", async () => {
    const { fs, r2, manifest } = mk();
    const ptr = await fs.writeFile("dir/hello.txt", "hello vfs");
    expect(r2.store.get("fs/do-a/dir/hello.txt")).toBeDefined();
    expect((await manifest.get("dir/hello.txt"))?.size).toBe(9);
    expect(ptr.path).toBe("dir/hello.txt");
    expect(ptr.size).toBe(9);
    expect(ptr.etag).toStartWith("etag-");
    expect(ptr.preview).toBe("hello vfs");
    expect(await fs.version()).toBe(1);
  });
  test("fsVersion bumps on EVERY direct write (final-review fix)", async () => {
    const { fs } = mk();
    await fs.writeFile("a", "1");
    await fs.writeFile("b", "2");
    await fs.writeFile("a", "3");
    expect(await fs.version()).toBe(3);
  });
  test("readFile roundtrip + range + missing", async () => {
    const { fs } = mk();
    await fs.writeFile("f", "abcdef");
    expect(await fs.readFileText("f")).toBe("abcdef");
    expect(new TextDecoder().decode((await fs.readFile("f", { offset: 2, length: 2 }))!)).toBe("cd");
    expect(await fs.readFile("missing")).toBeNull();
  });
  test("delete removes body + row + bumps version", async () => {
    const { fs, r2 } = mk();
    await fs.writeFile("g", "x");
    expect(await fs.deleteFile("g")).toBe(true);
    expect(r2.store.get("fs/do-a/g")).toBeUndefined();
    expect(await fs.stat("g")).toBeNull();
    expect(await fs.deleteFile("g")).toBe(false);
  });
  test("ls lists from the manifest", async () => {
    const { fs } = mk();
    await fs.writeFile("d/a", "1");
    await fs.writeFile("d/b", "2");
    await fs.writeFile("e/c", "3");
    expect((await fs.ls("d")).map((e) => e.path).sort()).toEqual(["d/a", "d/b"]);
    expect((await fs.ls()).length).toBe(3);
  });
});

describe("two sessions cannot read each other's files", () => {
  test("shared R2, separate doId/manifest => isolated", async () => {
    const r2 = new FakeR2();
    const a = new EngramFs({ r2, manifest: new FakeManifest(), doId: "do-a" });
    const b = new EngramFs({ r2, manifest: new FakeManifest(), doId: "do-b" });
    await a.writeFile("secret.txt", "A-only");
    expect(await b.readFileText("secret.txt")).toBeNull(); // b's manifest has no such row
    expect(await a.readFileText("secret.txt")).toBe("A-only");
    // even sharing the same physical R2, keys are doId-namespaced
    expect(r2.store.has("fs/do-a/secret.txt")).toBe(true);
    expect(r2.store.has("fs/do-b/secret.txt")).toBe(false);
  });
});

describe("content-addressed store (CAS) — pointers + dedup", () => {
  test("putCas returns sha256 + pointer; identical content dedups the PUT", async () => {
    const { fs, r2 } = mk();
    const r1 = await fs.putCas("same-bytes");
    const r2res = await fs.putCas("same-bytes");
    expect(r1.sha256).toBe(r2res.sha256);
    expect(r1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.putCount).toBe(1); // second put skipped (head found it)
    expect(new TextDecoder().decode((await fs.readCas(r1.sha256))!)).toBe("same-bytes");
  });
});

describe("manifest export", () => {
  test("exportManifest writes an external-readable index at .engram/manifest.json", async () => {
    const { fs, r2 } = mk();
    await fs.writeFile("a.txt", "1");
    await fs.writeFile("d/b.txt", "22");
    const ptr = await fs.exportManifest();
    expect(ptr.path).toBe(".engram/manifest.json");
    const raw = r2.store.get("fs/do-a/.engram/manifest.json")!;
    const doc = JSON.parse(new TextDecoder().decode(raw));
    expect(doc.doId).toBe("do-a");
    expect(doc.fsVersion).toBe(2);
    expect(doc.files.map((f: { path: string }) => f.path)).toEqual(["a.txt", "d/b.txt"]);
  });
});

describe("txn (staged-commit) path", () => {
  test("staged writes are read-visible pre-flush, durable only after flushStaged", async () => {
    const { fs, r2, manifest } = mk();
    fs.stageWrite("staged.txt", "pending");
    expect(fs.stagedCount()).toBe(1);
    // visible to same-session reads before flush
    expect(await fs.readFileText("staged.txt")).toBe("pending");
    // not yet durable
    expect(r2.store.get("fs/do-a/staged.txt")).toBeUndefined();
    const ptrs = await fs.flushStaged();
    expect(ptrs.length).toBe(1);
    expect(r2.store.get("fs/do-a/staged.txt")).toBeDefined();
    expect((await manifest.get("staged.txt"))?.origin).toBe("cell");
    expect(fs.stagedCount()).toBe(0);
  });
  test("flushStaged bumps fsVersion ONCE regardless of staged count", async () => {
    const { fs } = mk();
    fs.stageWrite("a", "1");
    fs.stageWrite("b", "2");
    fs.stageWrite("c", "3");
    await fs.flushStaged();
    expect(await fs.version()).toBe(1);
  });
  test("discardStaged drops without committing", async () => {
    const { fs, r2 } = mk();
    fs.stageWrite("z", "x");
    fs.discardStaged();
    await fs.flushStaged();
    expect(r2.store.size).toBe(0);
    expect(await fs.version()).toBe(0);
  });
});
