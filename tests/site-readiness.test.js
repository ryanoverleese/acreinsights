const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const PUBLIC_PAGES = [
  {
    file: "index.html",
    canonical: "https://acreinsights.com/",
    ogImage: "https://acreinsights.com/og.jpg",
  },
  {
    file: "soiltemps.html",
    canonical: "https://acreinsights.com/soiltemps",
    ogImage: "https://acreinsights.com/og-soiltemps.jpg",
  },
  {
    file: "updates.html",
    canonical: "https://acreinsights.com/updates",
    ogImage: "https://acreinsights.com/og.jpg",
  },
  {
    file: "probes-dont-show-first-rains.html",
    canonical: "https://acreinsights.com/probes-dont-show-first-rains",
    ogImage: "https://acreinsights.com/og.jpg",
  },
];

const SITEMAP_URLS = PUBLIC_PAGES.map((page) => page.canonical);

function attr(html, tagPattern) {
  const match = html.match(tagPattern);
  return match ? match[1] : null;
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("JPEG size not found");
}

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("public pages have their own title, description, canonical, and Open Graph image", () => {
  for (const page of PUBLIC_PAGES) {
    const html = read(page.file);
    const title = attr(html, /<title>([^<]+)<\/title>/);
    const description = attr(html, /<meta name="description" content="([^"]+)"/);
    const canonical = attr(html, /<link rel="canonical" href="([^"]+)"/);
    const ogImage = attr(html, /<meta property="og:image" content="([^"]+)"/);
    const ogUrl = attr(html, /<meta property="og:url" content="([^"]+)"/);
    assert.ok(title && title.includes("Acre Insights"), `${page.file} title`);
    assert.ok(description && description.length > 40, `${page.file} description`);
    assert.equal(canonical, page.canonical, `${page.file} canonical`);
    assert.equal(ogUrl, page.canonical, `${page.file} og:url`);
    assert.equal(ogImage, page.ogImage, `${page.file} og:image`);
    assert.match(html, /rel="icon" href="\/favicon\.ico"/);
    assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    assert.doesNotMatch(html, /acreinsights\.netlify\.app/);
  }
});

test("homepage views update the title and description without a second canonical", () => {
  const html = read("index.html");
  for (const name of ["home", "services", "funding", "about", "contact", "apps"]) {
    assert.match(html, new RegExp(`${name}:\\s*\\{`));
  }
  assert.equal(html.match(/rel="canonical"/g).length, 1);
  assert.match(html, /applyPageMeta\(name\)/);
  assert.match(html, /Get started/);
});

test("every image on a public page has an alt attribute", () => {
  const files = [...PUBLIC_PAGES.map((page) => page.file), "404.html"];
  for (const file of files) {
    const html = read(file);
    const images = html.match(/<img\b[^>]*>/g) || [];
    assert.ok(images.length > 0 || file === "updates.html" || file === "probes-dont-show-first-rains.html", file);
    for (const img of images) {
      assert.match(img, /\balt="/, `${file} image missing alt: ${img}`);
    }
  }
  const note = read("probes-dont-show-first-rains.html");
  assert.match(note, /role="img"/);
  assert.match(note, /<title id="profileTitle">/);
});

test("real async pages keep a loading state and static pages do not gain a spinner", () => {
  assert.match(read("soiltemps.html"), /class="loading">Loading\.\.\./);
  assert.match(read("updates.html"), /Loading notes/);
  assert.doesNotMatch(read("index.html"), /class="loading"/);
  assert.doesNotMatch(read("404.html"), /class="loading"/);
});

test("sitemap lists only the public canonical URLs", () => {
  const xml = read("sitemap.xml");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locs, SITEMAP_URLS);
  const banned = ["netlify.app", ".html", "/capture", "/wire", "/workweek", "/api/", "kasen", "storm-rain", "soiltemps-history", "#", "404"];
  for (const term of banned) assert.equal(xml.includes(term), false, term);
});

test("robots.txt points at the sitemap and keeps private tools out of crawl", () => {
  const robots = read("robots.txt");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Sitemap: https:\/\/acreinsights\.com\/sitemap\.xml$/m);
  for (const path of ["/capture", "/wire", "/workweek", "/api/", "/todos-a7k2x9", "/kasen-", "/404"]) {
    assert.match(robots, new RegExp(`^Disallow: ${path}$`, "m"));
  }
  assert.doesNotMatch(robots, /Disallow: \/$/);
  assert.doesNotMatch(robots, /Disallow: \/soiltemps$/);
  assert.doesNotMatch(robots, /Disallow: \/updates/);
});

test("there is no catch-all rewrite that would turn a missing page into a 200", () => {
  const redirects = read("_redirects");
  assert.doesNotMatch(redirects, /\/\*\s+\/index\.html\s+200/);
  assert.doesNotMatch(redirects, /\/\*\s+\/404\.html\s+200/);
  assert.match(read("404.html"), /<title>Page not found — Acre Insights<\/title>/);
  assert.match(read("404.html"), /name="robots" content="noindex"/);
  assert.match(read("404.html"), /src="\/LOGO\.jpg" alt="Acre Insights"/);
});

test("favicon and Open Graph files are real images at the sizes the tags declare", () => {
  const ico = fs.readFileSync(path.join(root, "favicon.ico"));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 16);
  assert.equal(ico[22], 32);

  const favicon = pngSize(fs.readFileSync(path.join(root, "favicon-32.png")));
  assert.deepEqual(favicon, { width: 32, height: 32 });
  const touch = pngSize(fs.readFileSync(path.join(root, "apple-touch-icon.png")));
  assert.deepEqual(touch, { width: 180, height: 180 });

  for (const file of ["og.jpg", "og-soiltemps.jpg"]) {
    const buf = fs.readFileSync(path.join(root, file));
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    assert.deepEqual(jpegSize(buf), { width: 1200, height: 630 });
    assert.ok(buf.length < 200000, `${file} is small enough for a share card`);
  }
});

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=UTF-8";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".xml") || file.endsWith(".txt")) return "text/plain; charset=UTF-8";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/") && pathname !== "/") pathname = pathname.slice(0, -1);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const candidates = [relative];
    if (!path.extname(relative)) candidates.push(`${relative}.html`);
    let file = null;
    for (const candidate of candidates) {
      const full = path.join(root, candidate);
      if (full.startsWith(root + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        file = full;
        break;
      }
    }
    if (!file) {
      const missing = path.join(root, "404.html");
      res.writeHead(404, { "Content-Type": "text/html; charset=UTF-8" });
      res.end(fs.readFileSync(missing));
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(file) });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function fetchPath(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

test("a missing path returns the custom page with status 404, and public files return 200", async () => {
  const server = await startStaticServer();
  const { port } = server.address();
  try {
    const missing = await fetchPath(port, "/this-page-should-404-readiness");
    assert.equal(missing.status, 404);
    assert.match(missing.body.toString("utf8"), /Page not found — Acre Insights/);
    assert.doesNotMatch(missing.headers.location || "", /./);

    const nested = await fetchPath(port, "/notes/missing-field");
    assert.equal(nested.status, 404);
    assert.match(nested.body.toString("utf8"), /src="\/LOGO\.jpg"/);

    for (const pathname of ["/", "/soiltemps", "/updates", "/probes-dont-show-first-rains", "/robots.txt", "/sitemap.xml", "/favicon.ico", "/og.jpg"]) {
      const response = await fetchPath(port, pathname);
      assert.equal(response.status, 200, pathname);
    }
    const icon = await fetchPath(port, "/favicon.ico");
    assert.equal(icon.headers["content-type"], "image/x-icon");
    assert.equal(icon.body.readUInt16LE(2), 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
