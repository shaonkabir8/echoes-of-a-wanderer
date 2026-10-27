# Markdown publishing

The existing `index.html` remains the landing-page source. The build copies it
to `dist/index.html`, adds a link to the public-writing index, and generates
static pages without replacing the landing page.

## Content scope and privacy

- Publishing content is `letters/**/*.md`, excluding any `README.md`.
- Repository documentation, `activities/`, and Markdown under `assets/` are not
  part of the writing feed.
- A writing needs a YAML frontmatter mapping with a non-empty `title`,
  `category`, and an explicit `visibility`.
- `visibility` accepts `public` or `private`, case-insensitively. Missing,
  malformed, non-string, or other values fail validation.
- Only valid documents explicitly marked `public` are rendered. The build
  independently excludes private, missing, and invalid visibility even when
  validation is run separately.
- Source Markdown is never copied into `dist/`. The public text appears only in
  its generated HTML page. The landing page, listing, routes, and copied assets
  are also checked by the output audit.

Run the full local verification with:

```sh
npm ci
npm run verify
```

The GitHub Actions status check is the `content-checks` job in **Cloudflare Worker CI**. It runs on pull requests targeting `main` and on pushes to `main`.

## Cloudflare Worker deployment

The production target is the existing Cloudflare Worker `dairy`, served at
`https://dairy.shaonkabir98.workers.dev/`. `wrangler.toml` points Wrangler at
the generated `dist/` directory and keeps the existing `workers.dev` hostname
enabled. This publishing pipeline does not use GitHub Pages or create a Pages
project.

The workflow validates metadata, tests privacy behavior, builds once, audits
the complete public output, and runs a Wrangler dry run. It uploads that exact
audited artifact; only a push to `main` can deploy it to the Worker, and the
deployment job depends on all content checks passing. Pull requests never
receive Cloudflare credentials and never deploy.

Before merging a change that should deploy, add these repository Actions
secrets in GitHub:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`, scoped to the Cloudflare account with Workers Scripts
  Write permission.

The deployment job does not silently skip when credentials are missing; a main
branch deployment attempt will fail until both secrets are configured. Never
put the token in source files or chat.
