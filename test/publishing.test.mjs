import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSite,
  normalizeVisibility,
  parseMarkdownDocument,
  routeForDocument,
  scanContent,
} from "../scripts/publishing.mjs";

async function makeSite() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "echoes-pages-test-"));
  await fs.mkdir(path.join(root, "letters", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, "index.html"),
    '<!doctype html><html><head><title>Existing home</title></head><body><header>Existing landing</header><main class="wrap"><p>Keep this page.</p></main></body></html>',
  );
  await fs.writeFile(path.join(root, "assets", "test.css"), "body { color: white; }");
  return root;
}

const validPublic = `---
title: "সকালের চিঠি"
category: letters
visibility: PuBlIc
date: "2026-01-03"
author: "লেখক"
tags: ["বাংলা"]
---

বাংলা public sentinel — নিরাপদ লেখা।
`;

test("visibility normalization is explicit and case-insensitive", () => {
  assert.equal(normalizeVisibility(" public "), "public");
  assert.equal(normalizeVisibility("PRIVATE"), "private");
  assert.equal(normalizeVisibility(true), null);
  assert.equal(normalizeVisibility("unlisted"), null);
  assert.equal(normalizeVisibility(undefined), null);
});

test("frontmatter validation rejects missing, malformed, and incorrectly typed metadata", () => {
  const valid = parseMarkdownDocument(validPublic, "letters/public.md");
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.visibility, "public");

  const cases = [
    ["no frontmatter", "A body without metadata"],
    ["malformed YAML", "---\ntitle: [broken\ncategory: letters\nvisibility: public\n---\nbody"],
    ["empty frontmatter", "---\n---\nbody"],
    ["missing visibility", "---\ntitle: Draft\ncategory: letters\n---\nbody"],
    ["invalid visibility", "---\ntitle: Draft\ncategory: letters\nvisibility: maybe\n---\nbody"],
    ["non-string visibility", "---\ntitle: Draft\ncategory: letters\nvisibility: true\n---\nbody"],
    ["missing category", "---\ntitle: Draft\nvisibility: private\n---\nbody"],
    ["invalid date", "---\ntitle: Draft\ncategory: letters\nvisibility: private\ndate: 2026-02-31\n---\nbody"],
  ];

  for (const [label, source] of cases) {
    const result = parseMarkdownDocument(source, `letters/${label}.md`);
    assert.ok(result.errors.length > 0, `${label} should fail validation`);
  }
});

test("only valid explicit-public content enters routes and all artifacts are privacy-audited", async (t) => {
  const root = await makeSite();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, "letters", "সকাল.md"), validPublic);
  await fs.writeFile(path.join(root, "letters", "README.md"), "README fixture should not publish.");
  await fs.writeFile(path.join(root, "letters", "nested", "private note.md"), `---
title: "PRIVATE_TITLE_SENTINEL"
category: letters
visibility: private
author: "PRIVATE_AUTHOR_SENTINEL"
tags: ["PRIVATE_TAG_SENTINEL"]
---

PRIVATE_BODY_SENTINEL
`);
  await fs.writeFile(path.join(root, "letters", "missing.md"), `---
title: "MISSING_TITLE_SENTINEL"
category: letters
---

MISSING_VISIBILITY_SENTINEL
`);
  await fs.writeFile(path.join(root, "letters", "invalid.md"), `---
title: "INVALID_TITLE_SENTINEL"
category: letters
visibility: public-ish
---

INVALID_VISIBILITY_SENTINEL
`);
  await fs.writeFile(path.join(root, "letters", "broken.md"), `---
title: [invalid
category: letters
visibility: public
---

MALFORMED_YAML_SENTINEL
`);
  await fs.writeFile(
    path.join(root, "letters", "সকাল.md"),
    validPublic + "\n[private document](nested/private%20note.md)\n\n<script>window.x=1</script>\n",
  );
  await fs.mkdir(path.join(root, "activities"), { recursive: true });
  await fs.writeFile(path.join(root, "activities", "private-activity.md"), "ACTIVITY_SCOPE_SENTINEL");

  const scan = await scanContent(root);
  assert.equal(scan.documents.length, 5);
  assert.ok(scan.documents.some((document) => document.errors.length > 0));

  const result = await buildSite({ rootDirectory: root });
  assert.equal(result.publishedCount, 1);

  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else files.push(file);
    }
  }
  await collect(path.join(root, "dist"));
  const outputText = (await Promise.all(files.map((file) => fs.readFile(file)))).map((buffer) => buffer.toString("utf8")).join("\n");

  assert.match(outputText, /বাংলা public sentinel/);
  assert.match(outputText, /href="\/letters\/"/);
  assert.ok(outputText.includes(`href="${routeForDocument("সকাল.md")}"`));
  assert.match(outputText, /&lt;script&gt;window\.x=1&lt;\/script&gt;/);
  for (const sentinel of [
    "PRIVATE_TITLE_SENTINEL",
    "PRIVATE_AUTHOR_SENTINEL",
    "PRIVATE_TAG_SENTINEL",
    "PRIVATE_BODY_SENTINEL",
    "MISSING_TITLE_SENTINEL",
    "MISSING_VISIBILITY_SENTINEL",
    "INVALID_TITLE_SENTINEL",
    "INVALID_VISIBILITY_SENTINEL",
    "MALFORMED_YAML_SENTINEL",
    "README fixture should not publish",
    "ACTIVITY_SCOPE_SENTINEL",
  ]) {
    assert.ok(!outputText.includes(sentinel), `public output leaked ${sentinel}`);
  }
  assert.ok(!files.some((file) => file.endsWith(".md")), "Markdown source must not be copied to dist");
  assert.ok(!files.some((file) => file.includes(`${path.sep}private note${path.sep}`)));

  const article = await fs.readFile(
    path.join(root, "dist", "letters", "সকাল", "index.html"),
    "utf8",
  );
  assert.match(article, /href="#".*aria-disabled="true"/);
  assert.doesNotMatch(article, /nested\/private/);
});

test("rebuilding after a public-to-private change removes stale routes", async (t) => {
  const root = await makeSite();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "letters", "change.md");
  await fs.writeFile(file, validPublic);

  await buildSite({ rootDirectory: root });
  assert.ok(await fs.stat(path.join(root, "dist", "letters", "change", "index.html")));

  await fs.writeFile(file, validPublic.replace("PuBlIc", "private"));
  await buildSite({ rootDirectory: root });
  await assert.rejects(fs.stat(path.join(root, "dist", "letters", "change", "index.html")));
  assert.ok(await fs.stat(path.join(root, "dist", "letters", "index.html")));
});

test("nested Bangla and spaced filenames have stable routes", () => {
  assert.equal(
    routeForDocument("nested/আমার চিঠি.md"),
    `/letters/nested/${encodeURIComponent("আমার-চিঠি")}/`,
  );
});

test("duplicate normalized routes are rejected", async (t) => {
  const root = await makeSite();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "letters", "same name.md"), validPublic);
  await fs.writeFile(path.join(root, "letters", "same-name.md"), validPublic);
  await assert.rejects(buildSite({ rootDirectory: root }), /route collides/);
  await assert.rejects(fs.stat(path.join(root, "dist")));
});
