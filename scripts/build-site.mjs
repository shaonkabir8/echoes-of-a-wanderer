import { buildSite } from "./publishing.mjs";

try {
  const result = await buildSite({ rootDirectory: process.cwd() });
  console.log(`Built ${result.publishedCount} explicitly public writing page(s) into dist/.`);
} catch (error) {
  console.error(`Static site build failed: ${error.message}`);
  process.exitCode = 1;
}
