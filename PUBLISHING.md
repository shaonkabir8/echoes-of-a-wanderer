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

The GitHub Actions status check is the `content-checks` job in **Cloudflare
Pages CI**. It runs on pull requests targeting `main` and on pushes to `main`.

## Cloudflare Pages deployment

Repository inspection found no existing Pages project name, Wrangler
configuration, or deployment workflow. The workflow therefore uses the
Cloudflare Pages Direct Upload command and requires the following repository
configuration before the deployment job can run:

- Actions variable `CLOUDFLARE_PAGES_PROJECT`: the existing Pages project name.
- Actions secret `CLOUDFLARE_ACCOUNT_ID`.
- Actions secret `CLOUDFLARE_API_TOKEN`, scoped to Cloudflare Pages edit access.

Only a push to `main` can deploy, and the deployment job depends on the passing
`content-checks` job. Pull-request workflows do not receive Cloudflare
credentials. If the project variable is absent, the deployment job is skipped;
if the variable is present but credentials are missing or invalid, deployment
fails. The Pages target must be a separate Pages project; this workflow does
not configure or deploy the existing `dairy.shaonkabir98.workers.dev` Worker.
