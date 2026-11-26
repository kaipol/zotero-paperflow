var AutoFullTextSupportingInfo = (function () {
  const CHALLENGE_WINDOW_URL = "chrome://zotero-auto-fulltext/content/challenge-window.xhtml";
  const supportingPattern = /support(?:ing)?\s*(?:information|materials?|files?)|supplement(?:ary)?\s*(?:information|materials?|files?|data|pdf|document)|\b(?:ESI|SI)\b|additional\s*files?|MOESM|downloadSupplement|suppl_file|suppdata|\bmmc\d+\b/i;
  const fileExtensions = "pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt htm html csv xml tif tiff jpg jpeg png svg bmp".split(" ");
  const filePattern = new RegExp(`\\.(?:${fileExtensions.join("|")})(?:$|[^a-z0-9])`, "i");
  const htmlFilePattern = /\.html?$/i;
  const maxFileBytes = 100 * 1024 * 1024;
  const CHALLENGE_INIT_TIMEOUT_MS = 6000;
  let challengeSessionQueue = Promise.resolve();

  function resetSessionState() {
    challengeSessionQueue = Promise.resolve();
    try {
      if (Zotero._autoFullTextChallengeSessions instanceof Map) {
        Zotero._autoFullTextChallengeSessions.clear();
      }
    } catch {
      // Ignore cleanup errors on shutdown.
    }
  }

  function emitProgress(onProgress, stage, percent, extra = null) {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ stage, percent, ...(extra || {}) });
    } catch {
      // Ignore UI callback errors.
    }
  }

  function readStatus(result, key) {
    try {
      const value = result?.[key];
      return Number.isInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  function isHTTPException(result, name) {
    const exception = Zotero.HTTP[name];
    return result?.name === name || (typeof exception === "function" && result instanceof exception);
  }

  function getBrowserUserAgent() {
    let raw = "";
    try {
      raw = String(Zotero.getMainWindow?.()?.navigator?.userAgent || "").trim();
    } catch {
      raw = "";
    }
    if (!raw) return "";
    const rvMatch = raw.match(/\brv:(\d+(?:\.\d+)?)\b/i);
    let normalized = raw.replace(/\s+Zotero\/[^\s]+/gi, "").trim();
    if (rvMatch && !/\bFirefox\/\d+/i.test(normalized)) {
      normalized = `${normalized} Firefox/${rvMatch[1]}`;
    }
    return normalized;
  }

  function isChallengeHTML(html = "", title = "") {
    const titleText = String(title || "");
    if (/just a moment|attention required|checking your browser|one more step|verify you are human|security check|ddos-guard|请稍候|正在检查|安全验证/i.test(titleText)) {
      return true;
    }
    const prefix = String(html || "").slice(0, 16384);
    if (!prefix) return false;
    if (/\/cdn-cgi\/challenge-platform\//i.test(prefix) &&
      /(?:\b_cf_chl_opt\b|challenge-error-text|cf-browser-verification|managed_checking_msg|turnstile)/i.test(prefix)) {
      return true;
    }
    if (/Enable JavaScript and cookies to continue|Checking if the site connection is secure/i.test(prefix)) {
      return true;
    }
    if (/<title[^>]*>\s*(?:Just a moment|Attention Required|请稍候)[^<]*<\/title>/i.test(prefix)) {
      return true;
    }
    return false;
  }

  function isChallengeDocument(doc, currentURL = "") {
    if (!doc || !doc.documentElement || !/^https?:\/\//i.test(String(currentURL || ""))) return true;
    const title = String(doc.title || "");
    if (isChallengeHTML("", title)) return true;
    try {
      if (typeof doc.querySelector === "function" && doc.querySelector(
        '#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running, #cf-wrapper, #turnstile-wrapper, .cf-browser-verification, .cf-turnstile, input[name="cf-turnstile-response"], form[action*="__cf_chl"], iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, #px-captcha',
      )) {
        return true;
      }
      if (typeof doc.querySelector === "function" && doc.querySelector(
        'meta[name="citation_doi"], meta[name="citation_title"], meta[name="dc.identifier"], meta[name="DC.Identifier"]',
      )) {
        return false;
      }
    } catch {
      // Ignore selector error on partial documents.
    }
    try {
      return isChallengeHTML(doc.documentElement.outerHTML || "", title);
    } catch {
      return false;
    }
  }

  function checkPublisherAccess(result, articleURL, status = null, html = "") {
    const response = result?.xmlhttp || result;
    let challengeHeader = "";
    let bodyText = html;
    try {
      challengeHeader = String(response?.getResponseHeader?.("cf-mitigated") || "").trim().toLowerCase();
    } catch {
      // Response headers may be unavailable after a transport failure.
    }
    if (!bodyText) {
      try {
        bodyText = String(response?.responseText || "").slice(0, 16384);
      } catch {
        bodyText = "";
      }
    }
    const isChallenge = challengeHeader === "challenge" || isChallengeHTML(bodyText);
    if (!isChallenge && status !== 403) return;
    const reason = isChallenge ? "出版商要求在网页中完成安全验证" : "出版商拒绝了后台访问";
    throw Object.assign(new Error(`${reason}${status ? `（HTTP ${status}）` : ""}。`), {
      name: "SupportingInfoAccessError",
      publisherURL: articleURL,
    });
  }

  function inspectRequest(attempt, result, requestURL, articleURL = requestURL) {
    const requestStatus = readStatus(result, "status") ?? readStatus(result?.xmlhttp, "status");
    const responseStatus = readStatus(result, "responseStatus");
    const channelStatus = readStatus(result, "channelStatus");
    const httpStatus = [responseStatus, requestStatus].find((value) => value >= 100 && value <= 599) ?? null;
    attempt.request = { origin: new URL(requestURL).origin, requestStatus, httpStatus, channelStatus };
    checkPublisherAccess(result, articleURL, httpStatus);
    if (httpStatus >= 400 && httpStatus <= 599) throw new Error(`出版商返回 HTTP ${httpStatus}。`);

    let reason;
    if (isHTTPException(result, "TimeoutException")) reason = "请求出版商超时。";
    else if (isHTTPException(result, "BrowserOfflineException")) reason = "Zotero 当前处于离线状态。";
    else if (requestStatus === 0) reason = "Zotero 未能完成出版商请求（请求状态 0，不是 HTTP 状态码）。";
    if (reason) {
      throw Object.assign(new Error(reason), { name: "SupportingInfoConnectionError", publisherURL: articleURL });
    }
  }

  function looksLikeHTML(text) {
    return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<form\b)/i.test(text.replace(/^\uFEFF/, ""));
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("Supporting information processing cancelled.");
    error.name = "AbortError";
    throw error;
  }

  function filenameFor(url, anchor) {
    const download = anchor.getAttribute("download");
    const parsed = new URL(url);
    const queryFile = parsed.searchParams.get("file") || parsed.searchParams.get("filename") || "";
    const pathPart = parsed.pathname.split("/").pop() || "supporting-info";
    const raw = download || (filePattern.test(queryFile) ? queryFile : pathPart);
    try {
      return AutoFullText.safeName(decodeURIComponent(raw)) || "supporting-info";
    } catch {
      return AutoFullText.safeName(raw) || "supporting-info";
    }
  }

  function responseFilename(contentDisposition, url, fallback, contentType) {
    const disposition = String(contentDisposition || "");
    const extended = disposition.match(/(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
    const ordinary = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)'|([^;]*))/i);
    let filename = "";
    const encodedName = extended?.[1]?.trim().replace(/^"|"$/g, "");
    if (encodedName) {
      try {
        filename = decodeURIComponent(encodedName);
      } catch (error) {
        filename = encodedName;
      }
    }
    if (!filename && ordinary) filename = (ordinary[1] ?? ordinary[2] ?? ordinary[3] ?? "").replace(/\\"/g, '"').trim();
    if (!filename) filename = fallback || new URL(url).pathname.split("/").pop() || "supporting-info";

    const mime = String(contentType || "").split(";")[0].trim().toLowerCase();
    const extensions = {
      "application/pdf": ".pdf",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.ms-excel": ".xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/vnd.ms-powerpoint": ".ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
      "text/csv": ".csv",
      "text/plain": ".txt",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/svg+xml": ".svg",
      "image/tiff": ".tif",
    };
    const extension = Object.hasOwn(extensions, mime) ? extensions[mime] : "";
    if (extension && !/\.[^./\\]+$/.test(filename)) filename += extension;
    return AutoFullText.safeName(filename) || `supporting-info${extension}`;
  }

  function isMainArticlePDFPath(pathname = "", anchorText = "") {
    if (/\/(?:articlepdf|epdf|pdfdirect)\//i.test(pathname) && !supportingPattern.test(anchorText)) {
      return true;
    }
    if (/\b(?:article\s*pdf|download\s*pdf|full\s*text\s*pdf|manuscript\s*pdf)\b/i.test(anchorText) && !supportingPattern.test(pathname)) {
      return true;
    }
    return false;
  }

  function containerContextText(node) {
    const parts = [];
    try {
      let current = node?.parentElement || null;
      for (let depth = 0; current && depth < 4; depth += 1) {
        const tag = String(current.tagName || "").toLowerCase();
        const idClass = `${current.id || ""} ${current.className || ""}`;
        if (/supp|esi|additional|supporting/i.test(idClass)) parts.push(idClass);
        if (["li", "tr", "dd", "p", "div", "section", "article", "aside"].includes(tag)) {
          const text = String(current.textContent || "").trim();
          if (text && text.length <= 600) parts.push(text);
          const heading = typeof current.querySelector === "function"
            ? current.querySelector("h1, h2, h3, h4, h5, h6, legend, summary")
            : null;
          if (heading?.textContent) parts.push(heading.textContent);
        }
        const prev = current.previousElementSibling;
        if (prev && /^h[1-6]$/i.test(String(prev.tagName || ""))) {
          parts.push(prev.textContent || "");
        }
        current = current.parentElement;
      }
    } catch {
      // Ignore cross-compartment DOM traversal issues.
    }
    return parts.join(" ");
  }

  function extractSupportingLinkFromHTML(html, responseURL) {
    const source = String(html || "");
    if (!source) return null;
    const patterns = [
      /(?:https?:)?\/\/(?:www\.|static\.|pubs\.)?rsc(?:-cdn)?\.org\/suppdata\/[^\s"'<>\\]+?\.(?:pdf|docx?|xlsx?|pptx?|rtf|txt|csv|xml|odt|ods|odp)/gi,
      /(?:https?:)?\/\/static-content\.springer\.com\/esm\/[^\s"'<>\\]+?\.(?:pdf|docx?|xlsx?|pptx?|rtf|txt|csv|xml|odt|ods|odp)/gi,
      /(?:https?:)?\/\/[^/\s"'<>\\]+\/doi\/suppl\/[^\s"'<>\\]+?\/suppl_file\/[^\s"'<>\\]+?\.(?:pdf|docx?|xlsx?|pptx?|rtf|txt|csv|xml|odt|ods|odp)/gi,
      /(?:https?:\/\/[^/\s"'<>\\]+)?\/[^\s"'<>\\]*(?:suppdata|suppl_file|downloadSupplement|MOESM\d+)[^\s"'<>\\]*?\.(?:pdf|docx?|xlsx?|pptx?|rtf|txt|csv|xml|odt|ods|odp)/gi,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const raw = match[0].replace(/&amp;/gi, "&").replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
        try {
          const validated = AutoFullText.validateResourceURL(raw, responseURL);
          const parsed = new URL(validated);
          const filename = AutoFullText.safeName(decodeURIComponent(parsed.pathname.split("/").pop() || "supporting-info")) || "supporting-info";
          return { url: validated, filename };
        } catch {
          // Skip invalid or untrusted candidate URLs.
        }
      }
    }
    return null;
  }

  function extractSupportingLink(doc, responseURL, rawHTML = "") {
    const article = new URL(responseURL);
    article.hash = "";
    const pathHintPattern = /\/(?:suppdata|suppinfo|suppl_file|suppl(?:ement(?:ary)?)?|esi|esm|files?|downloads?|downloadSupplement|attachments?|getfile|asset|mmc\d+)(?:\/|$|\?)/i;

    if (doc && typeof doc.querySelectorAll === "function") {
      const anchors = doc.querySelectorAll("a[href], [data-href], [data-url], [data-download-url]");
      const candidates = [];
      for (let i = 0; i < anchors.length; i += 1) {
        const anchor = anchors[i];
        if (!anchor || typeof anchor.getAttribute !== "function") continue;
        const target = (
          anchor.getAttribute("href") ||
          anchor.getAttribute("data-href") ||
          anchor.getAttribute("data-url") ||
          anchor.getAttribute("data-download-url") ||
          ""
        ).trim();
        if (!target || target.startsWith("#") || /^javascript:/i.test(target)) continue;
        let url;
        try {
          url = new URL(AutoFullText.validateResourceURL(target, responseURL));
        } catch {
          continue;
        }
        url.hash = "";
        if (url.href === article.href) continue;
        const download = anchor.getAttribute("download");
        const anchorText = String(anchor.textContent || "");
        const label = [anchorText, anchor.title, anchor.getAttribute("aria-label"), download, url.pathname, url.search].join(" ");
        const filename = filenameFor(url.href, anchor);
        const hasFileHint = filePattern.test(filename) || filePattern.test(url.pathname) || filePattern.test(url.search) || download !== null;
        const isBareDOISupplLanding = /^\/doi\/suppl\/10\.[^/]+\/[^/]+\/?$/i.test(url.pathname) && !hasFileHint;
        if (isBareDOISupplLanding) continue;

        if (supportingPattern.test(label)) {
          if (hasFileHint || pathHintPattern.test(url.pathname)) {
            return { url: url.href, filename };
          }
        }
        if (hasFileHint && !isMainArticlePDFPath(url.pathname, anchorText)) {
          candidates.push({ anchor, url, filename });
        }
      }

      // Pass 2: Match file download links inside an explicitly labeled Supporting / Supplementary Information section
      for (let i = 0; i < candidates.length; i += 1) {
        const { anchor, url, filename } = candidates[i];
        const contextText = containerContextText(anchor);
        if (supportingPattern.test(contextText)) {
          return { url: url.href, filename };
        }
      }
    }

    // Pass 3: Fallback scan of raw HTML for explicit direct SI URLs (e.g. RSC suppdata / Springer ESM / ACS suppl_file)
    let htmlSource = rawHTML;
    if (!htmlSource && doc?.documentElement) {
      try {
        htmlSource = String(doc.documentElement.outerHTML || "");
      } catch {
        htmlSource = "";
      }
    }
    return extractSupportingLinkFromHTML(htmlSource, responseURL);
  }

  function rscLandingFallbackURL(responseURL) {
    try {
      const parsed = new URL(responseURL);
      if (parsed.hostname.toLowerCase() === "pubs.rsc.org" && /\/en\/content\/articlehtml\//i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/en\/content\/articlehtml\//i, "/en/content/articlelanding/");
        return parsed.href;
      }
    } catch {
      // Ignore invalid URL.
    }
    return "";
  }

  async function findLinks(articleURL, signal, workspace, attempt, userAgent) {
    const headers = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
    if (userAgent) headers["User-Agent"] = userAgent;
    const { doc, responseURL, rawText } = await AutoFullText.fetchDocument(articleURL, {
      signal,
      noCache: true,
      anon: false,
      headers,
      onResponse: (response, url) => inspectRequest(attempt, response, url),
      onRawText: async (text, url) => {
        await workspace.writeText("si-source-article.html", text);
        checkPublisherAccess(null, url, null, text.slice(0, 16384));
      },
    });
    attempt.stage = "识别 SI 链接";
    const parsedHTML = doc.documentElement?.outerHTML || rawText || "";
    let link = extractSupportingLink(doc, responseURL, rawText || parsedHTML);
    if (!link) {
      const landingURL = rscLandingFallbackURL(responseURL);
      if (landingURL) {
        try {
          const landing = await AutoFullText.fetchDocument(landingURL, {
            signal,
            noCache: true,
            anon: false,
            headers,
            onResponse: (response, url) => inspectRequest(attempt, response, url),
            onRawText: async (text, url) => {
              await workspace.writeText("si-source-article-landing.html", text);
              checkPublisherAccess(null, url, null, text.slice(0, 16384));
            },
          });
          const landingHTML = landing.doc.documentElement?.outerHTML || landing.rawText || "";
          link = extractSupportingLink(landing.doc, landing.responseURL, landing.rawText || landingHTML);
          if (link) return { link, responseURL: landing.responseURL, parsedHTML: landingHTML };
        } catch (fallbackError) {
          AutoFullText.log("RSC articlelanding fallback failed", fallbackError);
        }
      }
    }
    return { link, responseURL, parsedHTML };
  }

  function stableSuffix(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async function hasExistingAttachment(item, linkURL) {
    const attachmentSuffix = `[${stableSuffix(linkURL)}]`;
    for (const id of item.getAttachments()) {
      const attachment = Zotero.Items.get(id);
      const title = String(attachment?.getField("title") || "").toLowerCase();
      if (title.startsWith("supporting information - ") && title.endsWith(attachmentSuffix) &&
        attachment.isFileAttachment() && attachment.attachmentContentType === "application/pdf" &&
        await attachment.fileExists()) {
        return true;
      }
    }
    return false;
  }

  async function persistDownloadedBytes(bytes, currentURL, fallbackFilename, referrer, status, contentType, disposition, workspace, filePrefix) {
    if (bytes.byteLength > maxFileBytes) {
      throw new Error("Supporting file exceeds the 100 MB download limit.");
    }
    if (!bytes.length) throw new Error("Supporting file download returned an empty body.");
    const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
    const filename = responseFilename(disposition, currentURL, fallbackFilename, normalizedType);
    const prefix = new TextDecoder().decode(bytes.subarray(0, 8192));
    const isHTML = ["text/html", "application/xhtml+xml"].includes(normalizedType) || looksLikeHTML(prefix);
    if (isHTML) {
      checkPublisherAccess(null, referrer, status, prefix);
      const advertisedHTML = htmlFilePattern.test(filename) &&
        (htmlFilePattern.test(fallbackFilename) || /^\s*attachment\s*(?:;|$)/i.test(disposition));
      if (!advertisedHTML) throw new Error("Supporting file URL returned an HTML page instead of the advertised file.");
    }
    const path = workspace.file(`${filePrefix}${filename}`);
    await OS.File.writeAtomic(path, bytes);
    return { path, filename };
  }

  async function downloadViaChallengeWindow(handle, url, workspace, filePrefix, fallbackFilename, referrer, signal, attempt) {
    const validatedURL = AutoFullText.validateResourceURL(url, referrer);
    if (new URL(validatedURL).origin !== new URL(referrer).origin) {
      throw Object.assign(new Error("Cross-origin SI URL uses session HTTP download."), { name: "ChallengeFetchCrossOrigin" });
    }
    throwIfAborted(signal);
    const result = await handle.fetchInWindow(validatedURL, referrer, maxFileBytes);
    throwIfAborted(signal);
    if (result.type === "opaque" || result.type === "opaqueredirect") {
      throw Object.assign(new Error("Opaque fetch response cannot be inspected."), { name: "ChallengeFetchOpaque" });
    }
    const status = Number(result.status || 0);
    const finalURL = result.responseURL ? AutoFullText.validateResourceURL(result.responseURL, referrer) : validatedURL;
    attempt.request = { origin: new URL(finalURL).origin, requestStatus: status, httpStatus: status >= 100 && status <= 599 ? status : null, channelStatus: null };
    const cfMitigated = String(result.getHeader?.("cf-mitigated") || "").trim().toLowerCase();
    if (cfMitigated === "challenge" || status === 403 || status === 503) {
      const prefix = new TextDecoder().decode((result.bytes || new Uint8Array(0)).subarray(0, 8192));
      checkPublisherAccess({ getResponseHeader: (name) => result.getHeader?.(name) || "" }, finalURL, status, prefix);
    }
    if (status < 200 || status >= 300) throw new Error(`Supporting file returned HTTP ${status}.`);
    return persistDownloadedBytes(
      result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes || new ArrayBuffer(0)),
      finalURL,
      fallbackFilename,
      referrer,
      status,
      result.getHeader?.("content-type") || "",
      result.getHeader?.("content-disposition") || "",
      workspace,
      filePrefix,
    );
  }

  async function downloadBounded(url, workspace, filePrefix, fallbackFilename, referrer, signal, attempt, userAgent = "") {
    let currentURL = AutoFullText.validateResourceURL(url, referrer);
    const visited = new Set();
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      throwIfAborted(signal);
      if (visited.has(currentURL)) throw new Error("Supporting file redirect loop detected.");
      visited.add(currentURL);

      let oversized = false;
      let cancelRequest = null;
      const abort = () => cancelRequest?.();
      signal?.addEventListener("abort", abort, { once: true });
      const headers = {
        Accept: "application/pdf,application/octet-stream,*/*;q=0.5",
        Referer: `${new URL(referrer).origin}/`,
      };
      if (userAgent) headers["User-Agent"] = userAgent;
      let response;
      try {
        response = await Zotero.HTTP.request("GET", currentURL, {
          headers,
          responseType: "arraybuffer",
          timeout: 60000,
          errorDelayMax: 0,
          noRetryOnThrottle: true,
          noCache: true,
          anon: false,
          followRedirects: false,
          requestObserver(xhr) {
            const rejectOversized = () => {
              oversized = true;
              cancelRequest?.();
            };
            xhr.addEventListener("readystatechange", () => {
              if (xhr.readyState < 2) return;
              const contentLength = Number.parseInt(xhr.getResponseHeader("Content-Length") || "0", 10) || 0;
              if (contentLength > maxFileBytes) rejectOversized();
            });
            xhr.addEventListener("progress", (event) => {
              if (Number(event.loaded || 0) > maxFileBytes || Number(event.total || 0) > maxFileBytes) rejectOversized();
            });
          },
          cancellerReceiver(canceller) {
            cancelRequest = canceller;
            if (signal?.aborted || oversized) cancelRequest?.();
          },
        });
      } catch (error) {
        if (oversized) throw new Error("Supporting file exceeds the 100 MB download limit.");
        throwIfAborted(signal);
        inspectRequest(attempt, error, currentURL, referrer);
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }

      throwIfAborted(signal);
      if (oversized) throw new Error("Supporting file exceeds the 100 MB download limit.");
      inspectRequest(attempt, response, currentURL, referrer);
      const status = Number(response.status || 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects === 5) throw new Error("Supporting file exceeded the redirect limit.");
        const location = response.getResponseHeader("Location");
        if (!location) throw new Error(`Supporting file redirect ${status} has no Location header.`);
        currentURL = AutoFullText.validateRedirectURL(new URL(location, currentURL).href, currentURL, referrer);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`Supporting file returned HTTP ${status}.`);

      if (response.responseURL) AutoFullText.validateResourceURL(response.responseURL, referrer);
      const contentLength = Number.parseInt(response.getResponseHeader("Content-Length") || "0", 10) || 0;
      const bytes = response.response instanceof Uint8Array
        ? response.response
        : new Uint8Array(response.response || new ArrayBuffer(0));
      if (contentLength > maxFileBytes || bytes.byteLength > maxFileBytes) {
        throw new Error("Supporting file exceeds the 100 MB download limit.");
      }
      return persistDownloadedBytes(
        bytes,
        currentURL,
        fallbackFilename,
        referrer,
        status,
        response.getResponseHeader("Content-Type") || "",
        response.getResponseHeader("Content-Disposition") || "",
        workspace,
        filePrefix,
      );
    }
    throw new Error("Supporting file download did not complete.");
  }

  function combineSignals(primary, secondary) {
    if (!secondary) return primary;
    if (!primary) return secondary;
    if (typeof AbortController !== "function") return primary;
    const merged = new AbortController();
    const abort = () => merged.abort();
    if (primary.aborted || secondary.aborted) {
      merged.abort();
      return merged.signal;
    }
    primary.addEventListener("abort", abort, { once: true });
    secondary.addEventListener("abort", abort, { once: true });
    return merged.signal;
  }

  async function downloadVerifiedLink(handle, link, responseURL, workspace, filePrefix, signal, attempt, userAgent) {
    const activeSignal = combineSignals(signal, handle?.signal || null);
    let lastAccessError = null;
    try {
      return await downloadViaChallengeWindow(handle, link.url, workspace, filePrefix, link.filename, responseURL, activeSignal, attempt);
    } catch (error) {
      throwIfAborted(activeSignal);
      if (/100 MB/.test(String(error?.message || ""))) throw error;
      if (error?.name === "SupportingInfoAccessError") {
        lastAccessError = error;
      } else if (error?.name !== "ChallengeFetchCrossOrigin") {
        AutoFullText.log(`In-window SI fetch fell back to session HTTP download for ${new URL(link.url).origin}`, error);
      }
    }

    try {
      return await downloadBounded(link.url, workspace, filePrefix, link.filename, responseURL, activeSignal, attempt, userAgent);
    } catch (error) {
      throwIfAborted(activeSignal);
      if (error?.name !== "SupportingInfoAccessError" && !lastAccessError) throw error;
      if (typeof handle?.navigateForSecondaryChallenge !== "function") throw error;

      attempt.stage = "等待 SI 下载主机安全验证";
      const secondary = await handle.navigateForSecondaryChallenge(link.url);
      throwIfAborted(activeSignal);
      attempt.stage = "下载第一份 SI 文件";
      const secondaryOriginRef = secondary?.responseURL || link.url;
      try {
        return await downloadViaChallengeWindow(handle, link.url, workspace, filePrefix, link.filename, secondaryOriginRef, activeSignal, attempt);
      } catch (retryError) {
        throwIfAborted(activeSignal);
        if (/100 MB/.test(String(retryError?.message || ""))) throw retryError;
        return downloadBounded(link.url, workspace, filePrefix, link.filename, responseURL, activeSignal, attempt, userAgent);
      }
    }
  }

  function openChallengeSession(challengeURL, {
    signal = null,
    userAgent = "",
    onVerified,
    onProgress = null,
    initTimeoutMs = CHALLENGE_INIT_TIMEOUT_MS,
  }) {
    const validatedURL = AutoFullText.validateArticleURL(challengeURL);
    const mainWin = Zotero.getMainWindow?.();
    if (!mainWin || typeof mainWin.openDialog !== "function") {
      throw Object.assign(new Error("无法打开 Zotero 安全验证窗口。"), {
        name: "SupportingInfoAccessError",
        publisherURL: validatedURL,
      });
    }
    const launch = () => {
      throwIfAborted(signal);
      return new Promise((resolve, reject) => {
        const sid = `si-${Zotero.Utilities.randomString(10)}`;
        if (!(Zotero._autoFullTextChallengeSessions instanceof Map)) {
          Zotero._autoFullTextChallengeSessions = new Map();
        }
        let finished = false;
        let dialogRef = null;
        let initTimer = null;
        const cleanupSession = () => {
          if (initTimer) {
            clearTimeout(initTimer);
            initTimer = null;
          }
          try { Zotero._autoFullTextChallengeSessions?.delete?.(sid); } catch {}
          signal?.removeEventListener("abort", onExternalAbort);
          emitProgress(onProgress, "", null, { challengeWindow: null });
        };
        const finishResolve = (value) => {
          if (finished) return;
          finished = true;
          cleanupSession();
          resolve(value);
        };
        const finishReject = (error) => {
          if (finished) return;
          finished = true;
          cleanupSession();
          reject(error);
        };
        const onExternalAbort = () => {
          try { dialogRef?.close?.(); } catch {}
          finishReject(Object.assign(new Error("Supporting information verification cancelled."), { name: "AbortError" }));
        };
        signal?.addEventListener("abort", onExternalAbort, { once: true });

        const args = {
          url: validatedURL,
          userAgent,
          signal,
          isChallengeDocument,
          isBlockedHost: (host) => AutoFullText.isLocalHost?.(host) || AutoFullText.isIPAddress?.(host) || false,
          hasSupportingLink: (doc, currentURL) => Boolean(extractSupportingLink(doc, currentURL)),
          hasSupportingLinkHTML: (htmlText, currentURL) => {
            try {
              if (typeof DOMParser === "function" && htmlText) {
                const parsed = new DOMParser().parseFromString(htmlText, "text/html");
                return Boolean(extractSupportingLink(parsed, currentURL, htmlText));
              }
            } catch {}
            return Boolean(extractSupportingLinkFromHTML(htmlText, currentURL));
          },
          onWindowReady: (readyWin) => {
            if (initTimer) {
              clearTimeout(initTimer);
              initTimer = null;
            }
            if (readyWin) dialogRef = readyWin;
            emitProgress(onProgress, "等待出版商安全验证（自动跳过或手动完成）…", 40, { challengeWindow: dialogRef });
          },
          onStatus: (statusText) => {
            if (statusText) emitProgress(onProgress, statusText, null, { challengeWindow: dialogRef });
          },
          onVerified,
          resolve: finishResolve,
          reject: finishReject,
        };
        Zotero._autoFullTextChallengeSessions.set(sid, args);
        const wrapped = { wrappedJSObject: args };
        try {
          emitProgress(onProgress, "需要安全验证，正在打开验证窗口…", 30);
          initTimer = setTimeout(() => {
            if (finished) return;
            try { dialogRef?.close?.(); } catch {}
            finishReject(Object.assign(new Error("安全验证窗口未能正常初始化，请检查插件安装或重试。"), {
              name: "SupportingInfoAccessError",
              publisherURL: validatedURL,
            }));
          }, initTimeoutMs);
          dialogRef = mainWin.openDialog(
            `${CHALLENGE_WINDOW_URL}?sid=${encodeURIComponent(sid)}`,
            `zotero-auto-fulltext-si-challenge-${Zotero.Utilities.randomString(6)}`,
            "chrome,centerscreen,resizable,scrollbars,width=980,height=740",
            wrapped,
          );
          dialogRef?.focus?.();
          if (!dialogRef) {
            finishReject(Object.assign(new Error("Zotero 未能弹出安全验证窗口。"), {
              name: "SupportingInfoAccessError",
              publisherURL: validatedURL,
            }));
          }
        } catch (error) {
          finishReject(Object.assign(new Error(`无法打开安全验证窗口：${String(error?.message || error)}`), {
            name: "SupportingInfoAccessError",
            publisherURL: validatedURL,
          }));
        }
      });
    };
    const queued = challengeSessionQueue.then(launch, launch);
    challengeSessionQueue = queued.then(() => {}, () => {});
    return queued;
  }

  async function runViaChallengeWindow(item, challengeURL, workspace, signal, attempt, userAgent, onProgress, initTimeoutMs) {
    attempt.stage = "等待出版商安全验证";
    attempt.request = null;
    return openChallengeSession(challengeURL, {
      signal,
      userAgent,
      onProgress,
      initTimeoutMs,
      async onVerified({ doc, responseURL, html, handle }) {
        const activeSignal = combineSignals(signal, handle?.signal || null);
        throwIfAborted(activeSignal);
        let activeHTML = String(html || "");
        let activeURL = responseURL || challengeURL;
        let activeDoc = doc || null;

        if (!activeHTML && !activeDoc) {
          attempt.stage = "读取已验证出版商文章页";
          emitProgress(onProgress, "验证已通过，正在读取文章页 HTML…", 50);
          const fetched = await findLinks(activeURL, activeSignal, workspace, attempt, userAgent);
          if (fetched.link) {
            activeURL = fetched.responseURL;
            activeHTML = fetched.parsedHTML;
            if (await hasExistingAttachment(item, fetched.link.url)) {
              handle.setStatus?.("该 SI 附件已存在，已跳过重复导入。");
              emitProgress(onProgress, "该 SI 附件已存在，已跳过重复导入。", 100);
              return { skipped: true };
            }
            const filePrefix = `si-${Zotero.Utilities.randomString(6)}-`;
            attempt.stage = "下载第一份 SI 文件";
            attempt.request = null;
            handle.setStatus?.(`已找到 SI（${fetched.link.filename}），正在自动下载…`, fetched.link.url);
            emitProgress(onProgress, `已找到 SI（${fetched.link.filename}），正在自动下载…`, 70);
            const downloaded = await downloadVerifiedLink(handle, fetched.link, activeURL, workspace, filePrefix, activeSignal, attempt, userAgent);
            handle.setStatus?.("SI 下载完成，正在导入 Zotero 附件…");
            emitProgress(onProgress, "SI 下载完成，准备导入 Zotero…", 82);
            return { skipped: false, downloaded, link: fetched.link };
          }
          throw new Error("No supporting-information link was found on the article webpage.");
        }

        await workspace.writeText("si-source-article.html", activeHTML);
        await workspace.writeText("si-source-article-parsed.html", activeHTML);
        attempt.stage = "识别 SI 链接";
        emitProgress(onProgress, "验证已通过，正在识别 SI 链接…", 55);

        let link = null;
        if (activeHTML && typeof DOMParser === "function") {
          try {
            const parsedDoc = new DOMParser().parseFromString(activeHTML, "text/html");
            link = extractSupportingLink(parsedDoc, activeURL, activeHTML);
          } catch {
            link = null;
          }
        }
        if (!link && activeDoc) {
          try {
            link = extractSupportingLink(activeDoc, activeURL, activeHTML);
          } catch {
            link = null;
          }
        }
        if (!link && activeHTML) {
          link = extractSupportingLinkFromHTML(activeHTML, activeURL);
        }
        if (!link) {
          const landingURL = rscLandingFallbackURL(activeURL);
          if (landingURL) {
            try {
              emitProgress(onProgress, "正在检查出版商文章主页的 SI 链接…", 60);
              const landing = await findLinks(landingURL, activeSignal, workspace, attempt, userAgent);
              if (landing.link) {
                link = landing.link;
                activeURL = landing.responseURL;
              }
            } catch (fallbackError) {
              AutoFullText.log("RSC articlelanding fallback in challenge session failed", fallbackError);
            }
          }
        }
        if (!link) throw new Error("No supporting-information link was found on the article webpage.");
        if (await hasExistingAttachment(item, link.url)) {
          handle.setStatus?.("该 SI 附件已存在，已跳过重复导入。");
          emitProgress(onProgress, "该 SI 附件已存在，已跳过重复导入。", 100);
          return { skipped: true };
        }
        const filePrefix = `si-${Zotero.Utilities.randomString(6)}-`;
        attempt.stage = "下载第一份 SI 文件";
        attempt.request = null;
        handle.setStatus?.(`已找到 SI（${link.filename}），正在自动下载…`, link.url);
        emitProgress(onProgress, `已找到 SI（${link.filename}），正在自动下载…`, 70);
        const downloaded = await downloadVerifiedLink(handle, link, activeURL, workspace, filePrefix, activeSignal, attempt, userAgent);
        handle.setStatus?.("SI 下载完成，正在导入 Zotero 附件…");
        emitProgress(onProgress, "SI 下载完成，准备导入 Zotero…", 82);
        return { skipped: false, downloaded, link };
      },
    });
  }

  async function withWorkspace(signal, attempt, process) {
    throwIfAborted(signal);
    const workspace = await AutoFullTextPdf.createWorkspace();
    let result;
    try {
      result = await process(workspace);
    } catch (error) {
      if (error?.name === "SupportingInfoChallengeCancelledError" && !signal?.aborted) {
        try {
          await workspace.cleanup();
        } catch (cleanupError) {
          AutoFullText.log(`Could not remove cancelled SI workspace at ${workspace.path}`, cleanupError);
        }
        throw error;
      }
      const message = String(error?.message || error).replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
        try { return new URL(value).origin; }
        catch { return "[URL]"; }
      }).slice(0, 1200);
      const detail = `阶段：${attempt.stage}\n${message}`;
      const request = attempt.request;
      const diagnostics = request ? [
        detail,
        `最近请求来源：${request.origin}`,
        `请求状态：${request.requestStatus ?? "未提供"}`,
        `HTTP 响应状态：${request.httpStatus ?? "未提供"}`,
        `Gecko 通道状态：${request.channelStatus ?? "未提供"}`,
      ].join("\n") : detail;
      try {
        await workspace.writeText("si-error.txt", diagnostics);
      } catch (saveError) {
        AutoFullText.log(`Could not save SI failure details at ${workspace.path}`, saveError);
      }
      AutoFullText.log(`SI processing stopped; intermediate files retained at ${workspace.path}: ${diagnostics}`);
      const reported = new Error(`${detail}\n中间文件已保留在：${workspace.path}`, { cause: error });
      reported.name = signal?.aborted ? "AbortError" : error?.name || "SupportingInfoError";
      if (reported.name === "SupportingInfoAccessError" ||
        reported.name === "SupportingInfoConnectionError" ||
        reported.name === "SupportingInfoChallengeCancelledError") {
        reported.publisherURL = error.publisherURL;
      }
      throw reported;
    }

    try {
      await workspace.cleanup();
    } catch (error) {
      AutoFullText.log(`SI processing finished, but intermediate files could not be removed from ${workspace.path}`, error);
    }
    return result;
  }

  function checkFileSize(file) {
    if (file.fileSize <= 0) throw new Error("SI 文件为空。");
    if (file.fileSize > maxFileBytes) throw new Error("Supporting file exceeds the 100 MB limit.");
  }

  async function importPDF(item, path, title, workspace, signal, attempt, onProgress = null) {
    attempt.stage = "校验或转换 SI 文件";
    emitProgress(onProgress, "正在校验或转换 SI 文件为 PDF…", 88);
    throwIfAborted(signal);
    checkFileSize(Zotero.File.pathToFile(path));
    const pdfPath = await AutoFullTextPdf.convertToPdf(path, workspace, signal);
    attempt.stage = "导入 Zotero 子附件";
    emitProgress(onProgress, "正在导入 Zotero 子附件…", 95);
    throwIfAborted(signal);
    const attachment = await Zotero.Attachments.importFromFile({
      file: Zotero.File.pathToFile(pdfPath),
      parentItemID: item.id,
      title,
      contentType: "application/pdf",
    });
    if (!attachment?.id) throw new Error("Zotero 没有返回已导入的 SI 附件。");
    emitProgress(onProgress, "SI 附件导入完成。", 100);
  }

  async function addForItem(item, signal = null, {
    allowChallengeWindow = true,
    onProgress = null,
    challengeInitTimeoutMs = CHALLENGE_INIT_TIMEOUT_MS,
  } = {}) {
    const articleURL = AutoFullText.itemURL(item, { preferDOI: true });
    if (!articleURL) throw new Error("No article URL or DOI is available for SI discovery.");
    const attempt = { stage: "读取出版商文章页", request: null };
    const userAgent = getBrowserUserAgent();
    const canOpenChallenge = allowChallengeWindow && typeof Zotero.getMainWindow?.()?.openDialog === "function";
    emitProgress(onProgress, "正在读取出版商文章页…", 15);

    return withWorkspace(signal, attempt, async (workspace) => {
      let directResult = null;
      let challengeTargetURL = "";
      try {
        const { link, responseURL, parsedHTML } = await findLinks(articleURL, signal, workspace, attempt, userAgent);
        await workspace.writeText("si-source-article-parsed.html", parsedHTML);
        throwIfAborted(signal);
        emitProgress(onProgress, "正在识别文章页中的 SI 链接…", 45);
        if (!link) throw new Error("No supporting-information link was found on the article webpage.");

        if (await hasExistingAttachment(item, link.url)) {
          emitProgress(onProgress, "该 SI 附件已存在，已跳过重复导入。", 100);
          return { skipped: true };
        }

        const filePrefix = `si-${Zotero.Utilities.randomString(6)}-`;
        attempt.stage = "下载第一份 SI 文件";
        attempt.request = null;
        emitProgress(onProgress, `已找到 SI（${link.filename}），正在下载…`, 65);
        try {
          const downloaded = await downloadBounded(link.url, workspace, filePrefix, link.filename, responseURL, signal, attempt, userAgent);
          directResult = { skipped: false, downloaded, link };
        } catch (downloadError) {
          if (downloadError?.name === "SupportingInfoAccessError" && canOpenChallenge) {
            challengeTargetURL = responseURL || downloadError.publisherURL || articleURL;
          } else {
            throw downloadError;
          }
        }
      } catch (error) {
        if (error?.name === "SupportingInfoAccessError" && canOpenChallenge) {
          challengeTargetURL = error.publisherURL || articleURL;
        } else {
          throw error;
        }
      }

      if (challengeTargetURL) {
        const verified = await runViaChallengeWindow(
          item,
          challengeTargetURL,
          workspace,
          signal,
          attempt,
          userAgent,
          onProgress,
          challengeInitTimeoutMs,
        );
        if (verified.skipped) return { skipped: true, usedChallengeWindow: true };
        const attachmentSuffix = `[${stableSuffix(verified.link.url)}]`;
        await importPDF(
          item,
          verified.downloaded.path,
          `Supporting Information - ${verified.downloaded.filename} ${attachmentSuffix}`,
          workspace,
          signal,
          attempt,
          onProgress,
        );
        return { skipped: false, usedChallengeWindow: true };
      }

      const attachmentSuffix = `[${stableSuffix(directResult.link.url)}]`;
      await importPDF(
        item,
        directResult.downloaded.path,
        `Supporting Information - ${directResult.downloaded.filename} ${attachmentSuffix}`,
        workspace,
        signal,
        attempt,
        onProgress,
      );
      return { skipped: false, usedChallengeWindow: false };
    });
  }

  return {
    addForItem,
    resetSessionState,
    isChallengeHTML,
    isChallengeDocument,
    extractSupportingLink,
    getBrowserUserAgent,
  };
})();
