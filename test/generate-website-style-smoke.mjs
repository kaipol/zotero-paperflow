import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exportModule = readFileSync(join(root, "content/modules/pdf-export.js"), "utf8");
const scope = vm.createContext({});
vm.runInContext(exportModule, scope);
const html = scope.AutoFullTextPdf.makeWebsitePdfPage(
  `<main class="publisher-page"><article class="article-body"><h1 class="article-title">Website-style PDF smoke test</h1><p class="lead">A publisher-style heading, paragraph, equation, image and link should retain the page CSS.</p><h2 class="section-title">Equation</h2><p class="article-text"><math display="inline"><mrow><mi>η</mi><mo>=</mo><mfrac><mi>P</mi><mi>A</mi></mfrac></mrow></math></p><figure><img alt="Chart" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='500' height='160'%3E%3Crect width='500' height='160' fill='%23f1f5f8'/%3E%3Cpath d='M40 125H470M40 125V20' stroke='%23203b57' stroke-width='2'/%3E%3Crect x='100' y='65' width='80' height='60' fill='%233c8d8a'/%3E%3C/svg%3E"><figcaption>Figure 1. Embedded image.</figcaption></figure><p class="article-text">The link remains <a href="https://www.zotero.org/">clickable</a>.</p></article></main>`,
  "https://publisher.example/article/1",
  "Website-style smoke test",
  [{
    media: "all",
    text: "body{margin:0;background:#f4f6f8;font-family:Georgia,serif;color:#25364a}.publisher-page{max-width:760px;margin:32px auto;padding:28px 42px;background:white}.article-title{font:700 27px/1.3 Arial,sans-serif;color:#203b57;border-bottom:3px solid #3c8d8a;padding-bottom:12px}.lead{font-size:15px;color:#596b7b}.section-title{font:600 19px Arial,sans-serif;color:#203b57}.article-text{font-size:14px;line-height:1.8}figure{margin:22px 0;text-align:center}img{max-width:100%;height:auto}figcaption{font-size:12px;color:#667}a{color:#176b8f}"
  }],
  { class: "publisher-theme", lang: "en" },
);
writeFileSync(join(root, "test/site-style-smoke.html"), html);
console.log("Generated test/site-style-smoke.html using makeWebsitePdfPage().");
