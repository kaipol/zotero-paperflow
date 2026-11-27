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
    return (element?.textContent || "").trim().length;
  }

  function isChallengeHTML(html) {
    if (typeof AutoFullTextSupportingInfo !== "undefined" && typeof AutoFullTextSupportingInfo?.isChallengeHTML === "function") {
      return Boolean(AutoFullTextSupportingInfo.isChallengeHTML(html));
    }
    const text = String(html || "").slice(0, 65536);
    if (!text) return false;
    return /just a moment|attention required|checking your browser|one more step|verify you are human|security check|ddos-guard|请稍候|正在检查|安全验证/i.test(text) ||
      /Enable JavaScript and cookies to continue|Checking if the site connection is secure/i.test(text) ||
      (/\/cdn-cgi\/challenge-platform\//i.test(text) && /(?:\b_cf_chl_opt\b|challenge-error-text|cf-browser-verification|managed_checking_msg)/i.test(text));
  }

  function isChallengeDocument(doc, currentURL) {
    if (typeof AutoFullTextSupportingInfo !== "undefined" && typeof AutoFullTextSupportingInfo?.isChallengeDocument === "function") {
      return Boolean(AutoFullTextSupportingInfo.isChallengeDocument(doc, currentURL));
    }
    if (!doc || !doc.documentElement) return true;
    return isChallengeHTML(String(doc.documentElement.outerHTML || ""));
  }

  function extractResponseInfo(responseOrError) {
    if (!responseOrError) return { status: 0, cfMitigated: "", server: "", bodyPrefix: "" };
    const xhr = responseOrError.xmlhttp || responseOrError;
    const status = Number(responseOrError.status ?? xhr?.status ?? 0) || 0;
    const getHeader = (name) => {
      try {
        if (typeof xhr?.getResponseHeader === "function") return String(xhr.getResponseHeader(name) || "");
      } catch {}
      try {
        if (typeof responseOrError.getResponseHeader === "function") return String(responseOrError.getResponseHeader(name) || "");
      } catch {}
      return "";
    };
    let bodyPrefix = "";
    try {
      const raw = responseOrError.responseText ?? xhr?.responseText ?? xhr?.response ?? "";
      if (typeof raw === "string") bodyPrefix = raw.slice(0, 16384);
    } catch {}
    return {
      status,
      cfMitigated: getHeader("cf-mitigated").trim().toLowerCase(),
      server: getHeader("server").trim().toLowerCase(),
      bodyPrefix,
    };
  }

  function isChallengeHTTP(error, info = null) {
    const resolved = info || extractResponseInfo(error);
    const status = resolved.status || Number(String(error?.message || "").match(/\bHTTP(?: resource returned)? status (\d{3})\b/i)?.[1] || 0);
    if (resolved.cfMitigated === "challenge") return true;
    if (status === 403) return true;
    if (status === 503 && (resolved.server.includes("cloudflare") || isChallengeHTML(resolved.bodyPrefix))) return true;
    if (resolved.bodyPrefix && isChallengeHTML(resolved.bodyPrefix)) return true;
    return false;
  }

  function combineSignals(primary, secondary) {
    if (!primary) return secondary || null;
    if (!secondary) return primary;
    if (typeof AbortController !== "function") return primary;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (primary.aborted || secondary.aborted) {
      controller.abort();
      return controller.signal;
    }
    primary.addEventListener("abort", abort, { once: true });
    secondary.addEventListener("abort", abort, { once: true });
    return controller.signal;
  }

  const IGNORED_TEXT_TAGS = new Set(["script", "style", "noscript", "template", "svg"]);
  const ARTICLE_ROOT_SELECTOR = [
    "article",
    "[role=main]",
    "main",
    ".article-body",
    ".article__body",
    ".article-body-content",
    ".article-content",
    ".article__content",
    ".article_content",
    ".c-article-body",
    ".hlFld-Fulltext",
    ".article-section__content",
    ".fulltext",
    ".full-text",
    "#article-body",
    "#article-content",
    "#fulltext",
    "#pnlArticleContent",
    "#maincontent",
    "#body",
  ].join(",");

  function visibleTextLength(node) {
    if (!node) return 0;
    let total = 0;
    const visit = (current) => {
      if (!current) return;
      if (current.nodeType === 3) {
        total += String(current.nodeValue || "").replace(/\s+/g, " ").trim().length;
        return;
      }
      if (current.nodeType !== 1) return;
      const tag = String(current.localName || current.tagName || "").toLowerCase();
      if (IGNORED_TEXT_TAGS.has(tag)) return;
      const children = current.childNodes;
      if (children && typeof children.length === "number") {
        for (let i = 0; i < children.length; i += 1) visit(children[i]);
      } else {
        total += textLength(current);
      }
    };
    visit(node);
    return total;
  }

  function isDedicatedArticleContainer(element) {
    if (!element || element.nodeType !== 1) return false;
    const tag = String(element.localName || element.tagName || "").toLowerCase();
    if (tag === "article") return true;
    if (tag === "main") return false;
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    if (role === "main") return false;
    const idAndClass = `${element.getAttribute?.("id") || ""} ${element.getAttribute?.("class") || ""}`.toLowerCase();
    return /(?:article[-_]?body|article[-_]?content|c-article-body|hlfld-fulltext|full[-_]?text|pnlarticlecontent|article-section__content)/.test(idAndClass);
  }

  function chooseArticleRoot(doc) {
    const candidates = Array.from(doc.querySelectorAll(ARTICLE_ROOT_SELECTOR))
      .map((element) => ({ element, length: visibleTextLength(element) }))
      .filter((entry) => entry.length > 500);
    if (!candidates.length) return doc.body;
    const longest = candidates.reduce((best, entry) => (!best || entry.length > best.length ? entry : best), null);
    const dedicated = candidates
      .filter((entry) => isDedicatedArticleContainer(entry.element))
      .reduce((best, entry) => (!best || entry.length > best.length ? entry : best), null);
    if (dedicated && longest && dedicated.length >= longest.length * 0.55) {
      return dedicated.element;
    }
    return longest?.element || doc.body;
  }

  function isLandingOrAbstractURL(url) {
    try {
      const path = new URL(String(url || "")).pathname.toLowerCase();
      return /\/(?:articlelanding|articlepdf|doi\/abs|doi\/epdf|abstract)\b/.test(path);
    } catch {
      return false;
    }
  }

  function validateSamePublisherURL(candidate, baseURL) {
    try {
      const resolved = new URL(String(candidate || "").trim(), baseURL);
      const checked = AutoFullText.validateArticleURL(resolved.href);
      const baseHost = new URL(baseURL).hostname.toLowerCase();
      const targetHost = new URL(checked).hostname.toLowerCase();
      if (targetHost !== baseHost && !AutoFullText.isTrustedRemoteHost?.(targetHost)) return "";
      const normCurrent = new URL(baseURL);
      const normTarget = new URL(checked);
      if (normTarget.origin === normCurrent.origin && normTarget.pathname === normCurrent.pathname && normTarget.search === normCurrent.search) {
        return "";
      }
      return checked;
    } catch {
      return "";
    }
  }

  function findFullTextHTMLURL(doc, currentURL) {
    if (!doc || !currentURL) return "";
    const isDisallowedTarget = (urlStr) => {
      try {
        const parsed = new URL(urlStr);
        const path = parsed.pathname.toLowerCase();
        if (/\.(?:pdf|zip|docx?|xlsx?|pptx?|eps|png|jpe?g|gif|svg)$/i.test(path)) return true;
        if (/\/(?:articlepdf|doi\/(?:pdf|epdf)|pdf|login|signin|sign-in|subscribe|purchase|checkout|cart|auth|sso|shibboleth)\b/i.test(path)) return true;
      } catch {
        return true;
      }
      return false;
    };

    try {
      const metaFullText = doc.querySelector?.('meta[name="citation_fulltext_html_url" i], meta[name="fulltext_html_url" i]');
      const metaContent = metaFullText?.getAttribute?.("content") || "";
      if (metaContent) {
        const valid = validateSamePublisherURL(metaContent, currentURL);
        if (valid && !isDisallowedTarget(valid)) return valid;
      }
    } catch {}

    try {
      const metaRefresh = doc.querySelector?.('meta[http-equiv="refresh" i]');
      const refreshContent = String(metaRefresh?.getAttribute?.("content") || "");
      const match = refreshContent.match(/url\s*=\s*['"]?([^'";\s]+)/i);
      if (match?.[1]) {
        const valid = validateSamePublisherURL(match[1], currentURL);
        if (valid && !isDisallowedTarget(valid)) return valid;
      }
    } catch {}

    try {
      const anchors = Array.from(doc.querySelectorAll?.("a[href]") || []);
      let bestLink = "";
      let bestScore = 0;
      for (const anchor of anchors) {
        const href = String(anchor.getAttribute?.("href") || "").trim();
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
        const valid = validateSamePublisherURL(href, currentURL);
        if (!valid || isDisallowedTarget(valid)) continue;
        const lowerPath = (() => { try { return new URL(valid).pathname.toLowerCase(); } catch { return ""; } })();
        const label = `${anchor.textContent || ""} ${anchor.getAttribute?.("title") || ""} ${anchor.getAttribute?.("aria-label") || ""}`
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        let score = 0;
        if (/\/content\/articlehtml\//i.test(lowerPath)) score += 100;
        else if (/\/doi\/full\//i.test(lowerPath)) score += 95;
        else if (/\/full(?:text|-text)?(?:\b|\/)/i.test(lowerPath)) score += 70;
        if (/^(?:article\s*html|full\s*text(?:\s*html)?|html\s*full\s*text|read\s*(?:the\s*)?full\s*(?:article|text)|view\s*full\s*text|read\s*article)$/.test(label)) {
          score += 80;
        } else if (/\b(?:article\s*html|full\s*text\s*html|view\s*full\s*article)\b/.test(label)) {
          score += 55;
        }
        if (score > bestScore) {
          bestScore = score;
          bestLink = valid;
        }
      }
      if (bestLink && bestScore >= 70) return bestLink;
    } catch {}

    try {
      const parsed = new URL(currentURL);
      const host = parsed.hostname.toLowerCase();
      if (host === "pubs.rsc.org" && /\/content\/article(?:landing|pdf)\//i.test(parsed.pathname)) {
        const upgraded = new URL(parsed.href);
        upgraded.pathname = parsed.pathname.replace(/\/content\/article(?:landing|pdf)\//i, "/content/articlehtml/");
        const valid = validateSamePublisherURL(upgraded.href, currentURL);
        if (valid) return valid;
      }
      if (/\/doi\/abs\//i.test(parsed.pathname)) {
        const upgraded = new URL(parsed.href);
        upgraded.pathname = parsed.pathname.replace(/\/doi\/abs\//i, "/doi/full/");
        const valid = validateSamePublisherURL(upgraded.href, currentURL);
        if (valid) return valid;
      }
    } catch {}

    return "";
  }

  function estimateCleanedBodyLength(doc, currentURL = "") {
    if (!doc || !doc.body) return 0;
    try {
      const sourceRoot = chooseArticleRoot(doc);
      if (!sourceRoot) return 0;
      const cloned = sourceRoot.cloneNode(true);
      removeUnwantedContent(cloned, currentURL || "https://example.invalid/", cloned);
      return visibleTextLength(cloned);
    } catch {
      return visibleTextLength(doc.body);
    }
  }

  function hasUsableArticleBody(doc, currentURL = "") {
    if (!doc || !doc.body) return false;
    if (currentURL && isChallengeDocument(doc, currentURL)) return false;
    if (estimateCleanedBodyLength(doc, currentURL) >= 500) return true;
    if (currentURL && isLandingOrAbstractURL(currentURL) && findFullTextHTMLURL(doc, currentURL) && visibleTextLength(doc.body) >= 180) {
      return true;
    }
    return false;
  }

  function hasUsableArticleHTML(html, currentURL = "") {
    const raw = String(html || "");
    if (!raw || isChallengeHTML(raw)) return false;
    try {
      if (typeof DOMParser === "function") {
        const parsed = new DOMParser().parseFromString(raw, "text/html");
        return hasUsableArticleBody(parsed, currentURL);
      }
    } catch {}
    return raw.replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim().length >= 500;
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
    let removeCurrent = true;
    while (current && current !== root) {
      let sibling = current.nextSibling;
      while (sibling) {
        const next = sibling.nextSibling;
        sibling.parentNode?.removeChild(sibling);
        sibling = next;
      }
      const parent = current.parentElement;
      if (removeCurrent) {
        current.remove();
        removeCurrent = false;
      }
      current = parent;
    }
  }

  function visibleTextBefore(root, targetNode) {
    if (!root || !targetNode) return 0;
    let total = 0;
    let reached = false;
    const visit = (node) => {
      if (reached || !node) return;
      if (node === targetNode) {
        reached = true;
        return;
      }
      if (node.nodeType === 3) {
        total += String(node.nodeValue || "").replace(/\s+/g, " ").trim().length;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.localName || node.tagName || "").toLowerCase();
      if (IGNORED_TEXT_TAGS.has(tag)) return;
      const children = node.childNodes;
      if (children && typeof children.length === "number") {
        for (let i = 0; i < children.length; i += 1) {
          visit(children[i]);
          if (reached) return;
        }
      }
    };
    visit(root);
    return total;
  }

  function cleanSectionTail(root, contentNode = root) {
    const headings = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"));
    const acknowledgementHeading = headings.find((heading) =>
      isAcknowledgementHeading(heading.textContent || "") && visibleTextBefore(root, heading) >= 400,
    );
    if (acknowledgementHeading) {
      const level = headingLevel(acknowledgementHeading);
      const nextSection = headings.find((heading) =>
        (acknowledgementHeading.compareDocumentPosition(heading) & 4) !== 0 && headingLevel(heading) <= level,
      );
      if (nextSection && visibleTextBefore(root, nextSection) >= 400) removeAfter(nextSection, root);
    }
    for (const heading of headings) {
      if (!root.contains(heading) || !isStopHeading(heading.textContent || "")) continue;
      const section = heading.closest("section");
      const sectionWrapsBody = Boolean(
        section && (section === root || (contentNode && (section === contentNode || section.contains(contentNode)))),
      );
      if (section && !sectionWrapsBody) {
        const remaining = visibleTextLength(root) - visibleTextLength(section);
        if (remaining >= 400 || visibleTextLength(section) < 1200) {
          section.remove();
        }
      } else if (visibleTextBefore(root, heading) >= 400) {
        removeAfter(heading, root);
      }
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

  function unwrapFormElement(formElement) {
    const doc = formElement?.ownerDocument;
    if (!doc || !formElement.parentNode) return;
    const wrapper = doc.createElement("div");
    for (const attr of Array.from(formElement.attributes || [])) {
      const name = String(attr.name || "").toLowerCase();
      if (["class", "id", "lang", "dir", "style"].includes(name)) {
        wrapper.setAttribute(name, name === "style" ? sanitizeCSS(attr.value) : attr.value);
      }
    }
    while (formElement.childNodes?.length) {
      wrapper.appendChild(formElement.childNodes[0]);
    }
    formElement.replaceWith(wrapper);
  }

  function recoverNoscriptImages(root) {
    for (const noscript of Array.from(root.querySelectorAll("noscript"))) {
      try {
        let fallbackSrc = "";
        let fallbackSrcset = "";
        const fallbackImg = noscript.querySelector?.("img");
        if (fallbackImg) {
          fallbackSrc = String(fallbackImg.getAttribute?.("src") || "").trim();
          fallbackSrcset = String(fallbackImg.getAttribute?.("srcset") || "").trim();
        } else {
          const text = String(noscript.textContent || "");
          const srcMatch = text.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
          const srcsetMatch = text.match(/<img\b[^>]*\bsrcset\s*=\s*["']([^"']+)["']/i);
          if (srcMatch?.[1]) fallbackSrc = srcMatch[1].trim();
          if (srcsetMatch?.[1]) fallbackSrcset = srcsetMatch[1].trim();
        }
        if ((!fallbackSrc || isPlaceholderImageURL(fallbackSrc)) && !fallbackSrcset) continue;
        const parent = noscript.parentElement;
        if (!parent) continue;
        const siblings = parent.children || [];
        const idx = siblings.indexOf(noscript);
        const adjacent = [siblings[idx - 1], siblings[idx + 1]].filter(Boolean);
        let targetImg = null;
        for (const node of adjacent) {
          if (node.localName?.toLowerCase() === "img") {
            targetImg = node;
            break;
          }
          const nested = node.querySelector?.("img");
          if (nested) {
            targetImg = nested;
            break;
          }
        }
        if (!targetImg) {
          targetImg = Array.from(parent.querySelectorAll?.("img") || []).find((img) =>
            img !== fallbackImg && isPlaceholderImageURL(img.getAttribute?.("src")),
          ) || null;
        }
        if (targetImg && targetImg !== fallbackImg && isPlaceholderImageURL(targetImg.getAttribute?.("src"))) {
          if (fallbackSrc && !isPlaceholderImageURL(fallbackSrc)) targetImg.setAttribute("src", fallbackSrc);
          if (fallbackSrcset && !targetImg.getAttribute?.("srcset")) targetImg.setAttribute("srcset", fallbackSrcset);
        }
      } catch {}
    }
  }

  function removeUnwantedContent(root, baseURL, contentNode = null) {
    recoverNoscriptImages(root);
    const dangerousSelectors = [
      "script", "style", "noscript", "iframe", "object", "embed", "applet", "base", "link", "meta[http-equiv]",
    ].join(",");
    for (const element of Array.from(root.querySelectorAll(dangerousSelectors))) element.remove();

    const baseContent = contentNode && root.contains(contentNode) ? contentNode : root;
    const initialBodyVisible = visibleTextLength(baseContent);

    const noiseSelectors = [
      "nav", "aside", "header[role=banner]", "footer[role=contentinfo]", ".site-header", ".site-footer",
      ".page-header", ".page-footer", ".global-header", ".global-footer",
      "button", "form", "input", "select", "textarea", "dialog", "[role=navigation]",
      "[role=complementary]", "[aria-label*=advert i]", "[class*=advert i]", "[id*=advert i]",
      "[class*=cookie i]", "[id*=cookie i]", "[class*=recommend i]", "[id*=recommend i]",
      "[class*=related-article i]", "[class*=social-share i]", "[class*=author-list i]",
      "[class*=contrib-group i]", "[class*=article-authors i]", "[class*=breadcrumb i]",
      "[class*=toolbar i]", "[class*=metrics i]", "[class*=citation i]",
    ].join(",");
    for (const element of Array.from(root.querySelectorAll(noiseSelectors))) {
      if (!root.contains(element) || element === root) continue;
      const tag = String(element.localName || element.tagName || "").toLowerCase();
      const wrapsArticle = Boolean(baseContent && (element === baseContent || element.contains(baseContent)));
      if (wrapsArticle) {
        if (tag === "form") unwrapFormElement(element);
        continue;
      }
      if (!["button", "input", "select", "textarea", "dialog"].includes(tag) && initialBodyVisible >= 400) {
        const elementVisible = visibleTextLength(element);
        const paragraphCount = element.querySelectorAll?.("p")?.length || 0;
        if (
          elementVisible >= 400 &&
          elementVisible >= initialBodyVisible * 0.55 &&
          (tag === "form" || paragraphCount >= 2 || elementVisible >= initialBodyVisible * 0.75)
        ) {
          if (tag === "form") unwrapFormElement(element);
          continue;
        }
      }
      element.remove();
    }
    cleanSectionTail(root, baseContent);
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

  const LAZY_IMAGE_ATTRS = [
    "data-src", "data-original", "data-lazy-src", "data-lazy", "data-img-src", "data-image-src",
    "data-highres", "data-hi-res", "data-large", "data-full-src", "data-fullsrc", "data-src-retina",
    "data-url", "data-actualsrc", "data-echo", "data-figure-src", "data-asset-src", "data-thumb", "data-lightbox",
  ];
  const IMAGE_FILE_LINK_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:$|[?#])|[_-]hi-?res\.(?:gif|png|jpe?g|webp)(?:$|[?#])/i;

  function parseSrcset(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    if (/^data:/i.test(raw) && !/\s+\d+(?:\.\d+)?[wx]\s*,/i.test(raw)) {
      const spaceIdx = raw.search(/\s+/);
      const url = spaceIdx >= 0 ? raw.slice(0, spaceIdx) : raw;
      return [{ url: url.trim(), score: 1 }];
    }
    return raw.split(/,(?=\s*(?:https?:\/\/|\/\/|\/|\.{1,2}\/|data:|[^\s,]+\.[a-z0-9]{2,5}(?:[?#\s]|$)))/i)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const pieces = part.split(/\s+/);
        const descriptor = pieces[1] || "1x";
        const amount = parseFloat(descriptor) || 1;
        return { url: pieces[0], score: descriptor.endsWith("w") ? amount / 1000 : amount };
      })
      .sort((a, b) => b.score - a.score);
  }

  function isPlaceholderImageURL(raw) {
    const value = String(raw || "").trim();
    if (!value) return true;
    if (value === "#" || /^(?:about:blank|javascript:|blob:|vbscript:)/i.test(value)) return true;
    if (/^data:image\/(?:gif|png);base64,/i.test(value) && value.length < 220) return true;
    if (/^data:image\/svg\+xml/i.test(value) && value.length < 260 && !/<(?:path|circle|rect|polygon|polyline|line|ellipse|text|g)\b/i.test(value)) {
      return true;
    }
    try {
      const path = new URL(value, "https://placeholder.invalid/").pathname.toLowerCase();
      if (/(?:^|\/)(?:blank|spacer|pixel|transparent|placeholder|loading|spinner|empty|1x1|clear)\.(?:gif|png|svg|jpe?g)$/i.test(path)) {
        return true;
      }
    } catch {}
    return false;
  }

  function isHiddenImage(image, root = null) {
    if (!image) return true;
    const role = String(image.getAttribute?.("role") || "").trim().toLowerCase();
    if (role === "presentation" || role === "none") return true;
    const widthAttr = String(image.getAttribute?.("width") || "").trim().replace(/px$/i, "");
    const heightAttr = String(image.getAttribute?.("height") || "").trim().replace(/px$/i, "");
    if ((widthAttr !== "" && Number(widthAttr) <= 1) || (heightAttr !== "" && Number(heightAttr) <= 1)) {
      return true;
    }
    let current = image;
    let depth = 0;
    while (current && current !== root && depth < 6) {
      if (current.getAttribute?.("hidden") !== null) return true;
      if (String(current.getAttribute?.("aria-hidden") || "").trim().toLowerCase() === "true") return true;
      const style = String(current.getAttribute?.("style") || "").toLowerCase();
      if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/.test(style)) return true;
      current = current.parentElement;
      depth += 1;
    }
    return false;
  }

  function isDecorativeBadgeOrIcon(image) {
    if (!image) return true;
    const alt = String(image.getAttribute?.("alt") || "").trim();
    const inFigure = Boolean(image.closest?.("figure,.figure,.fig,.image_table,.img_tbl"));
    if (inFigure && /\b(?:fig(?:ure)?|scheme|chart|table|graph|diagram|spectrum|micrograph)\b|[图表]/i.test(alt)) {
      return false;
    }
    const idClass = `${image.getAttribute?.("id") || ""} ${image.getAttribute?.("class") || ""}`;
    const rawSrc = `${image.getAttribute?.("src") || ""} ${image.getAttribute?.("data-src") || ""}`;
    const badgePattern = /(?:^|[\s_./-])(?:spinner|loader|loading|spacer|pixel|tracker|orcid|altmetric|crossmark|dimensions|plumx|creativecommons|licensebuttons|cc-by|badge|avatar|logo|icon|favicon)(?:$|[\s_./-])/i;
    return badgePattern.test(idClass) || badgePattern.test(rawSrc) || badgePattern.test(alt);
  }

  function collectImageCandidates(image, baseURL) {
    const rawCandidates = [];
    const seenRaw = new Set();
    const pushRaw = (value) => {
      const trimmed = String(value || "").trim();
      if (!trimmed || seenRaw.has(trimmed)) return;
      seenRaw.add(trimmed);
      rawCandidates.push(trimmed);
    };

    for (const attr of ["srcset", "data-srcset", "data-lazy-srcset"]) {
      for (const entry of parseSrcset(image.getAttribute?.(attr))) {
        if (!isPlaceholderImageURL(entry.url)) pushRaw(entry.url);
      }
    }

    if (image.parentElement?.localName?.toLowerCase() === "picture") {
      for (const source of Array.from(image.parentElement.querySelectorAll?.("source") || [])) {
        for (const attr of ["srcset", "data-srcset", "data-lazy-srcset"]) {
          for (const entry of parseSrcset(source.getAttribute?.(attr))) {
            if (!isPlaceholderImageURL(entry.url)) pushRaw(entry.url);
          }
        }
        const sourceSrc = String(source.getAttribute?.("src") || "").trim();
        if (sourceSrc && !isPlaceholderImageURL(sourceSrc)) pushRaw(sourceSrc);
      }
    }

    for (const attr of LAZY_IMAGE_ATTRS) {
      const value = String(image.getAttribute?.(attr) || "").trim();
      if (value && !isPlaceholderImageURL(value)) pushRaw(value);
    }

    for (const attr of Array.from(image.attributes || [])) {
      const name = String(attr.name || "").toLowerCase();
      if (!name.startsWith("data-") || LAZY_IMAGE_ATTRS.includes(name) || name.includes("srcset")) continue;
      if (!/^data-(?:.*(?:src|img|image|url|highres|hi-res|large|full|orig|thumb|figure|asset|zoom|lazy|retina))$/i.test(name)) continue;
      const value = String(attr.value || "").trim();
      if (!value || isPlaceholderImageURL(value)) continue;
      if (/^(?:https?:\/\/|\/\/|\/|data:image\/)/i.test(value) || IMAGE_FILE_LINK_PATTERN.test(value)) {
        pushRaw(value);
      }
    }

    for (const value of [image.currentSrc, image.getAttribute?.("src")]) {
      const trimmed = String(value || "").trim();
      if (trimmed && !isPlaceholderImageURL(trimmed)) pushRaw(trimmed);
    }

    const wrappingAnchor = image.closest?.("a[href]") || (image.parentElement?.localName?.toLowerCase() === "a" ? image.parentElement : null);
    const anchorHref = String(wrappingAnchor?.getAttribute?.("href") || "").trim();
    if (anchorHref && IMAGE_FILE_LINK_PATTERN.test(anchorHref) && !isPlaceholderImageURL(anchorHref)) {
      pushRaw(anchorHref);
    }

    const validated = [];
    const seenValidated = new Set();
    const rejectedReasons = [];
    for (const raw of rawCandidates) {
      if (/^data:image\//i.test(raw)) {
        if (!seenValidated.has(raw)) {
          seenValidated.add(raw);
          validated.push(raw);
        }
        continue;
      }
      if (/^data:/i.test(raw)) {
        rejectedReasons.push("non-image data URI");
        continue;
      }
      try {
        const checked = AutoFullText.validateResourceURL(raw, baseURL);
        if (!seenValidated.has(checked)) {
          seenValidated.add(checked);
          validated.push(checked);
        }
      } catch (error) {
        rejectedReasons.push(String(error?.message || error));
      }
    }
    return { candidates: validated, rejectedReasons, hadAnySource: rawCandidates.length > 0 };
  }

  function selectImageURL(image, baseURL) {
    return collectImageCandidates(image, baseURL).candidates[0] || "";
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
    const raw = String(url || "").trim();
    const base64Match = /^data:(image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml))(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
    if (base64Match) {
      let mime = base64Match[1].toLowerCase();
      if (mime === "image/jpg") mime = "image/jpeg";
      const payload = base64Match[2].replace(/\s+/g, "");
      const estimate = Math.floor(payload.length * 0.75);
      if (estimate > imageLimits.one) throw new Error("A data image exceeds the 12 MB per-image limit.");
      const binary = atob(payload);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (!bytes.length || bytes.length > imageLimits.one) throw new Error("A data image exceeds the 12 MB per-image limit.");
      return { bytes, mime };
    }
    const svgMatch = /^data:image\/svg\+xml(?:;charset=[^;,]+|;utf8)?,([\s\S]+)$/i.exec(raw);
    if (svgMatch) {
      let decoded = svgMatch[1];
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // Keep raw when unencoded characters like '#' appear in inline SVG data URIs.
      }
      const bytes = new TextEncoder().encode(decoded);
      if (!bytes.length || bytes.length > imageLimits.one) throw new Error("A data image exceeds the 12 MB per-image limit.");
      return { bytes, mime: "image/svg+xml" };
    }
    throw new Error("Only base64-encoded raster or SVG data images are supported.");
  }

  function sniffImageMime(bytes, contentType, resolvedURL) {
    let mime = String(contentType || "").split(";")[0].trim().toLowerCase();
    if (mime === "image/jpg" || mime === "image/pjpeg") mime = "image/jpeg";
    else if (mime === "image/x-png") mime = "image/png";
    if (mime === "image/svg+xml" || /^image\/(?:png|jpeg|gif|webp|avif)$/.test(mime)) {
      return mime;
    }
    try {
      if (resolvedURL && new URL(resolvedURL).pathname.toLowerCase().endsWith(".svg")) {
        return "image/svg+xml";
      }
    } catch {}
    if (bytes && bytes.length >= 4) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
      if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return "image/webp";
      }
      if (!mime || mime === "application/octet-stream" || mime === "text/xml" || mime === "application/xml" || mime === "text/plain") {
        const prefix = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
        if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!DOCTYPE\s+svg[\s\S]*?>\s*)?<svg[\s>]/i.test(prefix)) {
          return "image/svg+xml";
        }
      }
    }
    return "";
  }

  function clearLazyImageAttributes(image) {
    image.removeAttribute("srcset");
    image.removeAttribute("data-srcset");
    image.removeAttribute("data-lazy-srcset");
    image.removeAttribute("loading");
    for (const attr of LAZY_IMAGE_ATTRS) image.removeAttribute(attr);
  }

  function removeOrReplaceUnavailableImage(image, reason = "") {
    if (!image || !image.parentNode) return;
    const alt = String(image.getAttribute?.("alt") || "").replace(/\s+/g, " ").trim();
    const decorative = isDecorativeBadgeOrIcon(image);
    const inFigure = Boolean(image.closest?.("figure,.figure,.fig,.image_table,.img_tbl"));
    AutoFullText.log(`Omitting unavailable article image (${alt || "no alt"})`, reason || "no safe source");
    if (!decorative && alt.length >= 3 && (inFigure || /\b(?:fig(?:ure)?|scheme|chart|table|graph|diagram)\b|[图表]/i.test(alt))) {
      const doc = image.ownerDocument;
      if (doc && typeof doc.createElement === "function") {
        const note = doc.createElement("span");
        note.setAttribute("class", "paperflow-omitted-figure");
        note.textContent = `[图片未能加载：${alt.slice(0, 140)}]`;
        image.replaceWith(note);
        return;
      }
    }
    image.remove();
  }

  async function inlineImages(root, baseURL, workspace, signal, challengeAuth = null) {
    for (const img of Array.from(root.querySelectorAll("img"))) {
      if (isHiddenImage(img, root)) img.remove();
    }
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
      clearLazyImageAttributes(image);
    };

    const applyInlinedImage = (image, bytes, contentType, resolvedURL) => {
      if (!bytes.length || bytes.length > imageLimits.one) throw new Error("Image size is invalid or exceeds 12 MB.");
      if (totalBytes + bytes.length > imageLimits.all) throw new Error("Article images exceed the 40 MB export limit.");
      const mime = sniffImageMime(bytes, contentType, resolvedURL);
      if (!mime) {
        throw new Error(`Unexpected or unsupported image response type ${String(contentType || "").split(";")[0].trim() || "(missing)"}.`);
      }
      totalBytes += bytes.length;
      const finalBytes = mime === "image/svg+xml" ? sanitizeSVG(bytes) : bytes;
      image.setAttribute("src", `data:${mime};base64,${base64FromBytes(finalBytes)}`);
      clearLazyImageAttributes(image);
    };

    const requestImageOnce = async (url, { anon = true, noCache = false, headers = {} } = {}) => {
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
          noCache,
          anon,
          followRedirects: false,
          headers: {
            Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            ...headers,
          },
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
      return response;
    };

    const downloadImageViaChallenge = async (image, url) => {
      const remainingBudget = Math.max(0, imageLimits.all - totalBytes);
      const maxAllowed = Math.min(imageLimits.one, remainingBudget);
      if (maxAllowed <= 0) throw new Error("Article images exceed the 40 MB export limit.");
      if (typeof challengeAuth?.handle?.fetchInWindow === "function") {
        try {
          const fetched = await challengeAuth.handle.fetchInWindow(
            url,
            challengeAuth.referrerURL || baseURL,
            maxAllowed,
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          );
          if (fetched.status >= 200 && fetched.status < 300) {
            const finalURL = fetched.responseURL
              ? AutoFullText.validateResourceURL(fetched.responseURL, baseURL)
              : url;
            applyInlinedImage(image, fetched.bytes, fetched.getHeader("content-type"), finalURL);
            return true;
          }
        } catch (error) {
          if (signal?.aborted || controller.signal.aborted || error?.name === "AbortError") throw error;
          if (/exceeds the .*limit|12 MB|40 MB/i.test(String(error?.message || ""))) throw error;
          // Fall back to authenticated session HTTP request below.
        }
      }
      return false;
    };

    const downloadImage = async (image, initialURL, { useVerifiedSession = false } = {}) => {
      let url = AutoFullText.validateResourceURL(initialURL, baseURL);
      const visited = new Set();
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        if (signal?.aborted || controller.signal.aborted) throw new Error("Image download cancelled.");
        if (visited.has(url)) throw new Error("Image redirect loop detected.");
        visited.add(url);

        const requestOpts = useVerifiedSession
          ? {
            anon: false,
            noCache: true,
            headers: {
              ...(challengeAuth?.referrerURL ? { Referer: challengeAuth.referrerURL } : {}),
              ...(challengeAuth?.userAgent ? { "User-Agent": challengeAuth.userAgent } : {}),
            },
          }
          : { anon: true };

        let response;
        try {
          response = await requestImageOnce(url, requestOpts);
        } catch (error) {
          if (!useVerifiedSession && challengeAuth && isChallengeHTTP(error)) {
            if (await downloadImageViaChallenge(image, url)) return;
            return downloadImage(image, url, { useVerifiedSession: true });
          }
          throw error;
        }

        const status = Number(response.status || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          if (redirects === 5) throw new Error("Image exceeded the redirect limit.");
          const location = response.getResponseHeader("Location");
          if (!location) throw new Error(`Image redirect ${status} has no Location header.`);
          url = AutoFullText.validateRedirectURL(new URL(location, url).href, url, baseURL);
          continue;
        }
        if ((status === 403 || status === 503) && !useVerifiedSession && challengeAuth) {
          if (await downloadImageViaChallenge(image, url)) return;
          return downloadImage(image, url, { useVerifiedSession: true });
        }
        if (status < 200 || status >= 300) throw new Error(`Image returned HTTP ${status}.`);
        if (response.responseURL) AutoFullText.validateResourceURL(response.responseURL, baseURL);
        const buffer = response.response;
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || new ArrayBuffer(0));
        applyInlinedImage(image, bytes, response.getResponseHeader("Content-Type"), url);
        return;
      }
      throw new Error("Image download did not complete.");
    };

    const isFatalImageError = (error) => {
      if (!error) return false;
      if (signal?.aborted || controller.signal.aborted || error.name === "AbortError") return true;
      return /exceeds? the .*limit|12 MB|40 MB|too many images/i.test(String(error.message || ""));
    };

    const worker = async () => {
      while (!failure && !signal?.aborted && !controller.signal.aborted) {
        const image = images[next++];
        if (!image) return;
        try {
          const { candidates, rejectedReasons } = collectImageCandidates(image, baseURL);
          if (!candidates.length) {
            removeOrReplaceUnavailableImage(image, rejectedReasons.join("; ") || "no usable image source");
            continue;
          }
          let inlined = false;
          let lastError = null;
          for (const candidate of candidates) {
            try {
              if (candidate.startsWith("data:")) await persistDataImage(image, candidate);
              else await downloadImage(image, candidate);
              inlined = true;
              break;
            } catch (candidateError) {
              if (isFatalImageError(candidateError)) throw candidateError;
              lastError = candidateError;
            }
          }
          if (!inlined) {
            removeOrReplaceUnavailableImage(image, String(lastError?.message || lastError || "image download failed"));
          }
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

  function emitProgress(onProgress, stage, percent, extra = null) {
    if (typeof onProgress !== "function") return;
    try {
      onProgress(extra ? { stage, percent, ...extra } : { stage, percent });
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

  function wrapWithAncestorsWithRef(sourceRoot, doc) {
    let content;
    if (sourceRoot === doc.body) {
      content = doc.createElement("div");
      for (const child of Array.from(doc.body.childNodes)) content.appendChild(child.cloneNode(true));
    } else {
      content = sourceRoot.cloneNode(true);
    }
    const contentNode = content;
    let ancestor = sourceRoot === doc.body ? null : sourceRoot.parentElement;
    while (ancestor && ancestor !== doc.body && ancestor !== doc.documentElement) {
      const tag = String(ancestor.localName || ancestor.tagName || "").toLowerCase();
      let wrapper;
      if (tag === "form") {
        wrapper = doc.createElement("div");
        for (const attr of Array.from(ancestor.attributes || [])) {
          const name = String(attr.name || "").toLowerCase();
          if (["class", "id", "lang", "dir", "style"].includes(name)) {
            wrapper.setAttribute(name, name === "style" ? sanitizeCSS(attr.value) : attr.value);
          }
        }
      } else {
        wrapper = ancestor.cloneNode(false);
      }
      wrapper.appendChild(content);
      content = wrapper;
      ancestor = ancestor.parentElement;
    }
    return { root: content, contentNode };
  }

  function wrapWithAncestors(sourceRoot, doc) {
    return wrapWithAncestorsWithRef(sourceRoot, doc).root;
  }

  async function capturePageStyles(doc, baseURL, signal, challengeAuth = null) {
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

    const fetchStylesheet = async (href) => {
      try {
        return await AutoFullText.fetchTextResource(href, {
          baseURL,
          signal,
          headers: { Accept: "text/css,*/*;q=0.1" },
          maxBytes: 2 * 1024 * 1024,
        });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError" || !challengeAuth) throw error;
        if (typeof challengeAuth.handle?.fetchInWindow === "function") {
          try {
            const fetched = await challengeAuth.handle.fetchInWindow(
              href,
              challengeAuth.referrerURL || baseURL,
              2 * 1024 * 1024,
              "text/css,*/*;q=0.1",
            );
            if (fetched.status >= 200 && fetched.status < 300) {
              return {
                text: new TextDecoder("utf-8").decode(fetched.bytes),
                contentType: fetched.getHeader("content-type"),
              };
            }
          } catch (windowError) {
            if (signal?.aborted || windowError?.name === "AbortError") throw windowError;
          }
        }
        return AutoFullText.fetchTextResource(href, {
          baseURL,
          signal,
          noCache: true,
          anon: false,
          headers: {
            Accept: "text/css,*/*;q=0.1",
            ...(challengeAuth.referrerURL ? { Referer: challengeAuth.referrerURL } : {}),
            ...(challengeAuth.userAgent ? { "User-Agent": challengeAuth.userAgent } : {}),
          },
          maxBytes: 2 * 1024 * 1024,
        });
      }
    };

    const loadedStyles = await mapConcurrentOrdered(entries, async (entry) => {
      if (!entry.href) return entry;
      try {
        const response = await fetchStylesheet(entry.href);
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

  function formatTooShortError(activeURL, doc, rawVisibleLen, cleanedLen, triedFullTextURL = "") {
    let pathSummary = "";
    try {
      const parsed = new URL(String(activeURL || ""));
      pathSummary = `${parsed.hostname}${parsed.pathname}`;
    } catch {}
    const title = String(doc?.title || "").trim().slice(0, 100);
    const parts = ["The cleaned article body is too short to translate."];
    if (pathSummary) parts.push(`当前页面：${pathSummary}`);
    if (title) parts.push(`页面标题：${title}`);
    parts.push(`可见正文字符数：清洗前 ${rawVisibleLen} / 清洗后 ${cleanedLen}`);
    if (triedFullTextURL) parts.push("已尝试跳转全文 HTML 页面，但未获取到足够正文（该文献可能需要机构订阅权限或仅提供 PDF/摘要）。");
    else parts.push("该网页可能仅展示摘要、需要机构登录，或正文尚未加载完成。");
    return parts.join("\n");
  }

  function buildCleanedArticle(parsedDoc, activeURL, liveDoc = null, preselectedRoot = null) {
    const parsedRoot = preselectedRoot || chooseArticleRoot(parsedDoc);
    const rawVisibleLen = visibleTextLength(parsedRoot);
    const { root, contentNode } = wrapWithAncestorsWithRef(parsedRoot, parsedDoc);
    let canvasCaptured = false;
    if (liveDoc && liveDoc !== parsedDoc) {
      try {
        const liveRoot = chooseArticleRoot(liveDoc);
        if (liveRoot) {
          captureCanvas(liveRoot, root);
          canvasCaptured = true;
        }
      } catch {
        canvasCaptured = false;
      }
    }
    if (!canvasCaptured) captureCanvas(parsedRoot, root);
    normalizeMathMarkup(root);
    removeUnwantedContent(root, activeURL, contentNode);
    return {
      root,
      cleanedHTML: root.outerHTML,
      rawVisibleLen,
      cleanedLen: visibleTextLength(root),
    };
  }

  async function fetchFullTextHTMLInChallenge(fullTextURL, referrerURL, handle, userAgent, signal) {
    if (typeof handle?.fetchInWindow === "function") {
      try {
        const fetched = await handle.fetchInWindow(
          fullTextURL,
          referrerURL,
          30 * 1024 * 1024,
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        );
        if (fetched.status >= 200 && fetched.status < 300 && fetched.bytes?.length) {
          const text = new TextDecoder("utf-8").decode(fetched.bytes);
          if (text && !isChallengeHTML(text)) {
            return { html: text, responseURL: fetched.responseURL || fullTextURL, doc: null };
          }
        }
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
      }
    }

    try {
      const fetched = await AutoFullText.fetchDocument(fullTextURL, {
        signal,
        noCache: true,
        anon: false,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(referrerURL ? { Referer: referrerURL } : {}),
          ...(userAgent ? { "User-Agent": userAgent } : {}),
        },
        maxBytes: 30 * 1024 * 1024,
      });
      if (fetched.rawText && !isChallengeHTML(fetched.rawText)) {
        return { html: fetched.rawText, responseURL: fetched.responseURL || fullTextURL, doc: null };
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
    }

    if (typeof handle?.navigateToArticle === "function") {
      try {
        const navigated = await handle.navigateToArticle(fullTextURL);
        let navHTML = String(navigated?.html || "");
        if (!navHTML && navigated?.doc?.documentElement) {
          try { navHTML = String(navigated.doc.documentElement.outerHTML || ""); } catch {}
        }
        if (navHTML && !isChallengeHTML(navHTML)) {
          return {
            html: navHTML,
            responseURL: navigated?.responseURL || fullTextURL,
            doc: navigated?.doc || null,
          };
        }
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError" || error?.name === "FullTextChallengeCancelledError") {
          throw error;
        }
      }
    }

    return null;
  }

  async function snapshotArticleViaChallenge(challengeURL, workspace, signal, onProgress, { challengeInitTimeoutMs } = {}) {
    const canOpenChallenge = typeof AutoFullTextSupportingInfo !== "undefined" &&
      typeof AutoFullTextSupportingInfo?.openChallengeSession === "function" &&
      typeof Zotero.getMainWindow?.()?.openDialog === "function";
    if (!canOpenChallenge) {
      throw Object.assign(new Error("出版商页面触发了 Cloudflare / 安全验证，当前无法打开验证窗口。"), {
        name: "FullTextAccessError",
        publisherURL: challengeURL,
      });
    }
    const userAgent = AutoFullTextSupportingInfo.getBrowserUserAgent?.() || "";
    emitProgress(onProgress, "检测到 Cloudflare / 安全验证，正在尝试自动跳过或打开验证窗口…", 10);
    return AutoFullTextSupportingInfo.openChallengeSession(challengeURL, {
      mode: "translation",
      signal,
      userAgent,
      onProgress,
      ...(challengeInitTimeoutMs ? { initTimeoutMs: challengeInitTimeoutMs } : {}),
      windowTitle: "Zotero PaperFlow — 全文翻译安全验证",
      extractLabel: "已通过，立即提取正文",
      cancelErrorName: "FullTextChallengeCancelledError",
      cancelErrorMessage: "已取消安全验证，全文翻译已停止。",
      accessErrorName: "FullTextAccessError",
      hasArticleContent: (doc, currentURL) => hasUsableArticleBody(doc, currentURL),
      hasArticleContentHTML: (htmlText, currentURL) => hasUsableArticleHTML(htmlText, currentURL),
      async onVerified({ doc, responseURL, html, handle }) {
        const activeSignal = combineSignals(signal, handle?.signal || null);
        throwIfAborted(activeSignal);
        let activeURL = AutoFullText.validateArticleURL(responseURL || challengeURL);
        let activeHTML = String(html || "");
        let activeLiveDoc = doc || null;
        if (!activeHTML && activeLiveDoc?.documentElement) {
          try {
            activeHTML = String(activeLiveDoc.documentElement.outerHTML || "");
          } catch {
            activeHTML = "";
          }
        }
        if (!activeHTML) {
          handle?.setStatus?.("验证已通过，正在使用已验证会话读取文章网页…", activeURL);
          emitProgress(onProgress, "验证已通过，正在读取文章网页…", 16);
          const fetched = await AutoFullText.fetchDocument(activeURL, {
            signal: activeSignal,
            noCache: true,
            anon: false,
            headers: {
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              ...(userAgent ? { "User-Agent": userAgent } : {}),
            },
            maxBytes: 30 * 1024 * 1024,
            onRawText: (text) => workspace.writeText("article-page-original.html", text),
          });
          activeHTML = fetched.rawText;
          activeURL = fetched.responseURL;
        } else {
          if (activeHTML.length * 2 > 30 * 1024 * 1024 + 65536) {
            throw new Error("HTTP resource exceeded its in-memory size limit.");
          }
          await workspace.writeText("article-page-original.html", activeHTML);
        }

        if (isChallengeHTML(activeHTML)) {
          throw Object.assign(new Error("安全验证尚未通过，仍停留在出版商验证页。"), {
            name: "FullTextAccessError",
            publisherURL: activeURL,
          });
        }

        let parsedDoc = new DOMParser().parseFromString(activeHTML, "text/html");
        if (!parsedDoc.documentElement || parsedDoc.querySelector("parsererror")) {
          throw new Error("Article page returned invalid HTML.");
        }

        let cleaned = buildCleanedArticle(parsedDoc, activeURL, activeLiveDoc);
        let triedFullTextURL = "";
        const fullTextURL = findFullTextHTMLURL(parsedDoc, activeURL);
        if (fullTextURL && (isLandingOrAbstractURL(activeURL) || cleaned.cleanedLen < 2500)) {
          triedFullTextURL = fullTextURL;
          handle?.setStatus?.("检测到全文 HTML 页面，正在自动切换并提取完整正文…", fullTextURL);
          emitProgress(onProgress, "正在跳转到文章全文 HTML 页面…", 17);
          const fullTextPage = await fetchFullTextHTMLInChallenge(fullTextURL, activeURL, handle, userAgent, activeSignal);
          if (fullTextPage?.html) {
            try {
              const candidateDoc = new DOMParser().parseFromString(fullTextPage.html, "text/html");
              if (candidateDoc.documentElement && !candidateDoc.querySelector("parsererror")) {
                const candidateURL = AutoFullText.validateArticleURL(fullTextPage.responseURL || fullTextURL);
                const candidateCleaned = buildCleanedArticle(candidateDoc, candidateURL, fullTextPage.doc);
                if (candidateCleaned.cleanedLen > cleaned.cleanedLen && candidateCleaned.cleanedLen >= 500) {
                  activeURL = candidateURL;
                  activeHTML = fullTextPage.html;
                  activeLiveDoc = fullTextPage.doc;
                  parsedDoc = candidateDoc;
                  cleaned = candidateCleaned;
                  if (activeHTML.length * 2 > 30 * 1024 * 1024 + 65536) {
                    throw new Error("HTTP resource exceeded its in-memory size limit.");
                  }
                  await workspace.writeText("article-page-original.html", activeHTML);
                }
              }
            } catch (candidateError) {
              if (activeSignal?.aborted || candidateError?.name === "AbortError") throw candidateError;
              AutoFullText.log("Full-text HTML upgrade fallback failed; keeping initial page", candidateError);
            }
          }
        }

        if (cleaned.cleanedLen < 500) {
          const message = formatTooShortError(activeURL, parsedDoc, cleaned.rawVisibleLen, cleaned.cleanedLen, triedFullTextURL);
          try { await workspace.writeText("translation-diagnostics.txt", message); } catch {}
          throw new Error(message);
        }

        handle?.setStatus?.("验证已通过，正在捕获页面样式并提取正文…", activeURL);
        emitProgress(onProgress, "验证已通过，正在清洗正文并捕获页面样式…", 20);
        const challengeAuth = { handle, userAgent, referrerURL: activeURL };
        const pageStyles = await capturePageStyles(parsedDoc, activeURL, activeSignal, challengeAuth);

        handle?.setStatus?.("正在提取并内联文章图片资源…", activeURL);
        emitProgress(onProgress, "验证已通过，正在内联文章图片资源…", 26);
        await inlineImages(cleaned.root, activeURL, workspace, activeSignal, challengeAuth);
        throwIfAborted(activeSignal);
        handle?.setStatus?.("正文与图片提取完成，正在关闭验证窗口并开始翻译…", activeURL);
        return {
          html: cleaned.root.outerHTML,
          cleanedHTML: cleaned.cleanedHTML,
          responseURL: activeURL,
          ...pageStyles,
          imagesInlined: true,
          usedChallengeWindow: true,
        };
      },
    });
  }

  async function snapshotArticle(url, workspace, signal, onProgress = null, { allowChallengeWindow = true, challengeInitTimeoutMs } = {}) {
    let lastAttemptURL = url;
    let lastResponseInfo = null;
    let fetched = null;
    let needsChallenge = false;
    try {
      fetched = await AutoFullText.fetchDocument(url, {
        signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
        maxBytes: 30 * 1024 * 1024,
        onRawText: (text) => workspace.writeText("article-page-original.html", text),
        onResponse: (response, requestURL) => {
          if (requestURL) lastAttemptURL = requestURL;
          lastResponseInfo = extractResponseInfo(response);
        },
      });
      if (isChallengeHTML(fetched.rawText)) {
        needsChallenge = true;
        lastAttemptURL = fetched.responseURL || lastAttemptURL;
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      const info = extractResponseInfo(error);
      const mergedInfo = {
        status: info.status || lastResponseInfo?.status || 0,
        cfMitigated: info.cfMitigated || lastResponseInfo?.cfMitigated || "",
        server: info.server || lastResponseInfo?.server || "",
        bodyPrefix: info.bodyPrefix || lastResponseInfo?.bodyPrefix || "",
      };
      if (allowChallengeWindow && isChallengeHTTP(error, mergedInfo)) {
        needsChallenge = true;
      } else {
        throw error;
      }
    }

    if (needsChallenge) {
      if (!allowChallengeWindow) {
        throw Object.assign(new Error("出版商页面触发了 Cloudflare / 安全验证。"), {
          name: "FullTextAccessError",
          publisherURL: lastAttemptURL,
        });
      }
      return snapshotArticleViaChallenge(lastAttemptURL, workspace, signal, onProgress, { challengeInitTimeoutMs });
    }

    let { doc, responseURL } = fetched;
    emitProgress(onProgress, "正在清洗正文并捕获页面样式…", 18);
    const sourceRoot = chooseArticleRoot(doc);
    let cleaned = buildCleanedArticle(doc, responseURL, doc, sourceRoot);
    const fullTextURL = findFullTextHTMLURL(doc, responseURL);
    if (fullTextURL && (isLandingOrAbstractURL(responseURL) || cleaned.cleanedLen < 2500)) {
      try {
        emitProgress(onProgress, "检测到全文 HTML 页面，正在读取完整正文…", 19);
        const fullTextFetched = await AutoFullText.fetchDocument(fullTextURL, {
          signal,
          headers: { Accept: "text/html,application/xhtml+xml" },
          maxBytes: 30 * 1024 * 1024,
        });
        if (isChallengeHTML(fullTextFetched.rawText)) {
          if (allowChallengeWindow) {
            return snapshotArticleViaChallenge(fullTextFetched.responseURL || fullTextURL, workspace, signal, onProgress, { challengeInitTimeoutMs });
          }
        } else {
          const candidateCleaned = buildCleanedArticle(fullTextFetched.doc, fullTextFetched.responseURL, fullTextFetched.doc);
          if (candidateCleaned.cleanedLen > cleaned.cleanedLen && candidateCleaned.cleanedLen >= 500) {
            doc = fullTextFetched.doc;
            responseURL = fullTextFetched.responseURL;
            cleaned = candidateCleaned;
            await workspace.writeText("article-page-original.html", fullTextFetched.rawText);
          }
        }
      } catch (upgradeError) {
        if (signal?.aborted || upgradeError?.name === "AbortError") throw upgradeError;
        if (allowChallengeWindow && isChallengeHTTP(upgradeError)) {
          return snapshotArticleViaChallenge(fullTextURL, workspace, signal, onProgress, { challengeInitTimeoutMs });
        }
        AutoFullText.log("Direct full-text HTML upgrade failed; keeping initial page", upgradeError);
      }
    }
    if (cleaned.cleanedLen < 500) {
      const message = formatTooShortError(responseURL, doc, cleaned.rawVisibleLen, cleaned.cleanedLen, fullTextURL);
      try { await workspace.writeText("translation-diagnostics.txt", message); } catch {}
      throw new Error(message);
    }
    const pageStyles = await capturePageStyles(doc, responseURL, signal);
    return {
      html: cleaned.root.outerHTML,
      cleanedHTML: cleaned.cleanedHTML,
      responseURL,
      ...pageStyles,
      imagesInlined: false,
      usedChallengeWindow: false,
    };
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("Full-text translation cancelled.");
    error.name = "AbortError";
    throw error;
  }

  async function create(item, signal = null, { onProgress = null } = {}) {
    const extraOptions = arguments[2] && typeof arguments[2] === "object" ? arguments[2] : {};
    const allowChallengeWindow = extraOptions.allowChallengeWindow !== false;
    const challengeInitTimeoutMs = extraOptions.challengeInitTimeoutMs;
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
      const snapshot = await snapshotArticle(url, workspace, signal, onProgress, {
        allowChallengeWindow,
        challengeInitTimeoutMs,
      });
      throwIfAborted(signal);
      runInfo.usedChallengeWindow = Boolean(snapshot.usedChallengeWindow);
      await workspace.writeText("article-page-cleaned.html", snapshot.cleanedHTML || snapshot.html);
      runInfo.stage = "article page saved";
      await workspace.writeText("run-info.json", JSON.stringify(runInfo, null, 2));

      const doc = new DOMParser().parseFromString(snapshot.html, "text/html");
      const root = doc.body.firstElementChild;
      if (!root || textLength(root) < 500) throw new Error("The cleaned article body is too short to translate.");

      if (!snapshot.imagesInlined) {
        emitProgress(onProgress, "正在内联文章图片资源…", 26);
        await inlineImages(root, snapshot.responseURL, workspace, signal);
        throwIfAborted(signal);
      }
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
      if (error?.name === "FullTextChallengeCancelledError") {
        try {
          await workspace.cleanup();
        } catch (cleanupError) {
          AutoFullText.log(`Cancelled translation challenge workspace could not be cleaned at ${workspace.path}`, cleanupError);
        }
        throw error;
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
    return {
      translatedParagraphs: runInfo.translatedParagraphs,
      translatedSegments: runInfo.translatedSegments,
      usedChallengeWindow: Boolean(runInfo.usedChallengeWindow),
    };
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
    visibleTextLength,
    findFullTextHTMLURL,
    hasUsableArticleBody,
    hasUsableArticleHTML,
    collectImageCandidates,
    selectImageURL,
  };
})();
