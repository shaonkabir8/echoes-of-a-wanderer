import fs from "node:fs/promises";
import path from "node:path";
import {
  CONTENT_DIRECTORY,
  listFilesRecursively,
  routeForDocument,
  scanContent,
} from "./publishing.mjs";

const root = process.cwd();
const output = path.join(root, "dist");
const scan = await scanContent(root);
const files = await listFilesRecursively(output);
const failures = [];

for (const required of ["index.html", "404.html", `${CONTENT_DIRECTORY}/index.html`]) {
  if (!files.includes(required)) failures.push(`missing output entry: ${required}`);
}

for (const file of files) {
  if (/\.md$/i.test(file) || /(^|\/)readme\.md$/i.test(file) || file.startsWith("activities/")) {
    failures.push(`source or out-of-scope content copied to dist: ${file}`);
  }
}

for (const document of scan.documents) {
  const route = routeForDocument(document.relativePath);
  const routeSegments = route
    .slice(`/${CONTENT_DIRECTORY}/`.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const routeFile = path.posix.join(CONTENT_DIRECTORY, ...routeSegments, "index.html");
  const exists = files.includes(routeFile);
  const shouldExist = document.valid && document.visibility === "public";
  if (exists !== shouldExist) {
    failures.push(`${document.sourcePath}: generated route state does not match explicit public visibility`);
  }
}

const homepage = await fs.readFile(path.join(output, "index.html"), "utf8").catch(() => "");
if (!homepage.includes('href="/letters/"')) failures.push("homepage does not link to the public writing listing");

if (failures.length > 0) {
  console.error(`Output audit failed with ${failures.length} error(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Output audit passed: ${files.length} artifacts; no Markdown source or out-of-scope content copied.`);
}
