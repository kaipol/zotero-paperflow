var AutoFullTextTranslation = (function () {
  const stopHeadingsEnglish = /^(?:references?|bibliography|literature cited|works cited|appendix(?:es)?|supplementary (?:information|materials?|data))(?:\b|$)/i;
  const stopHeadingsChinese = /^(?:参考文献|文献列表|附录|补充材料)/;
  const acknowledgementsEnglish = /^(?:acknowledg(?:e)?ments?)(?:\b|$)/i;
  const acknowledgementsChinese = /^(?:致谢|鸣谢)/;
  const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,figcaption,caption,td,th,dt,dd";
  const tokenPattern = /ZAFORMAT\d{5}TOKEN/g;
  const imageLimits = { one: 12 * 1024 * 1024, all: 40 * 1024 * 1024, count: 100 };
  const maxTranslationChars = 1200;
  const maxSegmentsPerBlock = 100;
  const maxTranslationSegments = 5000;

  function textLength(element) {
    return (element.textContent || "").trim().length;
  }

  function chooseArticleRoot(doc) {
    const candidates = Array.from(doc.querySelectorAll(
      "article,[role=main],main,.article-body,.article__body,.article-body-content,#article-body,#body",
    )).filter((element) => textLength(element) > 500);
    return candidates.reduce((best, candidate) =>
      !best || textLength(candidate) > textLength(best) ? candidate : best,
    null) || doc.body;
  }

  function headingLevel(element) {
    return Number(element.tagName.slice(1)) || 6;
  }

  function normalizedHeading(text) {
    return text.trim().replace(/^[\d.()（）]+\s*/, "").trim();
  }

  function isStopHeading(text) {
    const heading = normalizedHeading(text);
    return stopHeadingsChinese.test(heading) || stopHeadingsEnglish.test(heading);
  }

  function isAcknowledgementHeading(text) {
    const heading = normalizedHeading(text);
    return acknowledgementsChinese.test(heading) || acknowledgementsEnglish.test(heading);
  }

  function removeAfter(element, root) {
    let current = element;
    while (current && current !== root) {
      let sibling = current.nextSibling;
      while (sibling) {
        const next = sibling.nextSibling;
        sibling.parentNode?.removeChild(sibling);
        sibling = next;
      }
      const parent = current.parentElement;
      current.remove();
      current = parent;
    }
  }

  function cleanSectionTail(root) {
    const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
    const acknowledgementHeading = headings.find((heading) => isAcknowledgementHeading(heading.textContent || ""));
    if (acknowledgementHeading) {
      const level = headingLevel(acknowledgementHeading);
      const nextSection = headings.find((heading) =>
        (acknowledgementHeading.compareDocumentPosition(heading) & 4) !== 0 && headingLevel(heading) <= level,
      );
      if (nextSection) removeAfter(nextSection, root);
    }
    for (const heading of headings) {
      if (!root.contains(heading) || !isStopHeading(heading.textContent || "")) continue;
      const section = heading.closest("section");
      if (section && section !== root) section.remove();
      else removeAfter(heading, root);
    }
  }

  function sanitizeCSS(value) {
    let css = String(value || "")
      .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, codepoint) => {
        const value = Number.parseInt(codepoint, 16);
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
      })
      .replace(/\\(.)/g, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@import\b[^;]*(?:;|$)/gi, "")
      .replace(/(?:-moz-binding|behavior)\s*:[^;}]+;?/gi, "")
      .replace(/(?:url|image-set|-webkit-image-set)\s*\([^)]*\)/gi, "none");
    return css;
  }

  function sanitizeInlineSVG(root) {
    const svgs = [
      ...(root.localName?.toLowerCase() === "svg" ? [root] : []),
      ...Array.from(root.querySelectorAll("svg")),
    ];
    for (const svg of svgs) {
      const doc = new DOMParser().parseFromString(svg.outerHTML, "image/svg+xml");
      const clean = sanitizeSVGDocument(doc);
      svg.replaceWith(root.ownerDocument.importNode(clean, true));
    }
  }

  function removeUnwantedContent(root, baseURL) {
    const selectors = [
      "script", "style", "noscript", "iframe", "object", "embed", "applet", "nav", "aside", "base", "link", "meta[http-equiv]",
      "header[role=banner]", "footer[role=contentinfo]", ".site-header", ".site-footer",
      ".page-header", ".page-footer", ".global-header", ".global-footer",
      "button", "form", "input", "select", "textarea", "dialog", "[role=navigation]",
      "[role=complementary]", "[aria-label*=advert i]", "[class*=advert i]", "[id*=advert i]",
      "[class*=cookie i]", "[id*=cookie i]", "[class*=recommend i]", "[id*=recommend i]",
      "[class*=related-article i]", "[class*=social-share i]", "[class*=author-list i]",
      "[class*=contrib-group i]", "[class*=article-authors i]", "[class*=breadcrumb i]",
      "[class*=toolbar i]", "[class*=metrics i]", "[class*=citation i]",
    ].join(",");
    for (const element of Array.from(root.querySelectorAll(selectors))) element.remove();
    cleanSectionTail(root);
    sanitizeInlineSVG(root);
    for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
      const tag = element.localName.toLowerCase();
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (/^on/i.test(name) || name === "xlink:href") {
          element.removeAttributeNode(attribute);
          continue;
        }
        if (name === "style") {
          element.setAttribute("style", sanitizeCSS(attribute.value));
          continue;
        }
        if ((name === "src" || name === "poster") && !["img"].includes(tag)) {
          element.removeAttributeNode(attribute);
          continue;
        }
        if (name === "href" && tag !== "a" && tag !== "svg" && !/^(?:#[A-Za-z0-9_.:-]+|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i.test(attribute.value)) {
          element.removeAttributeNode(attribute);
        }
      }
      if (tag === "video" || tag === "audio") {
        for (const source of Array.from(element.querySelectorAll("source,track"))) source.remove();
      }
      if (tag === "a") {
        const href = element.getAttribute("href");
        if (href) {
          try {
            const absolute = new URL(href, baseURL);
            if (["http:", "https:", "mailto:"].includes(absolute.protocol) && !absolute.username && !absolute.password) {
              element.setAttribute("href", absolute.href);
            } else {
              element.removeAttribute("href");
            }
          } catch (error) {
            element.removeAttribute("href");
          }
        }
        element.removeAttribute("target");
        element.removeAttribute("onclick");
        element.removeAttribute("ping");
      }
    }
  }

  function selectImageURL(image, baseURL) {
    const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
    const candidates = srcset.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const pieces = part.split(/\s+/);
      const descriptor = pieces[1] || "1x";
      const amount = parseFloat(descriptor) || 1;
      return { url: pieces[0], score: descriptor.endsWith("w") ? amount / 1000 : amount };
    }).sort((a, b) => b.score - a.score);
    const candidate = candidates[0]?.url || image.currentSrc || image.getAttribute("src") ||
      image.getAttribute("data-src") || image.getAttribute("data-original") || image.getAttribute("data-lazy-src");
    if (!candidate) return "";
    if (candidate.startsWith("data:")) return candidate;
    return AutoFullText.validateResourceURL(candidate, baseURL);
  }

  function base64FromBytes(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function sanitizeSVGDocument(doc) {
    if (doc.querySelector("parsererror") || !doc.documentElement || doc.documentElement.localName.toLowerCase() !== "svg") {
      throw new Error("Invalid SVG image.");
    }
    for (const element of Array.from(doc.querySelectorAll("script,style,foreignObject,iframe,object,embed,animate,animateMotion,animateTransform,set,discard"))) element.remove();
    const elements = [doc.documentElement, ...Array.from(doc.querySelectorAll("*"))];
    for (const element of elements) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = String(attribute.value || "").trim();
        if (/^on/i.test(name)) {
          element.removeAttributeNode(attribute);
          continue;
        }
        if (name === "href" || name === "xlink:href") {
          if (!/^#[A-Za-z0-9_.:-]+$/.test(value)) element.removeAttributeNode(attribute);
          continue;
        }
        if (/(?:url\s*\(|@import|expression\s*\(|behavior\s*:)/i.test(value)) {
          if (!/^url\(\s*#[A-Za-z0-9_.:-]+\s*\)$/i.test(value)) element.removeAttributeNode(attribute);
        }
      }
    }
    return doc.documentElement;
  }

  function sanitizeSVG(bytes) {
    const source = new TextDecoder("utf-8").decode(bytes);
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    return new TextEncoder().encode(new XMLSerializer().serializeToString(sanitizeSVGDocument(doc)));
  }

  function bytesFromDataURI(url) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp|avif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i.exec(url);
    if (!match) throw new Error("Only base64-encoded raster or SVG data images are supported.");
    const estimate = Math.floor(match[2].length * 0.75);
    if (estimate > imageLimits.one) throw new Error("A data image exceeds the 12 MB per-image limit.");
    const binary = atob(match[2]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (!bytes.length || bytes.length > imageLimits.one) throw new Error("A data image exceeds the 12 MB per-image limit.");
    return { bytes, mime: match[1].toLowerCase() };
  }

  async function inlineImages(root, baseURL, workspace, signal) {
    const images = Array.from(root.querySelectorAll("img"));
    if (images.length > imageLimits.count) throw new Error("The article contains too many images to safely export.");
    let totalBytes = 0;
    let inFlightBytes = 0;
    let next = 0;
    let failure = null;
    const controller = new AbortController();
    const cancelOnAbort = () => controller.abort();
    signal?.addEventListener("abort", cancelOnAbort, { once: true });

    const persistDataImage = async (image, candidate) => {
      const { bytes, mime } = bytesFromDataURI(candidate);
      if (totalBytes + inFlightBytes + bytes.length > imageLimits.all) {
        throw new Error("Article images exceed the 40 MB export limit.");
      }
      totalBytes += bytes.length;
      const finalBytes = mime === "image/svg+xml" ? sanitizeSVG(bytes) : bytes;
      image.setAttribute("src", `data:${mime};base64,${base64FromBytes(finalBytes)}`);
      image.removeAttribute("srcset");
      image.removeAttribute("data-srcset");
      image.removeAttribute("data-src");
      image.removeAttribute("data-original");
      image.removeAttribute("data-lazy-src");
    };

    const downloadImage = async (image, initialURL) => {
      let url = AutoFullText.validateResourceURL(initialURL, baseURL);
      const visited = new Set();
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        if (signal?.aborted || controller.signal.aborted) throw new Error("Image download cancelled.");
        if (visited.has(url)) throw new Error("Image redirect loop detected.");
        visited.add(url);

        let observedBytes = 0;
        let oversized = false;
        let cancelRequest = null;
        const combinedSignal = controller.signal;
        const abort = () => cancelRequest?.();
        combinedSignal.addEventListener("abort", abort, { once: true });
        signal?.addEventListener("abort", abort, { once: true });
        let response;
        try {
          response = await Zotero.HTTP.request("GET", url, {
            responseType: "arraybuffer",
            timeout: 30000,
            errorDelayMax: 0,
            anon: true,
            followRedirects: false,
            headers: { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
            requestObserver(xhr) {
              const cancelOversized = (message) => {
                oversized = true;
                failure = new Error(message);
                controller.abort();
                cancelRequest?.();
              };
              xhr.addEventListener("readystatechange", () => {
                if (xhr.readyState < 2) return;
                const contentLength = Number.parseInt(xhr.getResponseHeader("Content-Length") || "0", 10) || 0;
                if (contentLength > imageLimits.one) cancelOversized("An image exceeds the 12 MB per-image limit.");
                else if (totalBytes + inFlightBytes + contentLength > imageLimits.all) cancelOversized("Article images exceed the 40 MB export limit.");
              });
              xhr.addEventListener("progress", (event) => {
                const current = Number(event.loaded || 0);
                const delta = Math.max(0, current - observedBytes);
                observedBytes = current;
                inFlightBytes += delta;
                if (observedBytes > imageLimits.one || Number(event.total || 0) > imageLimits.one) {
                  cancelOversized("An image exceeds the 12 MB per-image limit.");
                } else if (totalBytes + inFlightBytes > imageLimits.all || totalBytes + Number(event.total || 0) > imageLimits.all) {
                  cancelOversized("Article images exceed the 40 MB export limit.");
                }
              });
            },
            cancellerReceiver(canceller) {
              cancelRequest = canceller;
              if (signal?.aborted || controller.signal.aborted) cancelRequest?.();
            },
          });
        } catch (error) {
          if (observedBytes) inFlightBytes = Math.max(0, inFlightBytes - observedBytes);
          if (oversized) throw failure;
          if (signal?.aborted || controller.signal.aborted) {
            const cancelled = new Error("Image download cancelled.");
            cancelled.name = "AbortError";
            throw cancelled;
          }
          throw error;
        } finally {
          combinedSignal.removeEventListener("abort", abort);
          signal?.removeEventListener("abort", abort);
        }

        if (observedBytes) inFlightBytes = Math.max(0, inFlightBytes - observedBytes);
        if (signal?.aborted || controller.signal.aborted) {
          const cancelled = new Error("Image download cancelled.");
          cancelled.name = "AbortError";
          throw cancelled;
        }
        const status = Number(response.status || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirects === 5) throw new Error("Image exceeded the redirect limit.");
          const location = response.getResponseHeader("Location");
          if (!location) throw new Error(`Image redirect ${status} has no Location header.`);
          url = AutoFullText.validateRedirectURL(new URL(location, url).href, url, baseURL);
          continue;
        }
        if (status < 200 || status >= 300) throw new Error(`Image returned HTTP ${status}.`);
        if (response.responseURL) AutoFullText.validateResourceURL(response.responseURL, baseURL);
        const buffer = response.response;
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || new ArrayBuffer(0));
        if (!bytes.length || bytes.length > imageLimits.one) throw new Error("Image size is invalid or exceeds 12 MB.");
        if (totalBytes + bytes.length > imageLimits.all) throw new Error("Article images exceed the 40 MB export limit.");
        totalBytes += bytes.length;
        let mime = String(response.getResponseHeader("Content-Type") || "").split(";")[0].trim().toLowerCase();
        if (mime === "image/svg+xml" || new URL(url).pathname.toLowerCase().endsWith(".svg")) {
          mime = "image/svg+xml";
        } else if (!/^image\/(?:png|jpeg|gif|webp|avif)$/.test(mime)) {
          throw new Error(`Unexpected or unsupported image response type ${mime || "(missing)"}.`);
        }
        const finalBytes = mime === "image/svg+xml" ? sanitizeSVG(bytes) : bytes;
        image.setAttribute("src", `data:${mime};base64,${base64FromBytes(finalBytes)}`);
        image.removeAttribute("srcset");
        image.removeAttribute("data-srcset");
        image.removeAttribute("data-src");
        image.removeAttribute("data-original");
        image.removeAttribute("data-lazy-src");
        image.removeAttribute("loading");
        return;
      }
      throw new Error("Image download did not complete.");
    };

    const worker = async () => {
      while (!failure && !signal?.aborted && !controller.signal.aborted) {
        const image = images[next++];
        if (!image) return;
        try {
          const candidate = selectImageURL(image, baseURL);
          if (!candidate) {
            throw new Error("An article image has no safe, usable HTTPS source; refusing to export a document with a missing figure.");
          }
          if (candidate.startsWith("data:")) await persistDataImage(image, candidate);
          else await downloadImage(image, candidate);
        } catch (error) {
          if (!failure) failure = error;
          controller.abort();
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(3, images.length) }, () => worker()));
      if (signal?.aborted) {
        const cancelled = new Error("Image processing cancelled.");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      if (failure) throw failure;
    } finally {
      signal?.removeEventListener("abort", cancelOnAbort);
    }
    for (const source of Array.from(root.querySelectorAll("picture source"))) source.remove();
  }

  function preserveNode(element) {
    const name = element.localName.toLowerCase();
    return ["math", "svg", "img", "picture", "video", "canvas", "pre", "code"].includes(name) ||
      element.matches("mjx-container,.MathJax,.math,.equation,[role=math],.katex");
  }

  function makeOpaqueToken(index) {
    return `ZAFORMAT${String(index).padStart(5, "0")}TOKEN`;
  }

  function encodeInline(element, baseURL) {
    const tokens = [];
    let raw = "";
    const token = (entry) => {
      entry.value = makeOpaqueToken(tokens.length + 1);
      tokens.push(entry);
      raw += entry.value;
    };
    const visit = (node) => {
      if (node.nodeType === 3) {
        raw += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== 1) return;
      if (preserveNode(node)) {
        token({ kind: "node", html: node.outerHTML });
        return;
      }
      const tag = node.localName.toLowerCase();
      if (tag === "br") {
        token({ kind: "node", html: "<br>" });
        return;
      }
      const keep = tag === "a" || [
        "strong", "b", "em", "i", "u", "s", "sup", "sub", "span", "mark",
        "abbr", "small", "cite", "q", "dfn", "time", "del", "ins", "ruby",
        "rt", "rp", "bdi", "bdo", "code", "samp", "kbd", "var",
      ].includes(tag);
      if (keep) {
        const attributes = {};
        for (const attr of Array.from(node.attributes)) {
          if (/^on/i.test(attr.name)) continue;
          if (tag === "a" && attr.name === "href") {
            try {
              const href = new URL(attr.value, baseURL);
              if (["http:", "https:", "mailto:"].includes(href.protocol)) attributes.href = href.href;
            } catch (error) {}
          } else if ([
            "title", "class", "id", "aria-label", "lang", "dir", "style",
            "datetime", "rel",
          ].includes(attr.name)) {
            attributes[attr.name] = attr.value;
          }
        }
        token({ kind: "open", tag, attributes });
      }
      for (const child of Array.from(node.childNodes)) visit(child);
      if (keep) token({ kind: "close", tag });
    };
    for (const child of Array.from(element.childNodes)) visit(child);
    return { raw: raw.replace(/\s+/g, " ").trim(), tokens };
  }

  function restoreInline(output, tokens, doc) {
    const found = output.match(tokenPattern) || [];
    const expected = tokens.map((entry) => entry.value);
    if (found.length !== expected.length || found.some((value, index) => value !== expected[index])) {
      throw new Error("The translation changed formula, image, or link protection markers; this section was not exported.");
    }
    const map = new Map(tokens.map((entry) => [entry.value, entry]));
    const fragment = doc.createDocumentFragment();
    const stack = [{ parent: fragment, element: null }];
    let cursor = 0;
    for (const marker of found) {
      const position = output.indexOf(marker, cursor);
      if (position > cursor) stack[stack.length - 1].parent.appendChild(doc.createTextNode(output.slice(cursor, position)));
      const entry = map.get(marker);
      if (!entry) throw new Error("Unknown protected-content marker returned by translation.");
      if (entry.kind === "node") {
        const template = doc.createElement("template");
        template.innerHTML = entry.html;
        stack[stack.length - 1].parent.appendChild(template.content.cloneNode(true));
      } else if (entry.kind === "open") {
        const element = doc.createElement(entry.tag);
        for (const [name, value] of Object.entries(entry.attributes)) element.setAttribute(name, value);
        stack[stack.length - 1].parent.appendChild(element);
        stack.push({ parent: element, element });
      } else {
        if (stack.length < 2 || stack[stack.length - 1].element.localName.toLowerCase() !== entry.tag) {
          throw new Error("The translation changed inline markup order.");
        }
        stack.pop();
      }
      cursor = position + marker.length;
    }
    if (cursor < output.length) stack[stack.length - 1].parent.appendChild(doc.createTextNode(output.slice(cursor)));
    if (stack.length !== 1) throw new Error("The translation left a protected inline tag unclosed.");
    return fragment;
  }

  function getBlocks(root) {
    const explicit = Array.from(root.querySelectorAll(blockSelector)).filter((block) => {
      const nested = block.parentElement?.closest(blockSelector);
      return !nested && textLength(block) > 0;
    });
    const containers = Array.from(root.querySelectorAll("article,section,main,address,div,blockquote")).filter((block) =>
      !block.querySelector(blockSelector) &&
      !block.querySelector("article,section,main,address,div,blockquote") &&
      textLength(block) > 0,
    );
    return [...explicit, ...containers].sort((left, right) =>
      left.compareDocumentPosition(right) & 4 ? -1 : 1,
    );
  }

  function splitTranslationText(text, limit = maxTranslationChars) {
    const chunks = [];
    const safeLimit = Math.max(1, Math.floor(Number(limit) || maxTranslationChars));
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + safeLimit);
      if (end < text.length) {
        const slice = text.slice(offset, end);
        const naturalEnds = [
          slice.lastIndexOf(String.fromCharCode(10)),
          slice.lastIndexOf(". ") + 1,
          slice.lastIndexOf("。") + 1,
          slice.lastIndexOf(" "),
        ].filter((position) => position > safeLimit * 0.4);
        if (naturalEnds.length) end = offset + Math.max(...naturalEnds);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;

        const markerStart = text.lastIndexOf("ZAFORMAT", end - 1);
        if (markerStart >= offset && markerStart + 18 > end) {
          end = markerStart > offset ? markerStart : markerStart + 18;
        }
      }
      if (end <= offset) end = Math.min(text.length, offset + safeLimit);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
      let next = end;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      chunks.push({ text: text.slice(offset, end), separator: text.slice(end, next) });
      offset = next > offset ? next : end;
    }
    return chunks;
  }

  async function mapConcurrentOrdered(items, worker, concurrency = 2, outerSignal = null) {
    const results = new Array(items.length);
    const count = Math.min(items.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
    const controller = new AbortController();
    let cursor = 0;
    let failure = null;
    const abortAll = () => {
      if (!failure) {
        failure = Object.assign(new Error("Translation cancelled."), { name: "AbortError" });
      }
      controller.abort();
    };
    outerSignal?.addEventListener("abort", abortAll, { once: true });
    if (outerSignal?.aborted) abortAll();
    const runWorker = async () => {
      while (!failure && !controller.signal.aborted) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await worker(items[index], index, controller.signal);
        } catch (error) {
          if (!failure) {
            failure = error || new Error("A concurrent translation task failed.");
            controller.abort();
          }
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: count }, () => runWorker()));
    } finally {
      outerSignal?.removeEventListener("abort", abortAll);
    }
    if (failure) throw failure;
    return results;
  }

  function validateSegmentMarkers(output, source) {
    const found = output.match(tokenPattern) || [];
    const expected = source.match(tokenPattern) || [];
    if (found.length !== expected.length || found.some((value, index) => value !== expected[index])) {
      throw new Error("The translation changed formula, image, or link protection markers; this section was not exported.");
    }
  }

  function assertChineseTranslation(source, translated) {
    const sourceText = source.replace(tokenPattern, "").trim();
    const translatedText = String(translated || "").replace(tokenPattern, "").trim();
    if (!translatedText) throw new Error("The translation engine returned an empty paragraph.");
    const sourceLetters = sourceText.match(/[\p{L}\p{M}]/gu) || [];
    if (!sourceLetters.length) return;
    const identifierOnly = /^(?:[A-Z][A-Z0-9+._-]{1,15}|[A-Za-z]+\d+[A-Za-z0-9+._-]{0,10})$/.test(sourceText);
    const requiresChinese = !identifierOnly && (
      /[\u3400-\u4dbf\u4e00-\u9fff]/.test(sourceText) ||
      /[\p{L}\p{M}]{2,}/u.test(sourceText)
    );

    const hasHan = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(translatedText);
    if (requiresChinese && !hasHan) throw new Error("A text-bearing paragraph was not translated into Chinese; refusing to export the document.");
    if (/[\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/.test(translatedText)) {
      throw new Error("A paragraph contains Japanese kana or Korean Hangul instead of a Chinese-only translation.");
    }
    if (/[體檔處學電轉產鍵國語時會來為開發經過現實與對應無從點線質間數據專訊網頁應用環境這裏裏面後發說讀寫業論資料庫軟體品質標準設計運行結果測試範圍問題過程]/.test(translatedText)) {
      throw new Error("Translation response appears to be Traditional Chinese; target must be Simplified Chinese.");
    }
    const normalizedSource = sourceText.replace(/\s+/g, " ").toLowerCase();
    const normalizedTranslation = translatedText.replace(/\s+/g, " ").toLowerCase();
    if (requiresChinese && /[a-z]{2,}/i.test(sourceText) && normalizedTranslation.includes(normalizedSource)) {
      throw new Error("The translation contains the unchanged source paragraph; refusing to export the document.");
    }
    if (sourceLetters.length >= 40 && translatedText.replace(/[\s\p{P}\p{S}]/gu, "").length < Math.max(6, sourceLetters.length * 0.18)) {
      throw new Error("The translated paragraph is unusually short compared with its source; possible truncation or summary detected.");
    }
  }

  function emitProgress(onProgress, stage, percent) {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ stage, percent });
    } catch {
      // Ignore UI progress callback failures.
    }
  }

  async function translateBlocks(root, baseURL, provider, item, systemPrompt, workspace, signal, onProgress = null) {
    const records = [];
    const jobs = [];
    for (const block of getBlocks(root)) {
      const encoded = encodeInline(block, baseURL);
      const sourceText = encoded.raw.replace(tokenPattern, "").trim();
      if (!sourceText) continue;
      const parts = splitTranslationText(encoded.raw);
      if (parts.length > maxSegmentsPerBlock) {
        throw new Error("A paragraph is too long to translate safely; split it into shorter paragraphs first.");
      }
      const record = { block, encoded, sourceText, parts, translations: new Array(parts.length) };
      records.push(record);
      parts.forEach((part, partIndex) => jobs.push({ record, part, partIndex }));
      if (jobs.length > maxTranslationSegments) {
        throw new Error(`Article translation exceeds the ${maxTranslationSegments}-segment safety limit; refusing to export a partial translation.`);
      }
    }
    if (!records.length || !jobs.length) {
      throw new Error("No translatable article paragraphs were found; refusing to export an empty translation.");
    }
    emitProgress(onProgress, `正在翻译正文（0/${jobs.length} 片，共 ${records.length} 段）…`, 34);

    const progressDirectory = workspace.file("translation-segments");
    await OS.File.makeDir(progressDirectory);
    let completedSegments = 0;
    let batchEntries = [];
    let progressWrite = Promise.resolve();
    const persistProgress = (status, error = "") => {
      const snapshot = JSON.stringify({
        status,
        totalParagraphs: records.length,
        totalSegments: jobs.length,
        completedSegments,
        error,
        segmentDirectory: "translation-segments/",
      }, null, 2);
      progressWrite = progressWrite.catch(() => {}).then(() => workspace.writeText("translation-progress.json", snapshot));
      return progressWrite;
    };
    let results;
    try {
      results = await mapConcurrentOrdered(jobs, async ({ record, part, partIndex }, jobIndex, signal) => {
        const requestPrompt = jobIndex === 0
          ? systemPrompt
          : AutoFullTextTranslator.getSystemPrompt(item, { includeAbstract: false });
        const translated = await AutoFullTextTranslator.translate(
          part.text,
          provider,
          item,
          signal,
          requestPrompt,
          jobIndex === 0,
        );
        validateSegmentMarkers(translated, part.text);
        assertChineseTranslation(part.text, translated);
        const progressEntry = {
          paragraph: records.indexOf(record) + 1,
          segment: partIndex + 1,
          source: part.text,
          translation: translated,
        };
        batchEntries.push(progressEntry);
        completedSegments += 1;
        const percent = 35 + Math.round((completedSegments / jobs.length) * 50);
        emitProgress(
          onProgress,
          `正在翻译正文（已完成 ${completedSegments}/${jobs.length} 片，共 ${records.length} 段）…`,
          percent,
        );
        if (completedSegments % 20 === 0 || completedSegments === jobs.length) {
          const batchIndex = Math.ceil(completedSegments / 20).toString().padStart(4, "0");
          await workspace.writeText(`translation-segments/batch-${batchIndex}.json`, JSON.stringify(batchEntries));
          batchEntries = [];
          await persistProgress("translating");
        }
        return translated;
      }, 2, signal);
    } catch (error) {
      try {
        if (batchEntries.length) {
          const batchIndex = Math.ceil(completedSegments / 20).toString().padStart(4, "0");
          await workspace.writeText(`translation-segments/batch-${batchIndex}.json`, JSON.stringify(batchEntries));
          batchEntries = [];
        }
        await persistProgress("failed", String(error?.message || error));
      } catch (saveError) {
        AutoFullText.log(`Could not persist partial translation progress at ${workspace.path}`, saveError);
      }
      throw error;
    }

    if (results.length !== jobs.length || results.some((result) => typeof result !== "string" || !result.trim())) {
      throw new Error("One or more article paragraphs have no completed translation; refusing to export.");
    }
    jobs.forEach(({ record, partIndex }, index) => {
      record.translations[partIndex] = results[index];
    });

    emitProgress(onProgress, "正在校验并拼装中文译文…", 88);
    let translatedParagraphs = 0;
    try {
      for (const record of records) {
        if (record.translations.length !== record.parts.length || record.translations.some((part) => typeof part !== "string" || !part.trim())) {
          throw new Error(`Paragraph ${translatedParagraphs + 1} has missing translation segments; refusing to export.`);
        }
        const translated = record.translations.map((part, index) =>
          `${part}${record.parts[index].separator}`,
        ).join("");
        assertChineseTranslation(record.encoded.raw, translated);
        record.block.replaceChildren(restoreInline(translated, record.encoded.tokens, record.block.ownerDocument));
        translatedParagraphs += 1;
      }
      if (translatedParagraphs !== records.length) {
        throw new Error(`Only ${translatedParagraphs} of ${records.length} article paragraphs were translated.`);
      }
    } catch (error) {
      try {
        await persistProgress("failed", String(error?.message || error));
      } catch (saveError) {
        AutoFullText.log(`Could not save paragraph validation failure at ${workspace.path}`, saveError);
      }
      throw error;
    }
    await persistProgress("complete");
    return { translatedParagraphs, translatedSegments: results.length };
  }

  function normalizeMathMarkup(root) {
    for (const element of Array.from(root.querySelectorAll("mjx-container"))) {
      const svg = element.querySelector("svg");
      const math = element.querySelector("math");
      const replacement = svg || math;
      if (replacement) element.replaceWith(replacement.cloneNode(true));
    }
    for (const element of Array.from(root.querySelectorAll(".katex"))) {
      const math = element.querySelector(".katex-mathml math") || element.querySelector("math");
      if (math) element.replaceWith(math.cloneNode(true));
    }
  }

  function captureCanvas(originalRoot, clonedRoot) {
    for (const element of Array.from(originalRoot.querySelectorAll("canvas"))) {
      if (element.width * element.height * 4 > imageLimits.one) {
        throw new Error("A canvas figure exceeds the 12 MB uncompressed pixel budget.");
      }
    }
    const original = Array.from(originalRoot.querySelectorAll("canvas"));
    const cloned = Array.from(clonedRoot.querySelectorAll("canvas"));
    if (cloned.length + clonedRoot.querySelectorAll("img").length > imageLimits.count) {
      throw new Error("The article contains too many images and canvases to safely export.");
    }
    let totalBytes = 0;
    for (let index = 0; index < cloned.length; index += 1) {
      const sourceCanvas = original[index];
      const targetCanvas = cloned[index];
      if (!sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) {
        targetCanvas.remove();
        continue;
      }
      let dataURL;
      try {
        dataURL = sourceCanvas.toDataURL("image/png");
      } catch (error) {
        throw new Error("A protected canvas could not be captured; refusing to export an incomplete figure.");
      }
      const bytes = Math.floor((dataURL.length - dataURL.indexOf(",") - 1) * 0.75);
      if (bytes > imageLimits.one) throw new Error("A canvas figure exceeds the 12 MB export limit.");
      totalBytes += bytes;
      if (totalBytes > imageLimits.all) throw new Error("Article canvases exceed the 40 MB export limit.");
      const image = clonedRoot.ownerDocument.createElement("img");
      image.src = dataURL;
      image.alt = sourceCanvas.getAttribute("aria-label") || sourceCanvas.getAttribute("title") || "";
      image.width = sourceCanvas.width;
      image.height = sourceCanvas.height;
      targetCanvas.replaceWith(image);
    }
  }

  function wrapWithAncestors(sourceRoot, doc) {
    let content;
    if (sourceRoot === doc.body) {
      content = doc.createElement("div");
      for (const child of Array.from(doc.body.childNodes)) content.appendChild(child.cloneNode(true));
    } else {
      content = sourceRoot.cloneNode(true);
    }
    let ancestor = sourceRoot === doc.body ? null : sourceRoot.parentElement;
    while (ancestor && ancestor !== doc.body && ancestor !== doc.documentElement) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.appendChild(content);
      content = wrapper;
      ancestor = ancestor.parentElement;
    }
    return content;
  }

  async function capturePageStyles(doc, baseURL, signal) {
    const entries = [];
    const styleNodes = Array.from(doc.querySelectorAll("link[rel~=stylesheet][href],style")).slice(0, 24);
    for (const node of styleNodes) {
      if (signal?.aborted) throw Object.assign(new Error("Style capture cancelled."), { name: "AbortError" });
      const media = node.getAttribute("media") || "";
      if (node.localName.toLowerCase() === "style") {
        entries.push({ text: sanitizeCSS(node.textContent || ""), media });
        continue;
      }
      try {
        entries.push({ href: AutoFullText.validateResourceURL(node.getAttribute("href"), baseURL), media });
      } catch (error) {
        AutoFullText.log("Ignored an untrusted publisher stylesheet URL", error);
      }
    }

    const loadedStyles = await mapConcurrentOrdered(entries, async (entry) => {
      if (!entry.href) return entry;
      try {
        const response = await AutoFullText.fetchTextResource(entry.href, {
          baseURL,
          signal,
          headers: { Accept: "text/css,*/*;q=0.1" },
          maxBytes: 2 * 1024 * 1024,
        });
        if (response.contentType && !/^text\/css(?:\s*;|$)/i.test(response.contentType)) {
          throw new Error(`Stylesheet URL returned ${response.contentType}, not CSS.`);
        }
        return { text: sanitizeCSS(response.text), media: entry.media };
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        AutoFullText.log("Ignored an unavailable publisher stylesheet", error);
        return null;
      }
    }, 3, signal);
    const styles = loadedStyles.filter(Boolean);
    const totalBytes = styles.reduce((size, style) => size + style.text.length * 2, 0);
    if (totalBytes > 8 * 1024 * 1024) throw new Error("Publisher stylesheets exceed the 8 MB export limit.");

    const bodyAttributes = {};
    for (const attribute of Array.from(doc.body.attributes)) {
      if (["class", "id", "lang", "dir"].includes(attribute.name) && !/^on/i.test(attribute.name)) {
        bodyAttributes[attribute.name] = attribute.value;
      } else if (attribute.name === "style") {
        bodyAttributes.style = sanitizeCSS(attribute.value);
      }
    }
    return { styles, bodyAttributes };
  }

  async function snapshotArticle(url, workspace, signal, onProgress = null) {
    const { doc, responseURL } = await AutoFullText.fetchDocument(url, {
      signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
      maxBytes: 30 * 1024 * 1024,
      onRawText: (text) => workspace.writeText("article-page-original.html", text),
    });
    emitProgress(onProgress, "正在清洗正文并捕获页面样式…", 18);
    const sourceRoot = chooseArticleRoot(doc);
    const pageStyles = await capturePageStyles(doc, responseURL, signal);
    const root = wrapWithAncestors(sourceRoot, doc);
    captureCanvas(sourceRoot, root);
    normalizeMathMarkup(root);
    removeUnwantedContent(root, responseURL);
    return { html: root.outerHTML, responseURL, ...pageStyles };
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("Full-text translation cancelled.");
    error.name = "AbortError";
    throw error;
  }

  async function create(item, signal = null, { onProgress = null } = {}) {
    const url = AutoFullText.itemURL(item);
    if (!url) throw new Error("This item has neither a webpage URL nor DOI.");
    const workspace = await AutoFullTextPdf.createWorkspace();
    const runInfo = {
      itemKey: String(item.key || ""),
      itemID: item.id,
      articleURL: url,
      startedAt: new Date().toISOString(),
      stage: "created",
    };

    try {
      throwIfAborted(signal);
      emitProgress(onProgress, "正在读取并解析文章网页…", 8);
      await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));
      const snapshot = await snapshotArticle(url, workspace, signal, onProgress);
      throwIfAborted(signal);
      await workspace.writeText("article-page-cleaned.html", snapshot.html);
      runInfo.stage = "article page saved";
      await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));

      const doc = new DOMParser().parseFromString(snapshot.html, "text/html");
      const root = doc.body.firstElementChild;
      if (!root || textLength(root) < 500) throw new Error("The cleaned article body is too short to translate.");

      emitProgress(onProgress, "正在内联文章图片资源…", 26);
      await inlineImages(root, snapshot.responseURL, workspace, signal);
      throwIfAborted(signal);
      await workspace.writeText("article-page-assets-inlined.html", root.outerHTML);
      const provider = AutoFullTextTranslator.getActiveProvider();
      const systemPrompt = AutoFullTextTranslator.getSystemPrompt(item);
      runInfo.provider = provider.name;
      runInfo.model = provider.model;
      runInfo.stage = "translating";
      await workspace.writeText("translation-system-prompt.txt", systemPrompt);
      await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));

      const progress = await translateBlocks(root, snapshot.responseURL, provider, item, systemPrompt, workspace, signal, onProgress);
      throwIfAborted(signal);
      runInfo.translatedParagraphs = progress.translatedParagraphs;
      runInfo.translatedSegments = progress.translatedSegments;
      runInfo.stage = "all paragraphs translated and validated";
      const html = AutoFullTextPdf.makeWebsitePdfPage(
        root.outerHTML,
        snapshot.responseURL,
        "全文翻译",
        snapshot.styles,
        snapshot.bodyAttributes,
      );
      await workspace.writeText("translation-final.html", html);
      runInfo.stage = "printing PDF";
      await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));
      throwIfAborted(signal);
      emitProgress(onProgress, "正在排版并导出「全文翻译」PDF…", 92);
      const pdfPath = workspace.file("full-text-translation.pdf");
      await AutoFullTextPdf.printHtmlToPdf(html, pdfPath, workspace, signal);
      throwIfAborted(signal);
      runInfo.stage = "PDF generated";
      await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));
      throwIfAborted(signal);
      emitProgress(onProgress, "正在导入「全文翻译」Zotero 子附件…", 97);
      await AutoFullTextPdf.attachPdf(item.id, pdfPath, "全文翻译");
      emitProgress(onProgress, "「全文翻译」PDF 附件已导入。", 100);
      runInfo.stage = "attachment imported";
      try {
        await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));
      } catch (saveError) {
        AutoFullText.log(`Could not update run metadata after attachment import at ${workspace.path}`, saveError);
      }
    } catch (error) {
      const detail = String(error?.message || error);
      if (signal?.aborted) {
        runInfo.stage = "cancelled";
        runInfo.error = detail;
        try {
          await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));
        } catch (saveError) {
          AutoFullText.log(`Could not record cancellation at ${workspace.path}`, saveError);
        }
        try {
          await workspace.cleanup();
        } catch (cleanupError) {
          AutoFullText.log(`Cancelled translation workspace could not be cleaned at ${workspace.path}`, cleanupError);
        }
        const cancelled = new Error("Full-text translation cancelled.");
        cancelled.name = "AbortError";
        throw cancelled;
      }
      runInfo.stage = "failed";
      runInfo.error = detail;
      try {
        await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));
        await workspace.writeText("translation-error.txt", detail);
      } catch (saveError) {
        AutoFullText.log(`Could not save failure details at ${workspace.path}`, saveError);
      }
      AutoFullText.log(`Translation stopped; intermediate files retained at ${workspace.path}`, error);
      const reported = new Error(`${detail}\n中间文件已保留在：${workspace.path}`);
      reported.name = error?.name || "TranslationError";
      reported.cause = error;
      throw reported;
    }

    try {
      await workspace.cleanup();
    } catch (error) {
      AutoFullText.log(`Translation attached successfully, but intermediate files could not be removed from ${workspace.path}`, error);
    }
    return { translatedParagraphs: runInfo.translatedParagraphs, translatedSegments: runInfo.translatedSegments };
  }

  return {
    create,
    splitTranslationText,
    mapConcurrentOrdered,
    normalizedHeading,
    isStopHeading,
    assertChineseTranslation,
    sanitizeCSS,
    validateSegmentMarkers,
  };
})();
