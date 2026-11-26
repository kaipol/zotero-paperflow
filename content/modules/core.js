var AutoFullText = (function () {
  const PREF_PREFIX = "extensions.zotero.autoFullText.";
  const defaults = {
    autoDownloadSupportingInfo: false,
    autoTranslateFullText: false,
    translationEndpoint: "https://api.openai.com/v1/chat/completions",
    translationModel: "gpt-4o-mini",
    translationProviders: "[]",
    activeTranslationProvider: "openai-default",
    translationSystemPrompt: "",
  };
  const trustedRemoteRoots = [
    "springer.com", "springernature.com", "nature.com", "els-cdn.com", "elsevier.com",
    "figshare.com", "wiley.com", "oup.com", "pnas.org", "plos.org",
    "rsc.org", "mdpi.com", "frontiersin.org", "tandfonline.com",
    "sagepub.com", "acs.org", "iop.org", "cambridge.org",
  ];

  function getPref(key) {
    const value = Zotero.Prefs.get(PREF_PREFIX + key, true);
    return value === undefined || value === null ? defaults[key] : value;
  }

  function setPref(key, value) {
    Zotero.Prefs.set(PREF_PREFIX + key, value, true);
  }

  function log(message, error) {
    Zotero.debug(`[Zotero PaperFlow] ${message}${error ? `: ${String(error)}` : ""}`);
  }

  function isLocalHost(host) {
    const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal") ||
      value.endsWith(".test") || value.endsWith(".example") || value.endsWith(".invalid") || value.endsWith(".home.arpa")) return true;
    const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      if (octets.some((octet) => octet > 255)) return true;
      return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
        (octets[0] >= 224);
    }
    if (value.includes(":")) {
      const mappedDotted = value.match(/::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (mappedDotted) return isLocalHost(mappedDotted[1]);
      const normalized = value.replace(/^::ffff:/, "");
      const ipv4 = normalized.match(/^([\da-f]{1,4}):([\da-f]{1,4})$/i);
      if (ipv4) {
        const first = Number.parseInt(ipv4[1], 16);
        const second = Number.parseInt(ipv4[2], 16);
        const mapped = `${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`;
        return isLocalHost(mapped);
      }
      return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") ||
        value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
    }
    return !value.includes(".");
  }

  function isIPAddress(host) {
    const value = String(host || "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (value.includes(":")) return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return true;
    return /^(?:0x[\da-f]+|0\d+|\d+)$/.test(value);
  }

  function isTrustedRemoteHost(host) {
    const normalized = String(host || "").toLowerCase().replace(/\.$/, "");
    return !isLocalHost(normalized) && trustedRemoteRoots.some((root) =>
      normalized === root || normalized.endsWith(`.${root}`),
    );
  }

  function hasCredentialQuery(url) {
    for (const name of url.searchParams.keys()) {
      const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (/^(?:key|apikey|token|authtoken|bearertoken|secret|clientsecret|auth|password|credential|signature|sig|accesskey|accesstoken|secretaccesskey|xamzcredential|xamzsignature|xamzsecuritytoken)$/.test(normalized)) return true;
    }
    return false;
  }

  function validateArticleURL(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch (error) {
      throw new Error("Article URL is invalid.");
    }
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || hasCredentialQuery(url) ||
      (url.port && url.port !== defaultPort) || isIPAddress(url.hostname) || isLocalHost(url.hostname)) {
      throw new Error("Article URL must use HTTP or HTTPS on a standard port with a public hostname and cannot contain credentials.");
    }
    return url.href;
  }

  function validateResourceURL(value, baseURL, { requireTrustedHost = true } = {}) {
    let url;
    let base;
    try {
      base = new URL(String(baseURL || ""));
      url = new URL(String(value || ""), base);
    } catch (error) {
      throw new Error("Resource URL is invalid.");
    }
    const defaultPort = url.protocol === "https:" ? "443" : "80";
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || hasCredentialQuery(url) ||
      (url.port && url.port !== defaultPort) || isIPAddress(url.hostname) || isLocalHost(url.hostname)) {
      throw new Error("Resource URL must use HTTP or HTTPS on a standard port with a public hostname without embedded credentials.");
    }
    if (url.hostname !== base.hostname && requireTrustedHost && !isTrustedRemoteHost(url.hostname)) {
      throw new Error("Resource host is not on the trusted publisher allowlist.");
    }
    return url.href;
  }

  function validateRedirectURL(value, sourceURL, baseURL = sourceURL) {
    let source;
    let target;
    try {
      source = new URL(String(sourceURL || ""));
      target = new URL(String(value || ""), source);
    } catch (error) {
      throw new Error("Redirect URL is invalid.");
    }
    const checked = validateResourceURL(target.href, baseURL);
    if (source.protocol === "https:" && target.protocol === "http:" && !isTrustedRemoteHost(target.hostname)) {
      throw new Error("HTTPS-to-HTTP redirect to an untrusted host was blocked.");
    }
    return checked;
  }

  async function fetchTextResource(url, {
    baseURL = "",
    signal = null,
    headers = {},
    maxBytes = 30 * 1024 * 1024,
    maxRedirects = 5,
    noCache = false,
    onResponse = null,
  } = {}) {
    const articleRequest = !baseURL;
    const originalURL = articleRequest ? validateArticleURL(url) : validateResourceURL(url, baseURL);
    const originalHost = new URL(originalURL).hostname;
    let currentURL = originalURL;
    const visited = new Set();
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (signal?.aborted) {
        const cancelled = new Error("Document request cancelled.");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      if (visited.has(currentURL)) throw new Error("HTTP resource redirect loop detected.");
      visited.add(currentURL);

      let cancelRequest = null;
      let oversized = false;
      const abort = () => cancelRequest?.();
      signal?.addEventListener("abort", abort, { once: true });
      let response;
      try {
        response = await Zotero.HTTP.request("GET", currentURL, {
          headers,
          responseType: "text",
          timeout: 30000,
          errorDelayMax: 0,
          noRetryOnThrottle: true,
          noCache,
          anon: true,
          followRedirects: false,
          requestObserver(xhr) {
            const rejectOversized = () => {
              oversized = true;
              cancelRequest?.();
            };
            xhr.addEventListener("readystatechange", () => {
              if (xhr.readyState < 2) return;
              const length = Number.parseInt(xhr.getResponseHeader("Content-Length") || "0", 10) || 0;
              if (length > maxBytes) rejectOversized();
            });
            xhr.addEventListener("progress", (event) => {
              if (Number(event.loaded || 0) > maxBytes || Number(event.total || 0) > maxBytes) rejectOversized();
            });
          },
          cancellerReceiver(canceller) {
            cancelRequest = canceller;
            if (signal?.aborted || oversized) cancelRequest?.();
          },
        });
      } catch (error) {
        if (oversized) throw new Error(`HTTP resource exceeds the configured ${maxBytes}-byte limit.`);
        if (signal?.aborted) {
          const cancelled = new Error("Document request cancelled.");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        onResponse?.(error, currentURL);
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }

      if (signal?.aborted) {
        const cancelled = new Error("Document request cancelled.");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      onResponse?.(response, currentURL);
      const status = Number(response.status || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects === maxRedirects) throw new Error("HTTP resource exceeded the redirect limit.");
        const location = response.getResponseHeader("Location");
        if (!location) throw new Error(`HTTP resource redirect ${status} has no Location header.`);
        const target = new URL(location, currentURL).href;
        const checked = validateRedirectURL(target, currentURL, articleRequest ? currentURL : originalURL);
        const targetHost = new URL(checked).hostname;
        if (targetHost !== originalHost && !isTrustedRemoteHost(targetHost)) {
          throw new Error("Redirect to an untrusted or local host was blocked.");
        }
        currentURL = checked;
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`HTTP resource returned status ${status}.`);
      const text = String(response.responseText || response.response || "");
      if (!text) throw new Error("HTTP resource returned an empty body.");
      if (text.length * 2 > maxBytes + 65536) throw new Error("HTTP resource exceeded its in-memory size limit.");
      return { text, responseURL: currentURL, contentType: String(response.getResponseHeader("Content-Type") || "") };
    }
    throw new Error("HTTP resource request did not complete.");
  }

  async function fetchDocument(url, {
    signal = null,
    headers = {},
    maxBytes = 30 * 1024 * 1024,
    noCache = false,
    onRawText = null,
    onResponse = null,
  } = {}) {
    const result = await fetchTextResource(url, { signal, headers, maxBytes, noCache, onResponse });
    if (onRawText) await onRawText(result.text, result.responseURL);
    const doc = new DOMParser().parseFromString(result.text, "text/html");
    if (!doc.documentElement || doc.querySelector("parsererror")) throw new Error("Article page returned invalid HTML.");
    return { doc, responseURL: result.responseURL, rawText: result.text };
  }

  function itemURL(item, { preferDOI = false } = {}) {
    const url = item.getField("url");
    if (url && !preferDOI) return validateArticleURL(url);
    const normalizedDOI = String(item.getField("DOI") || "").trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "");
    if (!normalizedDOI) return url ? validateArticleURL(url) : "";
    const path = encodeURIComponent(normalizedDOI).replace(/%2F/gi, "/");
    return validateArticleURL(`https://doi.org/${path}`);
  }

  function regularItem(item) {
    return Boolean(item && item.isRegularItem && item.isRegularItem());
  }

  function attachmentByTitle(item, title) {
    const normalized = title.toLowerCase();
    return item.getAttachments().some((id) => {
      const attachment = Zotero.Items.get(id);
      const attachmentTitle = String(attachment?.getField("title") || "").toLowerCase();
      return attachmentTitle === normalized || attachmentTitle.startsWith(`${normalized} - `);
    });
  }

  function safeName(name) {
    return Zotero.File.getValidFileName(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
  }

  return {
    PREF_PREFIX,
    getPref,
    setPref,
    log,
    isLocalHost,
    isIPAddress,
    isTrustedRemoteHost,
    hasCredentialQuery,
    validateArticleURL,
    validateResourceURL,
    validateRedirectURL,
    fetchTextResource,
    fetchDocument,
    itemURL,
    regularItem,
    attachmentByTitle,
    safeName,
  };
})();
