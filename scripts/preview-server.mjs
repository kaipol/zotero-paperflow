import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 3000);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function renderPage() {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const files = [
    "manifest.json",
    "bootstrap.js",
    "chrome.manifest",
    "prefpane.xhtml",
    "prefpane.js",
    "pane-icon.svg",
    "defaults/preferences/prefs.js",
    "content/challenge-window.xhtml",
    "content/challenge-window.js",
    "content/office-to-pdf.vbs",
    "content/modules/core.js",
    "content/modules/main.js",
    "content/modules/supporting-info.js",
    "content/modules/fulltext-translation.js",
    "content/modules/translation-client.js",
    "content/modules/pdf-export.js",
  ];
  const fileItems = files.map((file) => `<li><code>${escapeHTML(file)}</code></li>`).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHTML(manifest.name)} v${escapeHTML(manifest.version)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #f8fafc;
      color: #0f172a;
      line-height: 1.6;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0b1120; color: #e2e8f0; }
      .card { background: #111827; border-color: #1e293b; }
      code, pre { background: #1e293b; color: #e2e8f0; }
    }
    main { max-width: 820px; margin: 40px auto; padding: 0 20px; display: grid; gap: 20px; }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 20px 24px;
    }
    h1 { margin: 0 0 6px; font-size: 24px; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    p { margin: 0 0 8px; opacity: 0.88; }
    .meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; opacity: 0.78; }
    pre {
      margin: 8px 0 0;
      padding: 12px 14px;
      border-radius: 8px;
      background: #f1f5f9;
      overflow-x: auto;
      font-size: 13px;
    }
    code {
      padding: 2px 5px;
      border-radius: 4px;
      background: #f1f5f9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12.5px;
    }
    pre code { padding: 0; background: transparent; }
    ul { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 4px; }
    .file-list { columns: 2; column-gap: 24px; list-style: none; padding: 0; }
    @media (max-width: 640px) { .file-list { columns: 1; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>${escapeHTML(manifest.name)}</h1>
      <p>${escapeHTML(manifest.description)}</p>
      <div class="meta">
        <span>版本：<strong>${escapeHTML(manifest.version)}</strong></span>
        <span>插件 ID：<code>${escapeHTML(manifest.applications?.zotero?.id)}</code></span>
        <span>兼容 Zotero：${escapeHTML(manifest.applications?.zotero?.strict_min_version)} – ${escapeHTML(manifest.applications?.zotero?.strict_max_version)}</span>
      </div>
    </section>

    <section class="card">
      <h2>说明</h2>
      <p>本项目是面向 Zotero 10 桌面端的 bootstrap XPI 插件，不在浏览器中直接运行。此预览页仅用于展示当前插件元信息与构建打包命令。</p>
      <pre><code>node test/static-smoke.mjs
node test/behavior-smoke.mjs
node scripts/build-xpi.mjs</code></pre>
    </section>

    <section class="card">
      <h2>XPI 打包源文件清单（${files.length} 个）</h2>
      <ul class="file-list">${fileItems}</ul>
    </section>
  </main>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (urlPath === "/pane-icon.svg") {
    res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    res.end(readFileSync(join(root, "pane-icon.svg")));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Zotero PaperFlow preview server listening on http://0.0.0.0:${port}`);
});
