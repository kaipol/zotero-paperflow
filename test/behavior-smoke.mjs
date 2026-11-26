import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");
const providers = [
  {
    id: "openai-default",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKeyEnv: "TEST_OPENAI_KEY",
  },
  {
    id: "deepseek-test",
    name: "DeepSeek test",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    apiKeyEnv: "TEST_DEEPSEEK_KEY",
  },
];
const preferences = {
  translationEndpoint: "https://api.openai.com/v1/chat/completions",
  translationModel: "gpt-4o-mini",
  translationProviders: JSON.stringify(providers),
  activeTranslationProvider: "openai-default",
    translationSystemPrompt: "",
    autoDownloadSupportingInfo: false,
    autoTranslateFullText: false,
};

const environmentValues = {
  TEST_OPENAI_KEY: "test-openai-key",
  TEST_DEEPSEEK_KEY: "test-deepseek-key",
};
const environment = { get: (name) => environmentValues[name] || "" };
const components = {
  classes: {
    "@mozilla.org/process/environment;1": {
      getService: () => environment,
    },
  },
  interfaces: { nsIEnvironment: {} },
};
const context = {
  AutoFullText: { getPref: (key) => preferences[key] ?? "" },
  Components: components,
  URL,
  Date,
  Math,
  AbortController,
  Zotero: {
    Prefs: {
      get: (key) => preferences[String(key).split(".").pop()] ?? null,
      set: (key, value) => { preferences[String(key).split(".").pop()] = value; },
    },
    debug: () => {},
    Promise: { delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) },
    HTTP: { request: async () => ({ status: 200, response: { choices: [{ message: { content: "这是一段中文译文。" } }] } }) },
  },
  setTimeout,
};
vm.createContext(context);
vm.runInContext(read("content/modules/core.js"), context);
vm.runInContext(read("content/modules/translation-client.js"), context);
vm.runInContext(read("content/modules/fulltext-translation.js"), context);

const translation = context.AutoFullTextTranslation;
const client = context.AutoFullTextTranslator;
const core = context.AutoFullText;
assert.equal(core.getPref("autoDownloadSupportingInfo"), false);
assert.equal(core.getPref("autoTranslateFullText"), false);
assert.equal(core.getPref("activeTranslationProvider"), "openai-default");
assert.equal(core.validateArticleURL("http://publisher.com/article"), "http://publisher.com/article");
assert.equal(core.validateArticleURL("https://publisher.com/article"), "https://publisher.com/article");
assert.throws(() => core.validateArticleURL("ftp://publisher.com/article"), /HTTP or HTTPS/);
assert.throws(() => core.validateArticleURL("http://publisher.com:8080/article"), /standard port/);
assert.throws(() => core.validateArticleURL("http://user:secret@publisher.com/article"), /credentials/);
assert.throws(() => core.validateArticleURL("https://[::ffff:7f00:1]/private"), /public hostname/);
assert.throws(() => core.validateArticleURL("https://user:secret@publisher.com/article"), /credentials/);
assert.throws(() => core.validateArticleURL("https://publisher.com/article?X-Amz-Signature=secret"), /credentials/);
assert.equal(core.itemURL({ getField: (field) => field === "DOI" ? "https://doi.org/10.1000/xyz 123" : "" }), "https://doi.org/10.1000/xyz%20123");
const itemWithRepositoryURL = { getField: (field) => ({ url: "https://repository.example.com/article", DOI: "10.1039/d6ee05315g" })[field] };
assert.equal(core.itemURL(itemWithRepositoryURL, { preferDOI: true }), "https://doi.org/10.1039/d6ee05315g");
assert.equal(core.itemURL(itemWithRepositoryURL), "https://repository.example.com/article", "preserve URL preference for other actions");
assert.throws(() => core.validateResourceURL("https://10.1.2.3/private", "https://publisher.com/article"), /public hostname/);
assert.throws(() => core.validateResourceURL("https://evil.example/track.png", "https://publisher.com/article"), /public hostname|trusted publisher allowlist/);
assert.throws(() => core.validateResourceURL("https://publisher.com:8443/track.png", "https://publisher.com/article"), /public hostname/);
assert.equal(core.validateResourceURL("https://cdn.springernature.com/fig.png", "https://publisher.com/article"), "https://cdn.springernature.com/fig.png");
assert.equal(core.validateResourceURL("http://publisher.com/files/si.pdf", "https://publisher.com/article"), "http://publisher.com/files/si.pdf");
assert.throws(() => core.validateResourceURL("http://publisher.com:8080/si.pdf", "http://publisher.com/article"), /standard port/);
assert.equal(core.validateRedirectURL("http://pubs.rsc.org/EE/article-lookup/doi/10.1039/D6EE05315G", "https://doi.org/10.1039/d6ee05315g"), "http://pubs.rsc.org/EE/article-lookup/doi/10.1039/D6EE05315G");
assert.throws(() => core.validateRedirectURL("http://publisher.com/article", "https://publisher.com/article"), /HTTPS-to-HTTP/);

const coreRequests = [];
const originalCoreRequest = context.Zotero.HTTP.request;
context.Zotero.HTTP.request = async (_method, url, options) => {
  coreRequests.push({ url, options });
  if (url === "https://publisher.com/article") {
    return { status: 302, responseText: "", getResponseHeader: (name) => name === "Location" ? "https://cdn.springernature.com/article" : "" };
  }
  return { status: 200, responseText: "<html><body>ok</body></html>", getResponseHeader: () => "text/html" };
};
const observedResponses = [];
const textResult = await core.fetchTextResource("https://publisher.com/article", {
  onResponse: (response, url) => observedResponses.push([response.status, url]),
});
assert.deepEqual(observedResponses, [
  [302, "https://publisher.com/article"],
  [200, "https://cdn.springernature.com/article"],
]);
assert.equal(textResult.responseURL, "https://cdn.springernature.com/article");
assert.equal(coreRequests.length, 2, "trusted redirects should be followed manually, one hop at a time");
assert.ok(coreRequests.every(({ options }) => options.followRedirects === false && options.anon === true));

const doiRedirectRequests = [];
context.Zotero.HTTP.request = async (_method, url, options) => {
  doiRedirectRequests.push({ url, options });
  if (url === "https://doi.org/10.1039/d6ee05315g") {
    return { status: 302, responseText: "", getResponseHeader: (name) => name === "Location" ? "http://pubs.rsc.org/EE/article-lookup/doi/10.1039/D6EE05315G" : "" };
  }
  return { status: 200, responseText: "<html><body>RSC landing</body></html>", getResponseHeader: () => "text/html" };
};
const doiRedirectResult = await core.fetchTextResource("https://doi.org/10.1039/d6ee05315g");
assert.equal(doiRedirectResult.responseURL, "http://pubs.rsc.org/EE/article-lookup/doi/10.1039/D6EE05315G");
assert.deepEqual(doiRedirectRequests.map(({ url }) => url), [
  "https://doi.org/10.1039/d6ee05315g",
  "http://pubs.rsc.org/EE/article-lookup/doi/10.1039/D6EE05315G",
]);
assert.ok(doiRedirectRequests.every(({ options }) => options.followRedirects === false && options.anon === true));

let redirectRequests = 0;
context.Zotero.HTTP.request = async () => {
  redirectRequests += 1;
  return { status: 302, responseText: "", getResponseHeader: () => "https://127.0.0.1/private" };
};
await assert.rejects(core.fetchTextResource("https://publisher.com/article"), /public hostname/);
assert.equal(redirectRequests, 1, "private redirects must be blocked before a second request");

let cancelLargeResponse = false;
context.Zotero.HTTP.request = async (_method, _url, options) => {
  let progress;
  options.requestObserver({ addEventListener: (_type, callback) => { progress = callback; } });
  options.cancellerReceiver(() => { cancelLargeResponse = true; });
  progress({ loaded: 1024 });
  const error = new Error("cancelled");
  error.name = "CancelledException";
  throw error;
};
await assert.rejects(core.fetchTextResource("https://publisher.com/article", { maxBytes: 32 }), /configured 32-byte limit/);
assert.equal(cancelLargeResponse, true, "oversized text responses should cancel before parsing");
context.Zotero.HTTP.request = async () => {
  const error = new Error("unexpected transport cancellation");
  error.name = "CancelledException";
  throw error;
};
await assert.rejects(core.fetchTextResource("https://publisher.com/article"), (error) => error.name === "CancelledException");
context.Zotero.HTTP.request = originalCoreRequest;
let savedBeforeParsing = false;
context.DOMParser = class {
  parseFromString(source) {
    assert.equal(savedBeforeParsing, true, "persist the original page before DOM parsing");
    return { documentElement: {}, querySelector: () => null };
  }
};
context.Zotero.HTTP.request = async (_method, _url, options) => {
  assert.equal(options.noCache, true, "pass the fresh-page option through to Zotero HTTP");
  return {
    status: 200,
    responseText: "<html><body>raw original</body></html>",
    getResponseHeader: () => "text/html",
  };
};
const fetchedDocument = await core.fetchDocument("https://publisher.com/article", {
  noCache: true,
  onRawText: async (sourceText) => { savedBeforeParsing = sourceText.includes("raw original"); },
});
assert.equal(fetchedDocument.responseURL, "https://publisher.com/article");
context.Zotero.HTTP.request = originalCoreRequest;


const paper = {
  getField(field) {
    return {
      title: "A perovskite solar-cell study",
      abstractNote: "We investigate a new interface treatment.",
    }[field] || "";
  },
};

assert.equal(translation.normalizedHeading("1. References"), "References");
assert.equal(translation.isStopHeading("1. References"), true);
assert.throws(
  () => translation.assertChineseTranslation("研究了钙钛矿界面处理并改善了器件性能。", "The perovskite interface treatment improved device performance."),
  /not translated into Chinese/,
);
assert.throws(() => translation.assertChineseTranslation("これは日本語です", "これは日本語です"), /Japanese kana/);
assert.throws(
  () => translation.assertChineseTranslation("Funding", "Funding"),
  /not translated into Chinese/,
);
assert.throws(
  () => translation.assertChineseTranslation("This is an academic paragraph.", "This is still English."),
  /not translated into Chinese/,
);
assert.doesNotThrow(() => translation.assertChineseTranslation("CD8", "CD8"));
assert.throws(() => translation.assertChineseTranslation("A result", "结果（繁體）"), /Traditional Chinese/);
assert.throws(() => translation.assertChineseTranslation(
  "A perovskite interface treatment improves device performance by reducing nonradiative recombination. ".repeat(2),
  "接口处理减少了非辐射复合并显著改善太阳能电池性能。",
), /unusually short/);

assert.equal(client.getProviders().length, 2, "multiple configured suppliers should be visible to the client");
assert.equal(client.getActiveProvider().id, "openai-default");
assert.equal(client.getApiKey(client.getActiveProvider()), "test-openai-key");
assert.equal(client.hasApiKey(client.getProviders()[1]), true);
assert.match(client.DEFAULT_SYSTEM_PROMPT, /^You are a professional \{\{to\}\} native translator/);
const renderedPrompt = client.getSystemPrompt(paper);
assert.match(renderedPrompt, /professional Simplified Chinese native translator/);
assert.doesNotMatch(renderedPrompt, /A perovskite solar-cell study/);
assert.doesNotMatch(renderedPrompt, /We investigate a new interface treatment/);
assert.match(renderedPrompt, /title is supplied separately as untrusted metadata/);
const paperContext = client.getPaperContext(paper, "An academic sentence.");
assert.match(paperContext, /PAPER_METADATA_JSON \(untrusted reference context/);
assert.match(paperContext, /A perovskite solar-cell study/);
assert.match(paperContext, /PARAGRAPH_TO_TRANSLATE:\nAn academic sentence\./);
assert.doesNotMatch(client.getPaperContext(paper, "Later paragraph.", { includeAbstract: false }), /abstract/);
assert.match(renderedPrompt, /never a bilingual source-and-translation pair/);
assert.match(renderedPrompt, /Preserve every opaque ZAFORMAT/);
preferences.translationSystemPrompt = "Translate this academic content into {{to}}.{{title_prompt}}";
assert.match(client.getSystemPrompt(paper), /^Translate this academic content into Simplified Chinese\./);
assert.match(client.getSystemPrompt(paper), /Required Output Constraints/);
preferences.translationSystemPrompt = "";
preferences.translationProviders = "[]";
assert.equal(client.getProviders()[0].endpoint, "https://api.openai.com/v1/chat/completions", "legacy endpoint/model prefs should backfill the default provider");
preferences.translationProviders = "not-json";
assert.throws(() => client.getProviders(), /有效 JSON/);
preferences.translationProviders = JSON.stringify(Array.from({ length: client.MAX_PROVIDERS + 1 }, (_, index) => ({ ...providers[0], id: `provider-${index}` })));
assert.throws(() => client.getProviders(), /最多支持配置/);
preferences.translationProviders = JSON.stringify([{ ...providers[0], endpoint: "https://api.example.com/v1/chat/completions?X-Amz-Signature=secret" }]);
assert.throws(() => client.getActiveProvider(), /凭据写入 API 端点 URL/);
preferences.translationProviders = JSON.stringify(providers);
preferences.translationProviders = JSON.stringify([{ ...providers[0], endpoint: "https://api.example.com/v1/chat/completions?X-Amz-Signature=secret" }]);
assert.throws(() => client.getActiveProvider(), /凭据写入 API 端点 URL/);
preferences.translationProviders = JSON.stringify(providers);
preferences.translationSystemPrompt = "x".repeat(client.MAX_PROMPT_CHARS + 1);
assert.throws(() => client.getPromptTemplate(), /超过 20000 个字符限制/);
preferences.translationSystemPrompt = "";

const source = ("The first sentence ends here. 第二句到此结束。 More text follows. ").repeat(12);
const segments = translation.splitTranslationText(source, 64);
assert.ok(segments.length > 1, "long text should be split into multiple provider requests");
assert.equal(segments.map((part) => part.text + part.separator).join(""), source);
assert.ok(segments.every((part) => part.text.length <= 64), "normal segments must obey the requested size limit");

const protectedToken = "ZAFORMAT00001TOKEN";
const marked = `${"a".repeat(40)}${protectedToken}${"b".repeat(80)}`;
const markedSegments = translation.splitTranslationText(marked, 50);
assert.equal(markedSegments.map((part) => part.text + part.separator).join(""), marked);
assert.equal(markedSegments.filter((part) => part.text.includes(protectedToken)).length, 1);
assert.doesNotThrow(() => translation.validateSegmentMarkers(protectedToken, protectedToken));
assert.throws(() => translation.validateSegmentMarkers(protectedToken, "ZAFORMAT00002TOKEN"), /protection markers/);
const sanitizedCSS = translation.sanitizeCSS('@import url("https://tracker.invalid/x.css"); .x{background:url(https://tracker.invalid/pixel); color:red; -moz-binding:url(x); }');
assert.doesNotMatch(sanitizedCSS, /tracker\.invalid|@import|url\s*\(|-moz-binding/i);
assert.match(sanitizedCSS, /color:red/);

const surrogateText = `${"x".repeat(9)}😀${"y".repeat(60)}`;
const surrogateSegments = translation.splitTranslationText(surrogateText, 10);
assert.equal(surrogateSegments.map((part) => part.text + part.separator).join(""), surrogateText);
assert.ok(surrogateSegments.every((part) => !/[\uD800-\uDBFF]$/.test(part.text)));

let active = 0;
let peak = 0;
const ordered = await translation.mapConcurrentOrdered([0, 1, 2, 3], async (value) => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, (3 - value) * 5));
  active -= 1;
  return value * 10;
}, 2);
assert.equal(peak, 2, "translation jobs should never exceed two concurrent workers");
assert.equal(ordered.join(","), "0,10,20,30", "results should preserve source order despite completion order");

const dispatched = [];
let abortedInFlight = false;
await assert.rejects(
  translation.mapConcurrentOrdered([0, 1, 2, 3], async (value, _index, signal) => {
    dispatched.push(value);
    if (value === 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("engine failure");
    }
    if (value === 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => {
          abortedInFlight = true;
          clearTimeout(timer);
          reject(new Error("cancelled in-flight request"));
        }, { once: true });
      });
    }
    return value;
  }, 2),
  /engine failure/,
);
assert.equal(dispatched.length, 2, "an engine error must stop dispatching new paragraph requests");
assert.equal(abortedInFlight, true, "an engine error should cancel in-flight sibling requests");

const externalAbort = new AbortController();
let externalWorkerCancelled = false;
let externalDispatched = 0;
const externalWork = translation.mapConcurrentOrdered([0, 1, 2], async (_value, _index, signal) => {
  externalDispatched += 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 100);
    signal.addEventListener("abort", () => {
      externalWorkerCancelled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}, 2, externalAbort.signal);
setTimeout(() => externalAbort.abort(), 5);
await assert.rejects(externalWork, /cancelled/i);
assert.equal(externalDispatched, 2, "external cancellation must stop future segment dispatch");
assert.equal(externalWorkerCancelled, true, "external cancellation must abort in-flight requests");

let requestOptions;
context.Zotero.HTTP.request = async (method, endpoint, options) => {
  requestOptions = { method, endpoint, options };
  options.cancellerReceiver(() => {});
  return { status: 200, response: { choices: [{ message: { content: "这是一段中文译文。" } }] } };
};
const activeProvider = client.getActiveProvider();
assert.equal(await client.translate("An academic sentence.", activeProvider, paper), "这是一段中文译文。");
assert.equal(requestOptions.method, "POST");
assert.equal(requestOptions.endpoint, activeProvider.endpoint);
assert.equal(requestOptions.options.noRetryOnThrottle, true);
assert.equal(requestOptions.options.errorDelayMax, 0);
assert.equal(JSON.parse(requestOptions.options.body).model, "gpt-4o-mini");
assert.equal(requestOptions.options.headers.Authorization, "Bearer test-openai-key");
assert.match(JSON.parse(requestOptions.options.body).messages[0].content, /academic content/);
assert.match(JSON.parse(requestOptions.options.body).messages[1].content, /We investigate a new interface treatment/);
assert.equal(typeof requestOptions.options.cancellerReceiver, "function");

preferences.activeTranslationProvider = "deepseek-test";
const deepseekProvider = client.getActiveProvider();
assert.equal(deepseekProvider.endpoint, "https://api.deepseek.com/chat/completions");
context.Zotero.HTTP.request = async (_method, endpoint, options) => {
  requestOptions = { endpoint, options };
  options.cancellerReceiver(() => {});
  return { status: 200, response: { choices: [{ message: { content: "深度学习模型。" } }] } };
};
assert.equal(await client.translate("Deep learning models.", deepseekProvider, paper), "深度学习模型。");
assert.equal(requestOptions.endpoint, deepseekProvider.endpoint);
assert.equal(JSON.parse(requestOptions.options.body).model, "deepseek-chat");
assert.equal(requestOptions.options.headers.Authorization, "Bearer test-deepseek-key");
preferences.activeTranslationProvider = "openai-default";

let cancelInvoked = false;
context.Zotero.HTTP.request = (_method, _endpoint, options) => new Promise((_resolve, reject) => {
  options.cancellerReceiver(() => {
    cancelInvoked = true;
    const error = new Error("Cancelled");
    error.name = "CancelledException";
    reject(error);
  });
});
const abortController = new AbortController();
const cancellableRequest = client.translate("A long paragraph.", activeProvider, paper, abortController.signal);
abortController.abort();
await assert.rejects(cancellableRequest, /cancelled/);
assert.equal(cancelInvoked, true, "an engine failure should call Zotero HTTP's cancellation function");

let failedCalls = 0;
context.Zotero.HTTP.request = async (_method, _endpoint, options) => {
  failedCalls += 1;
  options.cancellerReceiver(() => {});
  const error = new Error("Too many requests");
  error.status = 429;
  throw error;
};
await assert.rejects(
  client.translate("Retry must not be attempted.", activeProvider, paper),
  (error) => {
    assert.equal(error.code, "rate-limit");
    assert.equal(error.status, 429);
    return true;
  },
);
assert.equal(failedCalls, 1, "provider errors should be reported immediately, without retries");
context.Zotero.HTTP.request = async () => {
  const error = new Error("unexpected transport cancellation");
  error.name = "CancelledException";
  throw error;
};
await assert.rejects(
  client.translate("Treat an unrequested cancellation as an engine failure.", activeProvider, paper),
  (error) => error.name === "TranslationEngineError" && error.code === "network",
);

const workspaceWrites = new Map();
const workspaceCreated = [];
const workspaceRemoved = [];
const pdfContext = {
  OS: {
    Path: { join: (base, name) => `${base}/${name}` },
    File: {
      makeDir: async (path) => { workspaceCreated.push(path); },
      removeDir: async (path) => { workspaceRemoved.push(path); },
    },
  },
  Zotero: {
    getTempDirectory: () => ({ path: "/local-zotero-temp" }),
    Utilities: { randomString: () => "workspace-test" },
    File: { putContentsAsync: async (path, content) => { workspaceWrites.set(path, String(content)); } },
  },
};
vm.createContext(pdfContext);
vm.runInContext(read("content/modules/pdf-export.js"), pdfContext);
const workspace = await pdfContext.AutoFullTextPdf.createWorkspace();
await workspace.writeText("article-page-original.html", "<html>source page</html>");
assert.equal(workspaceCreated.length, 1);
assert.equal(workspaceWrites.get(`${workspace.path}/article-page-original.html`), "<html>source page</html>");
await workspace.cleanup();
assert.deepEqual(workspaceRemoved, [workspace.path]);

const downloadedURLs = [];
const downloadedReferers = [];
const importedAttachments = [];
const siWorkspaceFiles = new Map();
const siPublisherURL = "http://pubs.rsc.org/EE/article-lookup/doi/10.1039/D6EE05315G";
let siWorkspaceCleaned = false;
let siWorkspacesCreated = 0;
let publisherResponseError;
let existingSI;
const siArticleSource = "<html><body>Article and SI links</body></html>";
let siArticleHTML = siArticleSource;
const siAnchor = (href, textContent) => ({
  textContent,
  title: "",
  getAttribute: (name) => name === "href" ? href : null,
});
const siAnchors = [
  siAnchor("#supplementary", "Supporting Information"),
  siAnchor(`${siPublisherURL}#supplementary`, "Supporting Information"),
  siAnchor("/files/download?id=1", "ESI"),
  siAnchor("/files/supporting-second.pdf", "Supplementary material"),
];
let rejectSIImport = false;
const siArticleRequests = [];
const supportContext = {
  AutoFullText: {
    itemURL: () => "https://doi.org/10.1039/d6ee05315g",
    safeName: (name) => name,
    log: () => {},
    validateArticleURL: core.validateArticleURL,
    validateResourceURL: core.validateResourceURL,
    validateRedirectURL: core.validateRedirectURL,
    fetchDocument: async (url, options) => {
      assert.equal(options.noCache, true, "each SI attempt requests a fresh article page");
      assert.equal(options.anon, false, "SI article fetches should reuse verified session cookies");
      siArticleRequests.push(url);
      if (publisherResponseError) {
        options.onResponse(publisherResponseError, siPublisherURL);
        throw publisherResponseError;
      }
      options.onResponse({ status: 200 }, siPublisherURL);
      await options.onRawText(siArticleHTML, siPublisherURL);
      return {
        responseURL: siPublisherURL,
        doc: {
          documentElement: { outerHTML: siArticleHTML },
          querySelectorAll: () => siAnchors,
        },
      };
    },
  },
  AutoFullTextPdf: {
    createWorkspace: async () => {
      siWorkspacesCreated += 1;
      return {
        path: "workspace/si-test",
        file: (name) => `workspace/${name}`,
        writeText: async (name, contents) => { siWorkspaceFiles.set(name, contents); },
        cleanup: async () => { siWorkspaceCleaned = true; },
      };
    },
    convertToPdf: async (path) => path,
  },
  Zotero: {
    HTTP: {
      request: async (_method, url, options) => {
        assert.ok(siWorkspaceFiles.has("si-source-article.html"), "save the article page before downloading the SI file");
        assert.equal(options.anon, false);
        assert.equal(options.followRedirects, false);
        downloadedURLs.push(url);
        downloadedReferers.push(options.headers.Referer);
        options.cancellerReceiver(() => {});
        options.requestObserver({ addEventListener: () => {} });
        return {
          status: 200,
          response: new TextEncoder().encode("%PDF-1.7"),
          responseURL: url,
          getResponseHeader: (name) => name === "Content-Type" ? "application/pdf" : name === "Content-Disposition" ? 'attachment; filename="supporting-first.pdf"' : "",
        };
      },
    },
    Utilities: { randomString: () => "test" },
    Items: { get: () => existingSI },
    Attachments: {
      importFromFile: async (attachment) => {
        if (rejectSIImport) return undefined;
        importedAttachments.push(attachment);
        return { id: importedAttachments.length };
      },
    },
    File: {
      pathToFile: (path) => ({ path, leafName: path.split("/").pop(), fileSize: siWorkspaceFiles.get(path)?.length || 0 }),
    },
  },
  URL,
  TextDecoder,
  OS: {
    File: { writeAtomic: async (path, bytes) => { siWorkspaceFiles.set(path, bytes); } },
  },
};
vm.createContext(supportContext);
vm.runInContext(read("content/modules/supporting-info.js"), supportContext);
await supportContext.AutoFullTextSupportingInfo.addForItem({ id: 1, getAttachments: () => [] });
assert.equal(downloadedURLs.length, 1, "SI flow should download only the first discovered file");
assert.equal(downloadedURLs[0], "http://pubs.rsc.org/files/download?id=1");
assert.equal(downloadedReferers[0], "http://pubs.rsc.org/", "SI downloads should use the final article page as their referrer");
assert.equal(importedAttachments[0].file.leafName, "si-test-supporting-first.pdf", "extensionless SI URLs should use the response filename");
assert.match(importedAttachments[0].title, /Supporting Information - supporting-first\.pdf \[/);
assert.equal(importedAttachments.length, 1, "SI flow should import one attachment per item");
assert.equal(siWorkspaceFiles.get("si-source-article.html"), "<html><body>Article and SI links</body></html>");
assert.equal(siWorkspaceFiles.get("si-source-article-parsed.html"), "<html><body>Article and SI links</body></html>");
assert.equal(siWorkspaceCleaned, true, "successful SI import should remove its intermediate workspace");
siWorkspaceCleaned = false;
supportContext.Zotero.HTTP.request = async () => { throw new Error("download failed"); };
await assert.rejects(
  supportContext.AutoFullTextSupportingInfo.addForItem({ id: 2, getAttachments: () => [] }),
  /中间文件已保留在：workspace\/si-test/,
);
assert.equal(siWorkspaceCleaned, false, "failed SI processing must preserve its workspace");
assert.match(siWorkspaceFiles.get("si-error.txt"), /^阶段：下载第一份 SI 文件\ndownload failed/);
supportContext.Zotero.HTTP.request = async () => {
  const error = new Error("unexpected transport cancellation");
  error.name = "CancelledException";
  throw error;
};
await assert.rejects(
  supportContext.AutoFullTextSupportingInfo.addForItem({ id: 4, getAttachments: () => [] }),
  (error) => error.name === "CancelledException" && /中间文件已保留在：workspace\/si-test/.test(error.message),
);
assert.equal(siWorkspaceCleaned, false, "an unrequested HTTP cancellation must be reported as a failure");
assert.match(siWorkspaceFiles.get("si-error.txt"), /^阶段：下载第一份 SI 文件\nunexpected transport cancellation/);
let oversizedDownloadCancelled = false;
supportContext.Zotero.HTTP.request = async (_method, _url, options) => {
  options.requestObserver({
    addEventListener: (type, callback) => {
      if (type === "readystatechange") callback();
      if (type === "progress") callback({ loaded: 101 * 1024 * 1024, total: 101 * 1024 * 1024 });
    },
    readyState: 2,
    getResponseHeader: () => "106954752",
  });
  options.cancellerReceiver(() => { oversizedDownloadCancelled = true; });
  const error = new Error("cancelled oversized response");
  error.name = "CancelledException";
  throw error;
};
await assert.rejects(
  supportContext.AutoFullTextSupportingInfo.addForItem({ id: 3, getAttachments: () => [] }),
  /100 MB/,
);
assert.equal(oversizedDownloadCancelled, true, "an oversized SI response should be cancelled while streaming");
assert.equal(siWorkspaceCleaned, false, "oversized SI downloads retain their failure workspace");
siWorkspaceFiles.clear();
siWorkspaceCleaned = false;
const alreadyAborted = new AbortController();
alreadyAborted.abort();
const workspacesBeforeAbort = siWorkspacesCreated;
await assert.rejects(
  supportContext.AutoFullTextSupportingInfo.addForItem({ id: 5, getAttachments: () => [] }, alreadyAborted.signal),
  (error) => error.name === "AbortError",
);
assert.equal(siWorkspacesCreated, workspacesBeforeAbort, "cancellation before work should not create a workspace");
assert.equal(siWorkspaceFiles.has("si-error.txt"), false);
const abortInFlight = new AbortController();
supportContext.Zotero.HTTP.request = async () => {
  abortInFlight.abort();
  throw Object.assign(new Error("request cancelled"), { name: "CancelledException" });
};
await assert.rejects(
  supportContext.AutoFullTextSupportingInfo.addForItem({ id: 5, getAttachments: () => [] }, abortInFlight.signal),
  (error) => error.name === "AbortError" && /中间文件已保留/.test(error.message),
);
assert.equal(siWorkspaceCleaned, false, "cancellation during work should retain intermediates");
assert.match(siWorkspaceFiles.get("si-error.txt"), /cancelled/);

const siItem = { id: 12, libraryID: 1, getAttachments: () => [1] };
const downloadFirstSI = async (_method, url, options) => {
  assert.equal(options.anon, false, "SI downloads should reuse verified session cookies");
  assert.equal(options.noCache, true, "a new attempt must fetch the SI file without the local HTTP cache");
  downloadedURLs.push(url);
  return {
    status: 200,
    response: new TextEncoder().encode("%PDF-1.7"),
    responseURL: url,
    getResponseHeader: (name) => name === "Content-Type" ? "application/pdf" : "",
  };
};
const challengeResponse = {
  status: 403,
  getResponseHeader: (name) => name.toLowerCase() === "cf-mitigated" ? "challenge" : "",
};
const challengeError = Object.assign(new Error("HTTP request rejected"), { status: 403, xmlhttp: challengeResponse });
const isAccessError = (error) => error.name === "SupportingInfoAccessError" &&
  error.publisherURL === siPublisherURL && /中间文件已保留/.test(error.message);
supportContext.Zotero.HTTP.request = async () => { throw new Error("Should not download an SI before discovering a link"); };
publisherResponseError = challengeError;
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(siItem), isAccessError);
assert.match(siWorkspaceFiles.get("si-error.txt"), /安全验证.*403/);
publisherResponseError = null;
const challengeHTML = '<!DOCTYPE html><script>window._cf_chl_opt = {};</script><script src="/cdn-cgi/challenge-platform/example.js"></script>';
siArticleHTML = challengeHTML;
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(siItem), isAccessError);
assert.equal(siWorkspaceFiles.get("si-source-article.html"), challengeHTML);
siArticleHTML = siArticleSource;
supportContext.Zotero.HTTP.request = async () => { throw challengeError; };
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(siItem), isAccessError);
supportContext.Zotero.HTTP.request = async () => ({
  status: 200,
  response: new TextEncoder().encode(challengeHTML),
  getResponseHeader: (name) => name === "Content-Type" ? "text/html" : "",
});
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(siItem), isAccessError);
supportContext.Zotero.HTTP.request = async () => ({
  status: 200,
  response: new TextEncoder().encode("<!doctype html><title>Publisher error page</title>"),
  getResponseHeader: (name) => name === "Content-Type" ? "text/html" : "",
});
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(siItem), /returned an HTML page/);
assert.equal(importedAttachments.length, 1, "neither intercepted HTML nor a failed request may be imported");

existingSI = {
  getField: () => importedAttachments[0].title,
  isFileAttachment: () => true,
  attachmentContentType: "application/pdf",
  fileExists: async () => false,
};
supportContext.Zotero.HTTP.request = downloadFirstSI;
assert.equal((await supportContext.AutoFullTextSupportingInfo.addForItem(siItem)).skipped, false, "a stale attachment record must not block a download");
assert.equal(downloadedURLs.at(-1), "http://pubs.rsc.org/files/download?id=1");
assert.equal(importedAttachments.length, 2);
existingSI.fileExists = async () => true;
assert.equal((await supportContext.AutoFullTextSupportingInfo.addForItem(siItem)).skipped, true);
assert.equal(importedAttachments.length, 2, "an existing file must not be imported again");

const retrySIItem = { id: 13, getAttachments: () => [] };
const importsBeforeRetry = importedAttachments.length;
const workspacesBeforeRetry = siWorkspacesCreated;
const pagesBeforeRetry = siArticleRequests.length;
siWorkspaceCleaned = false;
publisherResponseError = Object.assign(new Error("连接至服务器时发生错误。请检查网络连接。"), {
  status: 0,
  responseStatus: null,
  channelStatus: 12345,
  url: `${siPublisherURL}?marker=not-for-logs`,
  xmlhttp: { getResponseHeader: () => { throw new Error("Response not available"); } },
});
await assert.rejects(
  supportContext.AutoFullTextSupportingInfo.addForItem(retrySIItem),
  (error) => error.name === "SupportingInfoConnectionError" && error.publisherURL === siPublisherURL &&
    /状态 0，不是 HTTP 状态码/.test(error.message),
);
let siDiagnostic = siWorkspaceFiles.get("si-error.txt");
assert.match(siDiagnostic, /^阶段：读取出版商文章页/);
assert.match(siDiagnostic, /最近请求来源：http:\/\/pubs\.rsc\.org\n请求状态：0\nHTTP 响应状态：未提供\nGecko 通道状态：12345/);
assert.doesNotMatch(siDiagnostic, /not-for-logs|article-lookup/);
assert.equal(siWorkspaceCleaned, false);

publisherResponseError.responseStatus = 403;
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(retrySIItem), isAccessError);
assert.match(siWorkspaceFiles.get("si-error.txt"), /请求状态：0\nHTTP 响应状态：403/);
assert.equal(importedAttachments.length, importsBeforeRetry);

publisherResponseError = null;
supportContext.Zotero.HTTP.request = downloadFirstSI;
const downloadsBeforeRetry = downloadedURLs.length;
rejectSIImport = true;
await assert.rejects(supportContext.AutoFullTextSupportingInfo.addForItem(retrySIItem), /没有返回已导入的 SI 附件/);
assert.match(siWorkspaceFiles.get("si-error.txt"), /^阶段：导入 Zotero 子附件/);
assert.equal(siWorkspaceCleaned, false);
assert.equal(importedAttachments.length, importsBeforeRetry);

rejectSIImport = false;
assert.equal((await supportContext.AutoFullTextSupportingInfo.addForItem(retrySIItem)).skipped, false);
assert.equal(siWorkspacesCreated, workspacesBeforeRetry + 4);
assert.equal(siArticleRequests.length, pagesBeforeRetry + 4);
assert.deepEqual(downloadedURLs.slice(downloadsBeforeRetry), [
  "http://pubs.rsc.org/files/download?id=1",
  "http://pubs.rsc.org/files/download?id=1",
]);
assert.equal(importedAttachments.length, importsBeforeRetry + 1);
assert.equal(importedAttachments.at(-1).parentItemID, retrySIItem.id);
assert.equal(siWorkspaceCleaned, true);

// --- Zotero Connector-style Challenge Window end-to-end VM tests ---
{
  const prefStore = new Map([
    ["network.cookie.cookieBehavior", { type: "int", value: 4, userSet: true }],
    ["privacy.partition.network_state", { type: "bool", value: true, userSet: false }],
    ["privacy.firstparty.isolate", { type: "bool", value: false, userSet: false }],
    ["privacy.trackingprotection.enabled", { type: "bool", value: true, userSet: true }],
    ["privacy.trackingprotection.pbmode.enabled", { type: "bool", value: true, userSet: false }],
    ["privacy.trackingprotection.socialtracking.enabled", { type: "bool", value: true, userSet: false }],
    ["privacy.trackingprotection.fingerprinting.enabled", { type: "bool", value: true, userSet: false }],
    ["privacy.trackingprotection.cryptomining.enabled", { type: "bool", value: true, userSet: false }],
    ["privacy.annotate_channels.strict_list.enabled", { type: "bool", value: true, userSet: false }],
    ["network.http.referer.XOriginPolicy", { type: "int", value: 2, userSet: true }],
    ["network.http.sendRefererHeader", { type: "int", value: 1, userSet: false }],
    ["dom.storage.enabled", { type: "bool", value: true, userSet: false }],
    ["javascript.enabled", { type: "bool", value: true, userSet: false }],
  ]);
  const clearedPrefs = [];
  const grantedCookieOrigins = [];
  const activeObservers = new Map();
  const mockServices = {
    prefs: {
      prefHasUserValue: (name) => Boolean(prefStore.get(name)?.userSet),
      getIntPref: (name, fallback) => prefStore.has(name) ? prefStore.get(name).value : fallback,
      getBoolPref: (name, fallback) => prefStore.has(name) ? prefStore.get(name).value : fallback,
      setIntPref: (name, value) => prefStore.set(name, { type: "int", value, userSet: true }),
      setBoolPref: (name, value) => prefStore.set(name, { type: "bool", value, userSet: true }),
      clearUserPref: (name) => {
        clearedPrefs.push(name);
        if (name === "privacy.partition.network_state") prefStore.set(name, { type: "bool", value: true, userSet: false });
        if (name === "privacy.trackingprotection.pbmode.enabled") prefStore.set(name, { type: "bool", value: true, userSet: false });
        if (name === "privacy.trackingprotection.socialtracking.enabled") prefStore.set(name, { type: "bool", value: true, userSet: false });
        if (name === "privacy.trackingprotection.fingerprinting.enabled") prefStore.set(name, { type: "bool", value: true, userSet: false });
        if (name === "privacy.trackingprotection.cryptomining.enabled") prefStore.set(name, { type: "bool", value: true, userSet: false });
        if (name === "privacy.annotate_channels.strict_list.enabled") prefStore.set(name, { type: "bool", value: true, userSet: false });
        if (name === "network.http.sendRefererHeader") prefStore.set(name, { type: "int", value: 1, userSet: false });
      },
    },
    perms: {
      ALLOW_ACTION: 1,
      EXPIRE_SESSION: 1,
      addFromPrincipal: (principal, type) => {
        if (type === "cookie") grantedCookieOrigins.push(principal.origin);
      },
    },
    scriptSecurityManager: {
      getSystemPrincipal: () => ({ isSystem: true }),
      createContentPrincipalFromOrigin: (origin) => ({ origin }),
    },
    obs: {
      addObserver: (obs, topic) => {
        if (!activeObservers.has(topic)) activeObservers.set(topic, new Set());
        activeObservers.get(topic).add(obs);
      },
      removeObserver: (obs, topic) => { activeObservers.get(topic)?.delete(obs); },
    },
  };
  const observerCount = (topic) => activeObservers.get(topic)?.size || 0;

  const makeMockChallengeDialog = (scriptBehavior) => (chromeURL, _name, _features, wrappedArgs) => {
    assert.ok(chromeURL.startsWith("chrome://zotero-auto-fulltext/content/challenge-window.xhtml?sid="), `unexpected dialog URL: ${chromeURL}`);
    const listeners = new Map();
    const browserListeners = new Map();
    const buttonListeners = new Map();
    let progressListener = null;
    let windowClosed = false;
    const statusEl = { textContent: "" };
    const urlEl = { textContent: "" };
    const makeBtn = (id) => ({
      addEventListener: (type, fn) => buttonListeners.set(`${id}:${type}`, fn),
      click: () => buttonListeners.get(`${id}:click`)?.(),
    });
    const reloadBtn = makeBtn("reload");
    const extractBtn = makeBtn("extract");
    const cancelBtn = makeBtn("cancel");
    const browser = {
      browsingContext: { customUserAgent: "" },
      docShell: {
        allowJavascript: false,
        allowImages: false,
        allowSubframes: false,
        allowMetaRedirects: false,
        allowAuth: false,
        allowWindowControl: false,
        allowMedia: false,
        allowDNSPrefetch: false,
      },
      currentURI: { spec: "about:blank" },
      contentDocument: null,
      contentWindow: null,
      addEventListener: (type, fn) => {
        if (!browserListeners.has(type)) browserListeners.set(type, []);
        browserListeners.get(type).push(fn);
      },
      addProgressListener: (listener) => { progressListener = listener; },
      removeProgressListener: () => { progressListener = null; },
      fixupAndLoadURIString: (url) => {
        browser.currentURI = { spec: url };
        scriptBehavior.onNavigate({
          url,
          browser,
          statusEl,
          cancelBtn,
          extractBtn,
          progressListener: () => progressListener,
          fireLoad: () => (browserListeners.get("load") || []).forEach((fn) => fn()),
          fireLocation: (newURL) => {
            browser.currentURI = { spec: newURL };
            progressListener?.onLocationChange(null, null, { spec: newURL });
          },
          isClosed: () => windowClosed,
        });
      },
      setAttribute: () => {},
    };
    const dialogWindow = {
      location: { href: chromeURL },
      arguments: [wrappedArgs],
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      close: () => {
        if (windowClosed) return;
        windowClosed = true;
        (listeners.get("unload") || []).forEach((fn) => fn());
      },
      focus: () => {},
    };
    const dialogContext = {
      window: dialogWindow,
      document: {
        readyState: "complete",
        getElementById: (id) => ({
          "si-challenge-status": statusEl,
          "si-challenge-url": urlEl,
          "si-challenge-reload": reloadBtn,
          "si-challenge-extract": extractBtn,
          "si-challenge-cancel": cancelBtn,
          "si-challenge-browser": browser,
        })[id] || null,
      },
      Services: mockServices,
      Components: { interfaces: { nsIWebProgressListener: { STATE_STOP: 0x10 }, nsIHttpChannel: null } },
      URL,
      Uint8Array,
      AbortController,
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      Date,
    };
    vm.createContext(dialogContext);
    vm.runInContext(read("content/challenge-window.js"), dialogContext);
    return dialogWindow;
  };

  // Verify clean Firefox UA helper and JSD non-false-positive
  const challengeImports = [];
  const challengeWorkspaceFiles = new Map();
  let challengeWorkspaceCleaned = false;
  let dialogScenario = null;
  let httpDownloadHandler = null;
  const challengeSupportContext = {
    AutoFullText: {
      itemURL: () => "https://pubs.rsc.org/en/content/articlelanding/2026/ee/d6ee05315g",
      safeName: (name) => name,
      log: () => {},
      validateArticleURL: core.validateArticleURL,
      validateResourceURL: core.validateResourceURL,
      validateRedirectURL: core.validateRedirectURL,
      isLocalHost: core.isLocalHost,
      isIPAddress: core.isIPAddress,
      fetchDocument: async (url, options) => {
        const err = Object.assign(new Error("HTTP 403"), {
          status: 403,
          xmlhttp: { getResponseHeader: (h) => h.toLowerCase() === "cf-mitigated" ? "challenge" : "" },
        });
        options.onResponse(err, url);
        throw err;
      },
    },
    AutoFullTextPdf: {
      createWorkspace: async () => {
        challengeWorkspaceCleaned = false;
        return {
          path: "workspace/cf-test",
          file: (name) => `workspace/${name}`,
          writeText: async (name, contents) => { challengeWorkspaceFiles.set(name, contents); },
          cleanup: async () => { challengeWorkspaceCleaned = true; },
        };
      },
      convertToPdf: async (path) => path,
    },
    Zotero: {
      getMainWindow: () => ({
        navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Zotero/10.0.8" },
        openDialog: (...args) => makeMockChallengeDialog(dialogScenario)(...args),
      }),
      HTTP: {
        request: async (method, url, options) => httpDownloadHandler(method, url, options),
      },
      Utilities: { randomString: () => "cf1" },
      Items: { get: () => null },
      Attachments: {
        importFromFile: async (att) => {
          challengeImports.push(att);
          return { id: challengeImports.length };
        },
      },
      File: {
        pathToFile: (path) => ({ path, leafName: path.split("/").pop(), fileSize: challengeWorkspaceFiles.get(path)?.length || 0 }),
      },
    },
    URL,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Map,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    OS: {
      File: { writeAtomic: async (path, bytes) => { challengeWorkspaceFiles.set(path, bytes); } },
    },
  };
  vm.createContext(challengeSupportContext);
  vm.runInContext(read("content/modules/supporting-info.js"), challengeSupportContext);
  const siMod = challengeSupportContext.AutoFullTextSupportingInfo;

  assert.equal(
    siMod.getBrowserUserAgent(),
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    "challenge window and SI HTTP should strip Zotero token and present a consistent Firefox UA",
  );
  // Verified article page with passive Cloudflare JSD script must NOT be mistaken for a challenge page
  assert.equal(
    siMod.isChallengeDocument({
      title: "High-Efficiency Perovskite Solar Cells",
      documentElement: { outerHTML: '<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><a href="/suppdata/d6ee05315g1.pdf">Supplementary Information</a></body></html>' },
      querySelector: () => null,
    }, "https://pubs.rsc.org/en/content/articlelanding/2026/ee/d6ee05315g"),
    false,
    "passive Cloudflare JSD script on an article page must not trigger infinite challenge loop",
  );
  // Active Turnstile challenge page MUST be detected
  assert.equal(
    siMod.isChallengeDocument({
      title: "Just a moment...",
      documentElement: { outerHTML: '<html><body><div id="challenge-running"></div></body></html>' },
      querySelector: (sel) => sel.includes("#challenge-running") ? {} : null,
    }, "https://pubs.rsc.org/en/content/articlelanding/2026/ee/d6ee05315g"),
    true,
  );

  // Scenario A: 403 -> Challenge window opens -> Turnstile clears -> in-window fetch downloads PDF -> prefs restored -> imported
  let inWindowFetchCalled = 0;
  let observedDialogUA = "";
  let observedChannelUA = "";
  dialogScenario = {
    onNavigate({ browser, fireLoad, fireLocation }) {
      observedDialogUA = browser.browsingContext.customUserAgent;
      assert.equal(prefStore.get("network.cookie.cookieBehavior").value, 0, "challenge window should allow cookies while open");
      assert.equal(prefStore.get("privacy.partition.network_state").value, false, "challenge window should disable network state partitioning while open");
      assert.equal(prefStore.get("privacy.trackingprotection.enabled").value, false, "challenge window should disable tracking protection while open");
      assert.ok(grantedCookieOrigins.includes("https://challenges.cloudflare.com"), "should grant session cookie perm for challenges.cloudflare.com");
      assert.ok(grantedCookieOrigins.includes("https://brunhild.challenges.cloudflare.com"), "should grant session cookie perm for brunhild.challenges.cloudflare.com");
      assert.equal(observerCount("http-on-modify-request"), 1, "should attach http-on-modify-request UA observer while open");
      assert.equal(observerCount("quit-application-granted"), 1, "should attach quit-application pref-restore observer while open");
      const mockChannel = {
        URI: { scheme: "https", host: "brunhild.challenges.cloudflare.com" },
        setRequestHeader: (name, value) => { if (name === "User-Agent") observedChannelUA = value; },
      };
      let localChannelCancelled = false;
      const localZoteroChannel = {
        URI: { scheme: "http", host: "127.0.0.1" },
        loadInfo: { browsingContext: browser.browsingContext },
        cancel: () => { localChannelCancelled = true; },
        setRequestHeader: () => {},
      };
      for (const obs of activeObservers.get("http-on-modify-request") || []) {
        obs.observe(mockChannel, "http-on-modify-request");
        obs.observe(localZoteroChannel, "http-on-modify-request");
      }
      assert.equal(localChannelCancelled, true, "challenge browser must block requests to loopback/local Zotero endpoints");
      // First load: Cloudflare Turnstile challenge page
      browser.contentDocument = {
        title: "Just a moment...",
        readyState: "complete",
        body: { children: [{}], textContent: "Checking your browser..." },
        documentElement: { outerHTML: '<html><body><iframe src="https://challenges.cloudflare.com/turnstile"></iframe></body></html>' },
        querySelector: (sel) => sel.includes("challenges.cloudflare.com") ? {} : null,
        querySelectorAll: () => [],
      };
      fireLoad();
      // After challenge passes (auto or manual), navigate to real article page
      setTimeout(() => {
        browser.contentDocument = {
          title: "Article Title - RSC",
          readyState: "complete",
          body: { children: [{}], textContent: "Full article content with supporting info link." },
          documentElement: { outerHTML: '<html><body><a href="/en/content/articlepdf/2026/ee/d6ee05315g-si.pdf">Electronic Supplementary Information</a></body></html>' },
          querySelector: () => null,
          querySelectorAll: () => [siAnchor("/en/content/articlepdf/2026/ee/d6ee05315g-si.pdf", "Electronic Supplementary Information")],
        };
        browser.contentWindow = {
          AbortController,
          fetch: async (url, init) => {
            inWindowFetchCalled += 1;
            assert.equal(init.credentials, "include", "in-window download must include verified session cookies");
            return {
              status: 200,
              url,
              headers: { get: (k) => k.toLowerCase() === "content-type" ? "application/pdf" : "" },
              arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7 verified-in-window").buffer,
            };
          },
        };
        fireLocation("https://pubs.rsc.org/en/content/articlelanding/2026/ee/d6ee05315g");
        fireLoad();
      }, 25);
    },
  };
  const scenarioAResult = await siMod.addForItem({ id: 201, getAttachments: () => [] });
  assert.equal(scenarioAResult.skipped, false);
  assert.equal(scenarioAResult.usedChallengeWindow, true);
  assert.equal(inWindowFetchCalled, 1);
  assert.equal(observedDialogUA, "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0");
  assert.equal(observedChannelUA, observedDialogUA, "brunhild.challenges.cloudflare.com requests must receive the consistent Firefox UA");
  assert.equal(challengeImports.length, 1);
  assert.equal(challengeImports[0].parentItemID, 201);
  assert.equal(challengeWorkspaceCleaned, true);
  // Verify ALL temporary Gecko prefs and observers were restored upon window close
  assert.equal(prefStore.get("network.cookie.cookieBehavior").value, 4, "cookieBehavior must be restored on close");
  assert.equal(prefStore.get("privacy.partition.network_state").value, true, "partition.network_state must be restored on close");
  assert.equal(prefStore.get("privacy.trackingprotection.enabled").value, true, "trackingprotection must be restored on close");
  assert.equal(prefStore.get("network.http.referer.XOriginPolicy").value, 2, "XOriginPolicy must be restored on close");
  assert.equal(observerCount("http-on-modify-request"), 0, "http-on-modify-request observer must be removed on close");
  assert.equal(observerCount("http-on-examine-response"), 0, "http-on-examine-response observer must be removed on close");
  assert.equal(observerCount("quit-application-granted"), 0, "quit-application observer must be removed on close");

  // Scenario B: In-window fetch hits CORS -> falls back to session-cookie HTTP download (anon: false + matched UA)
  let fallbackDownloadCalled = 0;
  httpDownloadHandler = async (_method, url, options) => {
    fallbackDownloadCalled += 1;
    assert.equal(options.anon, false, "fallback SI download must reuse session cookies");
    assert.equal(options.headers["User-Agent"], observedDialogUA, "fallback SI download must use the same Firefox UA");
    options.cancellerReceiver(() => {});
    options.requestObserver({ addEventListener: () => {} });
    return {
      status: 200,
      response: new TextEncoder().encode("%PDF-1.7 session-fallback"),
      responseURL: url,
      getResponseHeader: (name) => name === "Content-Type" ? "application/pdf" : "",
    };
  };
  dialogScenario = {
    onNavigate({ browser, fireLoad }) {
      browser.contentDocument = {
        title: "Article Title - RSC",
        readyState: "complete",
        body: { children: [{}], textContent: "Verified article body with cross-origin SI CDN link." },
        documentElement: { outerHTML: '<html><body><a href="https://static-content.springer.com/esm/si.pdf">Supplementary Information</a></body></html>' },
        querySelector: () => null,
        querySelectorAll: () => [siAnchor("https://static-content.springer.com/esm/si.pdf", "Supplementary Information")],
      };
      browser.contentWindow = {
        AbortController,
        fetch: async () => { throw new TypeError("NetworkError when attempting to fetch resource."); },
      };
      fireLoad();
    },
  };
  const scenarioBResult = await siMod.addForItem({ id: 202, getAttachments: () => [] });
  assert.equal(scenarioBResult.usedChallengeWindow, true);
  assert.equal(fallbackDownloadCalled, 1);
  assert.equal(challengeImports.length, 2);

  // Scenario C: Secondary Cloudflare challenge on SI host -> navigates same window -> retries download -> imports
  let navCount = 0;
  let secondaryAttempts = 0;
  httpDownloadHandler = async () => {
    secondaryAttempts += 1;
    throw Object.assign(new Error("HTTP 403"), {
      status: 403,
      xmlhttp: { getResponseHeader: (h) => h.toLowerCase() === "cf-mitigated" ? "challenge" : "" },
    });
  };
  dialogScenario = {
    onNavigate({ url, browser, fireLoad }) {
      navCount += 1;
      if (navCount === 1) {
        browser.contentDocument = {
          title: "Article Page",
          readyState: "complete",
          body: { children: [{}], textContent: "Verified article page." },
          documentElement: { outerHTML: '<html><body><a href="https://static-content.springer.com/esm/secondary-si.pdf">Supplementary Information</a></body></html>' },
          querySelector: () => null,
          querySelectorAll: () => [siAnchor("https://static-content.springer.com/esm/secondary-si.pdf", "Supplementary Information")],
        };
        browser.contentWindow = {
          AbortController,
          fetch: async () => {
            if (navCount < 2) throw new TypeError("CORS blocked before secondary challenge");
            return {
              status: 200,
              url: "https://static-content.springer.com/esm/secondary-si.pdf",
              headers: { get: (k) => k.toLowerCase() === "content-type" ? "application/pdf" : "" },
              arrayBuffer: async () => new TextEncoder().encode("%PDF-1.7 after-secondary").buffer,
            };
          },
        };
        fireLoad();
      } else {
        assert.equal(url, "https://static-content.springer.com/esm/secondary-si.pdf");
        browser.contentDocument = {
          title: "Secondary Host Verified",
          readyState: "complete",
          body: { children: [{}], textContent: "Secondary challenge cleared." },
          documentElement: { outerHTML: "<html><body>Verified</body></html>" },
          querySelector: () => null,
          querySelectorAll: () => [],
        };
        fireLoad();
      }
    },
  };
  const scenarioCResult = await siMod.addForItem({ id: 203, getAttachments: () => [] });
  assert.equal(scenarioCResult.usedChallengeWindow, true);
  assert.equal(navCount, 2, "secondary CF challenge should navigate the same window to the SI host");
  assert.equal(secondaryAttempts, 1);
  assert.equal(challengeImports.length, 3);

  // Scenario D: User clicks Cancel in the challenge window -> rejects with SupportingInfoChallengeCancelledError, restores prefs, cleans workspace
  dialogScenario = {
    onNavigate({ cancelBtn }) {
      setTimeout(() => cancelBtn.click(), 10);
    },
  };
  await assert.rejects(
    siMod.addForItem({ id: 204, getAttachments: () => [] }),
    (error) => error.name === "SupportingInfoChallengeCancelledError",
  );
  assert.equal(prefStore.get("network.cookie.cookieBehavior").value, 4, "prefs must be restored even on user cancel");
  assert.equal(observerCount("http-on-modify-request"), 0, "HTTP observer must be removed on user cancel");
  assert.equal(challengeWorkspaceCleaned, true, "cancelling challenge window must not leak orphaned temp directories");

  // Scenario E: Bare ACS/Wiley /doi/suppl/<doi> HTML landing link skipped in favor of real SI PDF; login page stays open until article loads
  const acsDoc = {
    querySelectorAll: () => [
      siAnchor("/doi/suppl/10.1021/jacs.12345", "Supporting Information"),
      siAnchor("/doi/suppl/10.1021/jacs.12345/suppl_file/ja_si_001.pdf", "ja_si_001.pdf"),
    ],
  };
  assert.equal(
    siMod.extractSupportingLink(acsDoc, "https://pubs.acs.org/doi/10.1021/jacs.12345")?.url,
    "https://pubs.acs.org/doi/suppl/10.1021/jacs.12345/suppl_file/ja_si_001.pdf",
    "bare /doi/suppl/<doi> HTML index links must be skipped when a real SI file link is present",
  );

  // Scenario F: Secondary host returns Content-Disposition: attachment -> http-on-examine-response cancels Save As & downloads via downloadBounded
  let secondarySaveAsCancelled = false;
  let secondaryHttpAttempts = 0;
  httpDownloadHandler = async (_method, url, options) => {
    secondaryHttpAttempts += 1;
    if (secondaryHttpAttempts === 1) {
      throw Object.assign(new Error("HTTP 403"), {
        status: 403,
        xmlhttp: { getResponseHeader: (h) => h.toLowerCase() === "cf-mitigated" ? "challenge" : "" },
      });
    }
    options.cancellerReceiver(() => {});
    options.requestObserver({ addEventListener: () => {} });
    return {
      status: 200,
      response: new TextEncoder().encode("%PDF-1.7 attachment-secondary"),
      responseURL: url,
      getResponseHeader: (name) => name === "Content-Type" ? "application/pdf" : 'attachment; filename="si-attachment.pdf"',
    };
  };
  let fNavCount = 0;
  dialogScenario = {
    onNavigate({ url, browser, fireLoad, isClosed }) {
      fNavCount += 1;
      if (fNavCount === 1) {
        // First show an institutional login page -> window must remain open!
        browser.contentDocument = {
          title: "Institutional Sign In",
          readyState: "complete",
          body: { children: [{}], textContent: "Please sign in with your institution." },
          documentElement: { outerHTML: '<html><body><input type="password"/></body></html>' },
          querySelector: (sel) => sel.includes('input[type="password"]') ? {} : null,
          querySelectorAll: () => [],
        };
        fireLoad();
        assert.equal(isClosed(), false, "login page must not auto-close the challenge window");
        setTimeout(() => {
          browser.contentDocument = {
            title: "Verified Article",
            readyState: "complete",
            body: { children: [{}], textContent: "Article with cross-origin SI." },
            documentElement: { outerHTML: '<html><body><a href="https://static-content.springer.com/esm/att-si.pdf">Supplementary Information</a></body></html>' },
            querySelector: () => null,
            querySelectorAll: () => [siAnchor("https://static-content.springer.com/esm/att-si.pdf", "Supplementary Information")],
          };
          browser.contentWindow = { AbortController, fetch: async () => { throw new Error("should not call fetchInWindow cross-origin"); } };
          fireLoad();
        }, 20);
      } else {
        assert.equal(url, "https://static-content.springer.com/esm/att-si.pdf");
        const attChannel = {
          URI: { spec: url, host: "static-content.springer.com" },
          responseStatus: 200,
          getResponseHeader: (h) => ({
            "content-disposition": 'attachment; filename="att-si.pdf"',
            "content-type": "application/pdf",
          })[h.toLowerCase()] || "",
          cancel: () => { secondarySaveAsCancelled = true; },
        };
        for (const obs of activeObservers.get("http-on-examine-response") || []) {
          obs.observe(attChannel, "http-on-examine-response");
        }
      }
    },
  };
  const scenarioFResult = await siMod.addForItem({ id: 205, getAttachments: () => [] });
  assert.equal(scenarioFResult.usedChallengeWindow, true);
  assert.equal(secondarySaveAsCancelled, true, "secondary attachment response should cancel browser Save As dialog and hand off to downloadBounded");
  assert.equal(secondaryHttpAttempts, 2);
  assert.equal(challengeImports.length, 4);

  // Scenario G: Broken/unloaded challenge dialog (never calls onWindowReady) -> watchdog aborts quickly instead of hanging forever
  let brokenDialogClosed = false;
  const origGetMainWindow = challengeSupportContext.Zotero.getMainWindow;
  challengeSupportContext.Zotero.getMainWindow = () => ({
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Zotero/10.0.8" },
    openDialog: () => ({ focus: () => {}, close: () => { brokenDialogClosed = true; } }),
  });
  const progressEvents = [];
  await assert.rejects(
    siMod.addForItem({ id: 206, getAttachments: () => [] }, null, {
      challengeInitTimeoutMs: 40,
      onProgress: (ev) => progressEvents.push(ev),
    }),
    (error) => error.name === "SupportingInfoAccessError" && /未能正常初始化/.test(error.message),
  );
  assert.equal(brokenDialogClosed, true, "broken challenge dialog must be closed by init watchdog");
  assert.ok(progressEvents.some((ev) => /正在读取出版商文章页/.test(ev.stage || "")), "must emit initial reading progress");
  assert.ok(progressEvents.some((ev) => /正在打开验证窗口/.test(ev.stage || "")), "must emit opening challenge progress");
  challengeSupportContext.Zotero.getMainWindow = origGetMainWindow;
}

let releaseDelay;
let notifierObserver;
let siStarted = 0;
let itemLookups = 0;
const lifecycleContext = {
  AutoFullText: {
    getPref: (key) => key === "autoDownloadSupportingInfo",
    regularItem: (item) => item.isRegularItem(),
    attachmentByTitle: () => false,
    log: () => {},
  },
  AutoFullTextPdf: { setRootURI: () => {} },
  AutoFullTextSupportingInfo: { addForItem: async () => { siStarted += 1; } },
  AutoFullTextTranslation: { create: async () => {} },
  Zotero: {
    initializationPromise: Promise.resolve(),
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    Promise: { delay: () => new Promise((resolve) => { releaseDelay = resolve; }) },
    Notifier: {
      registerObserver: (observer) => { notifierObserver = observer; return "notifier"; },
      unregisterObserver: () => {},
    },
    PreferencePanes: { register: async () => "pane", unregister: () => {} },
    MenuManager: { registerMenu: () => "menu", unregisterMenu: () => {} },
    Items: { get: () => { itemLookups += 1; return { isRegularItem: () => true, key: "ITEM" }; } },
    getMainWindow: () => ({ alert: () => {} }),
    logError: () => {},
    Utilities: { randomString: () => "test" },
  },
  Services: { obs: { addObserver: () => {}, removeObserver: () => {} } },
  AbortController,
  Set,
  Number,
  Promise,
};
vm.createContext(lifecycleContext);
vm.runInContext(read("content/modules/main.js"), lifecycleContext);
await lifecycleContext.AutoFullTextMain.startup({ id: "test", rootURI: "file:///test/" });
notifierObserver.notify("add", "item", [1]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(typeof releaseDelay, "function", "automatic item processing should reach the cancellable delay");
lifecycleContext.AutoFullTextMain.shutdown();
releaseDelay();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(itemLookups, 0, "shutdown during the initial delay must not continue to item or network work");
assert.equal(siStarted, 0, "shutdown must abort queued automatic SI work");

let manualMenu;
let manualNotifier;
let releaseManualSI;
let manualSIError;
let manualSICalls = 0;
let autoSIEnabled = false;
let autoTranslationEnabled = false;
let deferTranslation = false;
let releaseTranslation;
let acceptPublisherPage = false;
const siSignals = [];
const translatedItems = [];
const manualAlerts = [];
const connectionPrompts = [];
const viewerCalls = [];
const progressNotices = [];
const manualWindow = {
  alert: (message) => manualAlerts.push(message),
  confirm: (message) => { connectionPrompts.push(message); return acceptPublisherPage; },
};
const manualContext = {
  AutoFullText: {
    getPref: (key) => key === "autoDownloadSupportingInfo" ? autoSIEnabled : key === "autoTranslateFullText" && autoTranslationEnabled,
    regularItem: (item) => Boolean(item?.isRegularItem?.()),
    attachmentByTitle: () => false,
    validateArticleURL: core.validateArticleURL,
    log: () => {},
  },
  AutoFullTextPdf: { setRootURI: () => {} },
  AutoFullTextSupportingInfo: {
    addForItem: async (_item, signal) => {
      manualSICalls += 1;
      siSignals.push(signal);
      if (manualSIError) throw manualSIError;
      return new Promise((resolve) => { releaseManualSI = resolve; });
    },
  },
  AutoFullTextTranslation: {
    create: async (item) => {
      translatedItems.push(item.id);
      if (deferTranslation) await new Promise((resolve) => { releaseTranslation = resolve; });
    },
  },
  Zotero: {
    initializationPromise: Promise.resolve(),
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    Promise: { delay: async () => {} },
    Notifier: { registerObserver: (observer) => { manualNotifier = observer; return "notifier"; }, unregisterObserver: () => {} },
    PreferencePanes: { register: async () => "pane", unregister: () => {} },
    MenuManager: { registerMenu: (menu) => { manualMenu = menu; return "menu"; }, unregisterMenu: () => {} },
    Items: { get: (id) => ({ id, key: "ITEM", isRegularItem: () => true }) },
    getMainWindow: () => manualWindow,
    openInViewer: (...args) => { viewerCalls.push(args); },
    ProgressWindow: class {
      show() {}
      changeHeadline() {}
      addDescription(message) { progressNotices.push(message); }
      startCloseTimer() {}
    },
    logError: () => {},
    Utilities: { randomString: () => "test" },
  },
  Services: { obs: { addObserver: () => {}, removeObserver: () => {} } },
  AbortController,
  Set,
  Map,
  Number,
  Promise,
  setTimeout,
  clearTimeout,
};
vm.createContext(manualContext);
vm.runInContext(read("content/modules/main.js"), manualContext);
await manualContext.AutoFullTextMain.startup({ id: "test", rootURI: "file:///test/" });
const singleSelection = { items: [{ id: 71, isRegularItem: () => true }] };
const multipleSelection = { items: [...singleSelection.items, { id: 72, isRegularItem: () => true }] };
const flushManual = () => new Promise((resolve) => setTimeout(resolve, 0));
const menuLabels = Array.from(manualMenu.menus, (menu) => {
  const menuElem = {};
  menu.onShowing(null, { ...singleSelection, menuElem });
  assert.equal(menuElem.disabled, false);
  return menuElem.label;
});
assert.deepEqual(menuLabels, ["导入 SI", "生成全文翻译"]);
async function clickImport(selection = singleSelection) {
  manualMenu.menus[0].onCommand(null, selection);
  await flushManual();
}

await clickImport();
assert.equal(manualSICalls, 1, "the SI menu should start a publisher request without a source picker");
assert.equal(connectionPrompts.length, 0);
assert.equal(typeof releaseManualSI, "function");
await clickImport();
assert.match(manualAlerts.at(-1), /失败 0 项，跳过 0 项，已有 1 项正在处理中/);
assert.equal(manualSICalls, 1);
releaseManualSI({ skipped: false });
await flushManual();
assert.match(manualAlerts.at(-1), /完成 1 项/);

manualSIError = Object.assign(new Error("HTTP request was cancelled by the host"), { name: "CancelledException" });
await clickImport();
assert.match(manualAlerts.at(-1), /失败 1 项，跳过 0 项/);
assert.match(manualAlerts.at(-1), /HTTP request was cancelled by the host/);
assert.equal(connectionPrompts.length, 0, "an unrequested cancellation is not a verification block");

const blockedSIError = Object.assign(new Error("出版商要求在网页中完成安全验证（HTTP 403）。"), {
  name: "SupportingInfoAccessError", publisherURL: siPublisherURL,
});
manualSIError = blockedSIError;
const callsBeforeBlock = manualSICalls;
await clickImport();
await clickImport();
assert.equal(manualSICalls, callsBeforeBlock + 2, "each click after failure should start a new attempt");
assert.notEqual(siSignals.at(-1), siSignals.at(-2));
assert.equal(siSignals.at(-1).aborted, false);
assert.deepEqual(viewerCalls, [[siPublisherURL], [siPublisherURL]], "each blocked attempt should open or focus the viewer");
assert.equal(connectionPrompts.length, 0);
assert.match(progressNotices.at(-1), /再次点击「导入 SI」/);

const viewersBeforeBatch = viewerCalls.length;
await clickImport(multipleSelection);
assert.match(manualAlerts.at(-1), /失败 2 项[\s\S]*可单选失败的文献/);
assert.equal(viewerCalls.length, viewersBeforeBatch, "a manual batch must not open multiple windows");

const connectionError = Object.assign(new Error("Zotero 未能完成出版商请求（请求状态 0，不是 HTTP 状态码）。"), {
  name: "SupportingInfoConnectionError", publisherURL: siPublisherURL,
});
manualSIError = connectionError;
await clickImport();
assert.match(connectionPrompts.at(-1), /请求状态 0[\s\S]*是否打开出版商页面检查访问状态/);
assert.equal(viewerCalls.length, viewersBeforeBatch, "a transport failure should not automatically open a window");
acceptPublisherPage = true;
await clickImport();
assert.deepEqual(viewerCalls.at(-1), [siPublisherURL]);

const promptsBeforeAuto = connectionPrompts.length;
const viewersBeforeAuto = viewerCalls.length;
autoSIEnabled = true;
manualNotifier.notify("add", "item", [71]);
await flushManual();
assert.equal(connectionPrompts.length, promptsBeforeAuto, "an automatic connection failure must not block the library");
assert.equal(viewerCalls.length, viewersBeforeAuto);

manualSIError = blockedSIError;
autoTranslationEnabled = true;
deferTranslation = true;
manualNotifier.notify("add", "item", [71]);
await flushManual();
assert.equal(typeof releaseTranslation, "function", "automatic translation should start after the SI failure");
assert.equal(viewerCalls.length, viewersBeforeAuto + 1);
const callsBeforeTranslationOverlap = manualSICalls;
manualSIError = null;
await clickImport();
assert.equal(manualSICalls, callsBeforeTranslationOverlap + 1, "running translation must not block a new SI attempt");
releaseTranslation();
await flushManual();
await clickImport();
assert.equal(manualSICalls, callsBeforeTranslationOverlap + 1, "finishing the old translation must not release the new SI lock");
releaseManualSI({ skipped: false });
await flushManual();
assert.match(manualAlerts.at(-1), /完成 1 项/);
deferTranslation = false;

manualSIError = Object.assign(new Error("已取消安全验证，SI 尚未导入。"), {
  name: "SupportingInfoChallengeCancelledError",
  publisherURL: siPublisherURL,
});
const viewersBeforeCancel = viewerCalls.length;
const callsBeforeCancel = manualSICalls;
await clickImport();
assert.match(manualAlerts.at(-1), /补处理已取消/);
assert.equal(viewerCalls.length, viewersBeforeCancel, "cancelling the challenge window must not open another viewer window");
manualSIError = null;
await clickImport();
assert.equal(manualSICalls, callsBeforeCancel + 2, "cancelling the challenge window must release the SI lock immediately");
releaseManualSI({ skipped: false, usedChallengeWindow: true });
await flushManual();
assert.match(manualAlerts.at(-1), /完成 1 项/);

// Verify floating progress panel with Cancel button aborts an in-flight SI task and releases lock immediately
{
  const panelNodes = new Map();
  const makeNode = (tag) => {
    const node = {
      tagName: tag,
      _id: "",
      get id() { return this._id; },
      set id(v) { this._id = v; if (v) panelNodes.set(v, this); },
      textContent: "",
      disabled: false,
      style: { cssText: "", display: "", width: "", background: "" },
      children: [],
      listeners: new Map(),
      appendChild(child) { this.children.push(child); return child; },
      append(...items) { this.children.push(...items); },
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      click() { this.listeners.get("click")?.(); },
      remove() { if (this._id) panelNodes.delete(this._id); },
    };
    return node;
  };
  const docRoot = makeNode("window");
  manualWindow.document = {
    documentElement: docRoot,
    createElementNS: (_ns, tag) => makeNode(tag),
    getElementById: (id) => panelNodes.get(id) || null,
  };
  const prevAdd = manualContext.AutoFullTextSupportingInfo.addForItem;
  let cancelObservedInSI = false;
  manualContext.AutoFullTextSupportingInfo.addForItem = async (_item, signal, opts) => {
    manualSICalls += 1;
    opts?.onProgress?.({ stage: "正在读取出版商文章页…", percent: 20 });
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        cancelObservedInSI = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
  };
  await clickImport();
  const stageNode = panelNodes.get("zotero-auto-fulltext-si-stage");
  const cancelBtnNode = panelNodes.get("zotero-auto-fulltext-si-cancel-btn");
  assert.ok(stageNode, "floating SI progress panel must appear immediately on click");
  assert.match(stageNode.textContent, /正在读取出版商文章页/);
  assert.ok(cancelBtnNode, "floating SI progress panel must render a cancel button");
  cancelBtnNode.click();
  await flushManual();
  assert.equal(cancelObservedInSI, true, "clicking cancel button must abort in-flight SI import");
  assert.match(manualAlerts.at(-1), /补处理已取消/);
  // Clicking again must start cleanly (no stuck '正在处理中' lock!)
  manualContext.AutoFullTextSupportingInfo.addForItem = prevAdd;
  const callsAfterPanelCancel = manualSICalls;
  await clickImport();
  assert.equal(manualSICalls, callsAfterPanelCancel + 1, "after clicking cancel button, next SI click must start a fresh task");
  releaseManualSI({ skipped: false });
  await flushManual();
  delete manualWindow.document;
}

const callsBeforeTranslation = manualSICalls;
const translationsBeforeMenu = translatedItems.length;
manualMenu.menus[1].onCommand(null, singleSelection);
await flushManual();
assert.deepEqual(translatedItems.slice(translationsBeforeMenu), [71]);
assert.equal(manualSICalls, callsBeforeTranslation);
manualContext.AutoFullTextMain.shutdown();

const packagedRoot = "jar:file:///test/zotero-auto-fulltext.xpi!/";
const loadedScripts = [];
const startupErrors = [];
let chromeRegistered = false;
let chromeDestructed = false;
const bootstrapContext = vm.createContext({
  Zotero: {
    initializationPromise: Promise.resolve(),
    unlockPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    getMainWindow: () => ({ AbortController }),
    Notifier: { registerObserver: () => "notifier", unregisterObserver: () => {} },
    PreferencePanes: { register: async () => "pane", unregister: () => {} },
    MenuManager: { registerMenu: () => "menu", unregisterMenu: () => {} },
    debug: () => {},
    logError: (error) => startupErrors.push(error),
  },
  ChromeUtils: { importESModule: () => ({ OS: {} }) },
  Components: {
    classes: {
      "@mozilla.org/addons/addon-manager-startup;1": {
        getService: () => ({
          registerChrome: (manifestURI, entries) => {
            assert.equal(manifestURI.spec, `${packagedRoot}manifest.json`);
            assert.equal(JSON.stringify(entries), JSON.stringify([["content", "zotero-auto-fulltext", "content/"]]));
            chromeRegistered = true;
            return { destruct: () => { chromeDestructed = true; } };
          },
        }),
      },
    },
    interfaces: { amIAddonManagerStartup: {} },
  },
  Services: {
    io: { newURI: (spec) => ({ spec }) },
    obs: { addObserver: () => {}, removeObserver: () => {} },
    scriptloader: {
      loadSubScript(uri, scope) {
        assert.ok(uri.startsWith(packagedRoot), `expected a packaged script URI: ${uri}`);
        const script = uri.slice(packagedRoot.length);
        loadedScripts.push(script);
        vm.runInContext(read(script), vm.isContext(scope) ? scope : vm.createContext(scope));
      },
    },
  },
  URL,
  DOMParser: class {},
  TextDecoder,
  TextEncoder,
  XMLSerializer: class {},
  atob,
  btoa,
  setTimeout,
  clearTimeout,
});
vm.runInContext(read("bootstrap.js"), bootstrapContext);
await bootstrapContext.startup({ id: "test", version: JSON.parse(read("manifest.json")).version, rootURI: packagedRoot });
assert.deepEqual(startupErrors, []);
assert.equal(chromeRegistered, true, "bootstrap startup should dynamically register chrome://zotero-auto-fulltext/content/");
assert.equal(loadedScripts.length, 6);
assert.equal(loadedScripts.at(-1), "content/modules/main.js");
assert.equal(bootstrapContext.AutoFullTextScope.AbortController, AbortController);
await bootstrapContext.shutdown();
assert.equal(chromeDestructed, true, "bootstrap shutdown should unregister dynamic chrome handle");
assert.equal(bootstrapContext.AutoFullTextScope, null);
assert.deepEqual(startupErrors, []);

console.log("Translation and SI behavior checks passed (HTTP/HTTPS, first SI only, fresh SI retries, verification window, diagnostics, lifecycle and packaged startup).");
