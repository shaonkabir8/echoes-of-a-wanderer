import { scanContent } from "./publishing.mjs";

const scan = await scanContent(process.cwd());
const failures = [
  ...scan.discoveryErrors,
  ...scan.routeErrors,
  ...scan.documents.flatMap((document) =>
    document.errors.map((message) => `${document.sourcePath}: ${message}`)),
];

if (scan.documents.length === 0) {
  failures.push("letters/: no Markdown writing documents found");
}

if (failures.length > 0) {
  console.error(`Content validation failed with ${failures.length} error(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const publicCount = scan.documents.filter((document) => document.visibility === "public").length;
  console.log(`Validated ${scan.documents.length} writing document(s); ${publicCount} explicitly public.`);
}
