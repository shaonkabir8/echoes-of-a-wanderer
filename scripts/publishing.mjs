import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import MarkdownIt from "markdown-it";

export const CONTENT_DIRECTORY = "letters";
export const OUTPUT_DIRECTORY = "dist";
const README_NAME = "readme.md";
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".css", ".gif", ".ico", ".jpeg", ".jpg", ".js", ".otf", ".png",
  ".svg", ".ttf", ".webp", ".woff", ".woff2",
]);

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const toPosix = (value) => value.split(path.sep).join("/");
const routeKey = (value) => value.normalize("NFC").toLocaleLowerCase("en");

export function normalizeVisibility(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "public" || normalized === "private" ? normalized : null;
}

function validDate(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function categoryIsValid(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function validateMetadata(metadata) {
  const errors = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["frontmatter must be a YAML mapping"];
  }

  if (typeof metadata.title !== "string" || !metadata.title.trim()) {
    errors.push("title must be a non-empty string");
  }
  if (!own(metadata, "category") || !categoryIsValid(metadata.category)) {
    errors.push("category must be a non-empty string or list of strings");
  }
  if (!own(metadata, "visibility")) {
    errors.push("visibility is required");
  } else if (typeof metadata.visibility !== "string") {
    errors.push("visibility must be a string");
  } else if (!normalizeVisibility(metadata.visibility)) {
    errors.push("visibility must be public or private");
  }

  for (const field of ["type", "status", "language", "author", "description", "time"]) {
    if (own(metadata, field) && typeof metadata[field] !== "string") {
      errors.push(`${field} must be a string when provided`);
    }
  }
  if (own(metadata, "date") && !validDate(metadata.date)) {
    errors.push("date must be a valid YYYY-MM-DD date or ISO timestamp");
  }
  if (own(metadata, "tags")) {
    const tags = metadata.tags;
    const validTags = typeof tags === "string" ||
      (Array.isArray(tags) && tags.every((tag) => typeof tag === "string"));
    if (!validTags) errors.push("tags must be a string or a list of strings");
  }

  return errors;
}

export function parseMarkdownDocument(source, sourcePath = "<memory>") {
  const text = String(source).replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return {
      sourcePath,
      metadata: null,
      body: "",
      visibility: null,
      errors: ["missing or malformed YAML frontmatter"],
    };
  }

  const errors = [];
  let metadata = null;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length > 0) {
      errors.push("malformed YAML frontmatter");
    } else {
      metadata = document.toJS();
    }
  } catch {
    errors.push("malformed YAML frontmatter");
  }

  errors.push(...validateMetadata(metadata));
  return {
    sourcePath,
    metadata,
    body: text.slice(match[0].length),
    visibility: normalizeVisibility(metadata?.visibility),
    errors: [...new Set(errors)],
  };
}

function slugSegment(value) {
  const slug = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{M}\p{N}_-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug || slug === "." || slug === "..") {
    throw new Error("a Markdown file has an empty or unsafe route segment");
  }
  return slug;
}

function documentRoute(relativePath) {
  const withoutExtension = relativePath.replace(/\.md$/i, "");
  const segments = withoutExtension.split("/").map(slugSegment);
  return {
    segments,
    url: `/${CONTENT_DIRECTORY}/${segments.map(encodeURIComponent).join("/")}/`,
  };
}

async function discoverMarkdown(directory, contentRoot, output, discoveryErrors) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    discoveryErrors.push(`cannot read ${CONTENT_DIRECTORY}/ content: ${error.message}`);
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name.toLowerCase().endsWith(".md")) {
        discoveryErrors.push(`${CONTENT_DIRECTORY}/${toPosix(path.relative(contentRoot, absolutePath))}: symbolic links are not allowed`);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await discoverMarkdown(absolutePath, contentRoot, output, discoveryErrors);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".md") &&
      entry.name.toLowerCase() !== README_NAME
    ) {
      output.push(toPosix(path.relative(contentRoot, absolutePath)));
    }
  }
}

export async function scanContent(rootDirectory = process.cwd()) {
  const root = path.resolve(rootDirectory);
  const contentRoot = path.join(root, CONTENT_DIRECTORY);
  const discoveryErrors = [];
  const relativeFiles = [];
  await discoverMarkdown(contentRoot, contentRoot, relativeFiles, discoveryErrors);

  const documents = [];
  const routeErrors = [];
  const routes = new Map();

  for (const relativePath of relativeFiles.sort((a, b) => a.localeCompare(b, "en"))) {
    const sourcePath = `${CONTENT_DIRECTORY}/${relativePath}`;
    let source;
    try {
      source = await fs.readFile(path.join(contentRoot, relativePath), "utf8");
    } catch (error) {
      discoveryErrors.push(`${sourcePath}: cannot read document: ${error.message}`);
      continue;
    }

    const parsed = parseMarkdownDocument(source, sourcePath);
    let route;
    try {
      route = documentRoute(relativePath);
    } catch (error) {
      routeErrors.push(`${sourcePath}: ${error.message}`);
    }

    if (route) {
      const key = routeKey(route.segments.join("/"));
      const previous = routes.get(key);
      if (previous) {
        routeErrors.push(`${sourcePath}: route collides with ${previous}`);
      } else {
        routes.set(key, sourcePath);
      }
    }

    documents.push({
      ...parsed,
      relativePath,
      route: route?.url ?? null,
      source,
      valid: parsed.errors.length === 0 && Boolean(route),
    });
  }

  return { root, contentRoot, documents, discoveryErrors, routeErrors };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayTitle(document) {
  return document.metadata.title.trim();
}

function displayCategory(value) {
  const categories = Array.isArray(value) ? value : [value];
  return categories.map((item) => String(item).trim()).filter(Boolean).join(" · ");
}

function routeMapFor(publicDocuments) {
  return new Map(publicDocuments.map((document) => [
    routeKey(document.relativePath),
    document.route,
  ]));
}

function encodePath(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

function rewriteLocalTarget(rawTarget, document, publicRoutes, copiedAssets) {
  if (typeof rawTarget !== "string" || !rawTarget.trim()) return null;
  const target = rawTarget.trim();
  if (/^(?:https?:|mailto:|tel:|#|\/\/)/i.test(target)) return target;
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return null;

  const match = /^([^?#]*)([?#].*)?$/.exec(target);
  const rawPath = match?.[1] ?? "";
  const suffix = match?.[2] ?? "";
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!decodedPath) return suffix || null;

  const repositoryPath = decodedPath.startsWith("/")
    ? path.posix.normalize(decodedPath.slice(1))
    : path.posix.normalize(path.posix.join(
      CONTENT_DIRECTORY,
      path.posix.dirname(document.relativePath),
      decodedPath,
    ));
  if (repositoryPath === ".." || repositoryPath.startsWith("../")) return null;

  if (repositoryPath.startsWith(`${CONTENT_DIRECTORY}/`) && /\.md$/i.test(repositoryPath)) {
    const relativePath = repositoryPath.slice(CONTENT_DIRECTORY.length + 1);
    const route = publicRoutes.get(routeKey(relativePath));
    return route ? `${route}${suffix}` : null;
  }

  if (repositoryPath.startsWith("assets/") && copiedAssets.has(routeKey(repositoryPath))) {
    return `/${encodePath(repositoryPath)}${suffix}`;
  }

  return null;
}

function renderMarkdown(body, document, publicRoutes, copiedAssets) {
  const originalLinkOpen = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const rewritten = rewriteLocalTarget(
      token.attrGet("href"),
      environment.document,
      environment.publicRoutes,
      environment.copiedAssets,
    );
    if (rewritten === null) {
      token.attrSet("href", "#");
      token.attrSet("aria-disabled", "true");
    } else {
      token.attrSet("href", rewritten);
      if (/^https?:\/\//i.test(rewritten)) token.attrSet("rel", "noopener noreferrer");
    }
    return originalLinkOpen
      ? originalLinkOpen(tokens, index, options, environment, renderer)
      : markdown.renderer.renderToken(tokens, index, options);
  };

  const originalImage = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
    const token = tokens[index];
    const rewritten = rewriteLocalTarget(
      token.attrGet("src"),
      environment.document,
      environment.publicRoutes,
      environment.copiedAssets,
    );
    if (rewritten === null) {
      return token.content ? `<span class="writing-image-alt">${escapeHtml(token.content)}</span>` : "";
    }
    token.attrSet("src", rewritten);
    return originalImage
      ? originalImage(tokens, index, options, environment, renderer)
      : markdown.renderer.renderToken(tokens, index, options);
  };

  try {
    return markdown.render(body, { document, publicRoutes, copiedAssets });
  } finally {
    markdown.renderer.rules.link_open = originalLinkOpen;
    markdown.renderer.rules.image = originalImage;
  }
}

function formatDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" ? value : "";
}

function pageDescription(document) {
  const configured = document.metadata.description;
  if (typeof configured === "string" && configured.trim()) return configured.trim().slice(0, 180);
  const paragraph = document.body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~`-]/g, " ")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return (paragraph || "এক মহাজাগতিক মুসাফিরের প্রকাশিত লেখা।").slice(0, 180);
}

function renderPageHead(title, description, type = "website") {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  return `<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${safeDescription}">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:type" content="${type}">
  <meta property="og:locale" content="bn_BD">
  <title>${safeTitle}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,400&family=Hind+Siliguri:wght@300;400;500;600;700&family=Tiro+Bangla:ital@0;1&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/letters.css">
</head>`;
}

function renderListing(publicDocuments) {
  const cards = publicDocuments.map((document) => {
    const title = escapeHtml(displayTitle(document));
    const category = escapeHtml(displayCategory(document.metadata.category));
    const date = formatDate(document.metadata.date);
    const dateMarkup = date
      ? `<time class="writing-date" datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>`
      : "";
    const description = escapeHtml(pageDescription(document));
    return `<li class="writing-list__item">
      <a class="writing-card" href="${escapeHtml(document.route)}">
        <span class="writing-card__eyebrow">${category}${date ? ` · ${escapeHtml(date)}` : ""}</span>
        <span class="writing-card__title">${title}</span>
        <span class="writing-card__description">${description}</span>
        <span class="writing-card__action">লেখাটি পড়ুন <span aria-hidden="true">↗</span></span>
      </a>
      ${dateMarkup}
    </li>`;
  }).join("\n");

  const emptyState = `<p class="writing-empty">এখনও কোনো লেখা প্রকাশের জন্য চিহ্নিত করা হয়নি।</p>`;
  const title = "প্রকাশিত লেখা — Echoes of a Wanderer";
  const description = "Echoes of a Wanderer-এর প্রকাশের জন্য চিহ্নিত বাংলা লেখা।";
  return `${renderPageHead(title, description)}
<body class="writing-body">
  <main class="writing-shell">
    <nav class="writing-nav" aria-label="প্রধান নেভিগেশন">
      <a href="/">মূল পৃষ্ঠা</a>
      <span aria-hidden="true">/</span>
      <span>প্রকাশিত লেখা</span>
    </nav>
    <header class="writing-header">
      <p class="writing-eyebrow">ECHOES OF A WANDERER</p>
      <h1>প্রকাশিত লেখা</h1>
      <p>শুধু প্রকাশের জন্য নির্দিষ্ট করা লেখাগুলো।</p>
    </header>
    <section aria-labelledby="published-list-title">
      <h2 class="visually-hidden" id="published-list-title">লেখার তালিকা</h2>
      ${publicDocuments.length ? `<ul class="writing-list">${cards}</ul>` : emptyState}
    </section>
    <footer class="writing-footer">© সর্বস্বত্ব সংরক্ষিত</footer>
  </main>
</body>
</html>`;
}

function renderArticle(document, publicRoutes, copiedAssets) {
  const title = displayTitle(document);
  const description = pageDescription(document);
  const category = displayCategory(document.metadata.category);
  const date = formatDate(document.metadata.date);
  const author = typeof document.metadata.author === "string" ? document.metadata.author : "";
  const tags = Array.isArray(document.metadata.tags) ? document.metadata.tags : [];
  const meta = [
    category && `<span>${escapeHtml(category)}</span>`,
    date && `<time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time>`,
    author && `<span>${escapeHtml(author)}</span>`,
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');
  const tagList = tags.length
    ? `<ul class="writing-tags" aria-label="লেখার বিষয়">${tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join("")}</ul>`
    : "";
  const content = renderMarkdown(document.body, document, publicRoutes, copiedAssets);
  return `${renderPageHead(`${title} — Echoes of a Wanderer`, description, "article")}
<body class="writing-body">
  <main class="writing-shell">
    <nav class="writing-nav" aria-label="প্রধান নেভিগেশন">
      <a href="/">মূল পৃষ্ঠা</a>
      <span aria-hidden="true">/</span>
      <a href="/letters/">প্রকাশিত লেখা</a>
    </nav>
    <article class="writing-article">
      <header class="writing-article__header">
        <p class="writing-eyebrow">${escapeHtml(category || "প্রকাশিত লেখা")}</p>
        <h1>${escapeHtml(title)}</h1>
        ${meta ? `<div class="writing-meta">${meta}</div>` : ""}
        ${tagList}
      </header>
      <div class="writing-content">${content}</div>
    </article>
    <footer class="writing-footer">© সর্বস্বত্ব সংরক্ষিত</footer>
  </main>
</body>
</html>`;
}

function injectListingLink(homepage) {
  let result = homepage;
  if (!/href=["']\/assets\/letters\.css["']/i.test(result)) {
    const headEnd = /<\/head>/i;
    if (!headEnd.test(result)) throw new Error("index.html has no closing head tag");
    result = result.replace(headEnd, '  <link rel="stylesheet" href="/assets/letters.css">\n</head>');
  }

  if (!/class=["'][^"']*\bpublished-nav\b/i.test(result)) {
    const main = /<main\b[^>]*class=["'][^"']*\bwrap\b[^"']*["'][^>]*>/i;
    if (!main.test(result)) throw new Error('index.html is missing the expected <main class="wrap"> insertion point');
    const navigation = `<nav class="published-nav" aria-label="প্রকাশিত লেখার নেভিগেশন">
  <a href="/letters/"><span>চিঠির সংগ্রহ</span><span aria-hidden="true">↗</span></a>
</nav>\n`;
    result = result.replace(main, (openingTag) => `${navigation}${openingTag}`);
  }
  return result;
}

async function copyStaticAssets(sourceDirectory, destinationDirectory) {
  const copied = new Set();
  try {
    await fs.access(sourceDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return copied;
    throw error;
  }

  async function copyTree(directory, relativeDirectory = "") {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const sourcePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        await copyTree(sourcePath, relativePath);
        continue;
      }
      if (!child.isFile() || !ALLOWED_ASSET_EXTENSIONS.has(path.extname(child.name).toLowerCase())) continue;
      const target = path.join(destinationDirectory, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(sourcePath, target);
      copied.add(routeKey(path.posix.join("assets", relativePath)));
    }
  }

  await copyTree(sourceDirectory);
  return copied;
}

function assertOutputIsChild(root, output) {
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("output directory must be a child of the repository root");
  }
}

export async function buildSite({
  rootDirectory = process.cwd(),
  outputDirectory = path.join(rootDirectory, OUTPUT_DIRECTORY),
} = {}) {
  const root = path.resolve(rootDirectory);
  const output = path.resolve(outputDirectory);
  assertOutputIsChild(root, output);
  const temporaryOutput = `${output}.tmp-${process.pid}`;

  await fs.rm(output, { recursive: true, force: true });
  await fs.rm(temporaryOutput, { recursive: true, force: true });

  try {
    const indexPath = path.join(root, "index.html");
    const homepage = await fs.readFile(indexPath, "utf8");
    const scan = await scanContent(root);
    if (scan.discoveryErrors.length > 0) {
      throw new Error(scan.discoveryErrors.join("\n"));
    }
    if (scan.routeErrors.length > 0) {
      throw new Error(scan.routeErrors.join("\n"));
    }

    const publicDocuments = scan.documents
      .filter((document) => document.valid && document.visibility === "public")
      .sort((a, b) => {
        const dateDifference = Date.parse(formatDate(b.metadata.date)) - Date.parse(formatDate(a.metadata.date));
        return (Number.isFinite(dateDifference) ? dateDifference : 0) || a.relativePath.localeCompare(b.relativePath, "en");
      });
    const publicRoutes = routeMapFor(publicDocuments);

    await fs.mkdir(temporaryOutput, { recursive: true });
    const linkedHomepage = injectListingLink(homepage);
    await fs.writeFile(path.join(temporaryOutput, "index.html"), linkedHomepage, "utf8");
    const copiedAssets = await copyStaticAssets(
      path.join(root, "assets"),
      path.join(temporaryOutput, "assets"),
    );

    const listingPath = path.join(temporaryOutput, CONTENT_DIRECTORY, "index.html");
    await fs.mkdir(path.dirname(listingPath), { recursive: true });
    await fs.writeFile(listingPath, renderListing(publicDocuments), "utf8");

    for (const document of publicDocuments) {
      const route = documentRoute(document.relativePath);
      const pagePath = path.join(
        temporaryOutput,
        CONTENT_DIRECTORY,
        ...route.segments,
        "index.html",
      );
      await fs.mkdir(path.dirname(pagePath), { recursive: true });
      await fs.writeFile(
        pagePath,
        renderArticle(document, publicRoutes, copiedAssets),
        "utf8",
      );
    }

    const notFoundPath = path.join(temporaryOutput, "404.html");
    await fs.writeFile(notFoundPath, `${renderPageHead(
      "পৃষ্ঠা পাওয়া যায়নি — Echoes of a Wanderer",
      "এই ঠিকানায় কোনো প্রকাশিত পৃষ্ঠা পাওয়া যায়নি।",
    )}
<body class="writing-body">
  <main class="writing-shell">
    <section class="writing-article">
      <p class="writing-eyebrow">404</p>
      <h1>পৃষ্ঠা পাওয়া যায়নি</h1>
      <p>এই ঠিকানায় কোনো প্রকাশিত লেখা নেই।</p>
      <p><a href="/">মূল পৃষ্ঠায় ফিরুন</a> · <a href="/letters/">প্রকাশিত লেখা দেখুন</a></p>
    </section>
  </main>
</body>
</html>`, "utf8");

    await fs.rename(temporaryOutput, output);
    return { publishedCount: publicDocuments.length, outputDirectory: output };
  } catch (error) {
    await fs.rm(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

export async function listFilesRecursively(directory, baseDirectory = directory) {
  const files = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(absolutePath, baseDirectory));
    } else if (entry.isFile()) {
      files.push(toPosix(path.relative(baseDirectory, absolutePath)));
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

export function routeForDocument(relativePath) {
  return documentRoute(relativePath).url;
}

export function validateDocumentMetadata(metadata) {
  return validateMetadata(metadata);
}
