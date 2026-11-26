var AutoFullTextSupportingInfo = (function () {
  const supportingPattern = /support(?:ing)?\s*information|supplement(?:ary)?\s*(?:information|materials?|files?)|\b(?:ESI|SI)\b|additional\s*files?|MOESM/i;
  const fileExtensions = "pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt htm html csv xml tif tiff jpg jpeg png svg bmp".split(" ");
  const filePattern = new RegExp(`\\.(?:${fileExtensions.join("|")})$`, "i");
  const htmlFilePattern = /\.html?$/i;
  const maxFileBytes = 100 * 1024 * 1024;

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

  function checkPublisherAccess(result, articleURL, status = null, html = "") {
    const response = result?.xmlhttp || result;
    let challengeHeader = "";
    try {
      challengeHeader = String(response?.getResponseHeader?.("cf-mitigated") || "").trim().toLowerCase();
    } catch {
      // Response headers may be unavailable after a transport failure.
    }
    const isChallenge = challengeHeader === "challenge" ||
      (/\/cdn-cgi\/challenge-platform\//i.test(html) && /\b_cf_chl_opt\b/i.test(html));
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
    const pathPart = new URL(url).pathname.split("/").pop() || "supporting-info";
    const raw = download || pathPart;
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

  async function findLinks(articleURL, signal, workspace, attempt) {
    const { doc, responseURL } = await AutoFullText.fetchDocument(articleURL, {
      signal,
      noCache: true,
      headers: { Accept: "text/html,application/xhtml+xml" },
      onResponse: (response, url) => inspectRequest(attempt, response, url),
      onRawText: async (text, url) => {
        await workspace.writeText("si-source-article.html", text);
        checkPublisherAccess(null, url, null, text.slice(0, 8192));
      },
    });
    attempt.stage = "识别 SI 链接";
    const parsedHTML = doc.documentElement?.outerHTML || "";
    const article = new URL(responseURL);
    article.hash = "";
    for (const anchor of doc.querySelectorAll("a[href]")) {
      const target = anchor.getAttribute("href")?.trim();
      if (!target || target.startsWith("#")) continue;
      let url;
      try {
        url = new URL(AutoFullText.validateResourceURL(target, responseURL));
      } catch (error) {
        continue;
      }
      url.hash = "";
      if (url.href === article.href) continue;
      const download = anchor.getAttribute("download");
      const label = [anchor.textContent, anchor.title, anchor.getAttribute("aria-label"), download, url.pathname].join(" ");
      if (!supportingPattern.test(label)) continue;
      const filename = filenameFor(url.href, anchor);
      if (!filePattern.test(filename) && !filePattern.test(url.pathname) && download === null &&
        !/\/(?:suppdata|files?|downloads?|attachments?)(?:\/|$)/i.test(url.pathname)) continue;
      return { link: { url: url.href, filename }, responseURL, parsedHTML };
    }
    return { link: null, responseURL, parsedHTML };
  }

  function stableSuffix(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  async function downloadBounded(url, workspace, filePrefix, fallbackFilename, referrer, signal, attempt) {
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
      let response;
      try {
        response = await Zotero.HTTP.request("GET", currentURL, {
          headers: { Accept: "application/pdf,application/octet-stream,*/*;q=0.5", Referer: `${new URL(referrer).origin}/` },
          responseType: "arraybuffer",
          timeout: 60000,
          errorDelayMax: 0,
          noRetryOnThrottle: true,
          noCache: true,
          anon: true,
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
      if (!bytes.length) throw new Error("Supporting file download returned an empty body.");
      const contentType = String(response.getResponseHeader("Content-Type") || "").split(";")[0].trim().toLowerCase();
      const disposition = response.getResponseHeader("Content-Disposition") || "";
      const filename = responseFilename(disposition, currentURL, fallbackFilename, contentType);
      const prefix = new TextDecoder().decode(bytes.subarray(0, 8192));
      const isHTML = ["text/html", "application/xhtml+xml"].includes(contentType) || looksLikeHTML(prefix);
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
    throw new Error("Supporting file download did not complete.");
  }

  async function withWorkspace(signal, attempt, process) {
    throwIfAborted(signal);
    const workspace = await AutoFullTextPdf.createWorkspace();
    let result;
    try {
      result = await process(workspace);
    } catch (error) {
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
      if (reported.name === "SupportingInfoAccessError" || reported.name === "SupportingInfoConnectionError") {
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

  async function importPDF(item, path, title, workspace, signal, attempt) {
    attempt.stage = "校验或转换 SI 文件";
    throwIfAborted(signal);
    checkFileSize(Zotero.File.pathToFile(path));
    const pdfPath = await AutoFullTextPdf.convertToPdf(path, workspace, signal);
    attempt.stage = "导入 Zotero 子附件";
    throwIfAborted(signal);
    const attachment = await Zotero.Attachments.importFromFile({
      file: Zotero.File.pathToFile(pdfPath),
      parentItemID: item.id,
      title,
      contentType: "application/pdf",
    });
    if (!attachment?.id) throw new Error("Zotero 没有返回已导入的 SI 附件。");
  }

  async function addForItem(item, signal = null) {
    const articleURL = AutoFullText.itemURL(item, { preferDOI: true });
    if (!articleURL) throw new Error("No article URL or DOI is available for SI discovery.");
    const attempt = { stage: "读取出版商文章页", request: null };
    return withWorkspace(signal, attempt, async (workspace) => {
      const { link, responseURL, parsedHTML } = await findLinks(articleURL, signal, workspace, attempt);
      await workspace.writeText("si-source-article-parsed.html", parsedHTML);
      throwIfAborted(signal);
      if (!link) throw new Error("No supporting-information link was found on the article webpage.");

      const attachmentSuffix = `[${stableSuffix(link.url)}]`;
      for (const id of item.getAttachments()) {
        const attachment = Zotero.Items.get(id);
        const title = String(attachment?.getField("title") || "").toLowerCase();
        if (title.startsWith("supporting information - ") && title.endsWith(attachmentSuffix) &&
          attachment.isFileAttachment() && attachment.attachmentContentType === "application/pdf" &&
          await attachment.fileExists()) return { skipped: true };
      }
      const filePrefix = `si-${Zotero.Utilities.randomString(6)}-`;
      attempt.stage = "下载第一份 SI 文件";
      attempt.request = null;
      const downloaded = await downloadBounded(link.url, workspace, filePrefix, link.filename, responseURL, signal, attempt);
      await importPDF(item, downloaded.path, `Supporting Information - ${downloaded.filename} ${attachmentSuffix}`, workspace, signal, attempt);
      return { skipped: false };
    });
  }

  return { addForItem };
})();
