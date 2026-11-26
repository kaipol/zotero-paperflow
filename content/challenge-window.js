/* Interactive publisher verification window modeled after Zotero Connector's challenge flow. */
(function () {
  const MAX_POLL_MS = 300000;
  const POLL_INTERVAL_MS = 450;
  const HYDRATION_SETTLE_MS = 3200;
  const CHALLENGE_ORIGINS = [
    "https://challenges.cloudflare.com",
    "https://brunhild.challenges.cloudflare.com",
  ];
  const TEMP_PREF_OVERRIDES = [
    ["network.cookie.cookieBehavior", "int", 0],
    ["privacy.partition.network_state", "bool", false],
    ["privacy.firstparty.isolate", "bool", false],
    ["privacy.trackingprotection.enabled", "bool", false],
    ["privacy.trackingprotection.pbmode.enabled", "bool", false],
    ["privacy.trackingprotection.socialtracking.enabled", "bool", false],
    ["privacy.trackingprotection.fingerprinting.enabled", "bool", false],
    ["privacy.trackingprotection.cryptomining.enabled", "bool", false],
    ["privacy.annotate_channels.strict_list.enabled", "bool", false],
    ["network.http.referer.XOriginPolicy", "int", 0],
    ["network.http.sendRefererHeader", "int", 2],
    ["dom.storage.enabled", "bool", true],
    ["javascript.enabled", "bool", true],
  ];

  function isPrivateOrLocalHost(host) {
    const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!value) return true;
    if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local") || value.endsWith(".internal") ||
      value.endsWith(".test") || value.endsWith(".example") || value.endsWith(".invalid") || value.endsWith(".home.arpa")) {
      return true;
    }
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
      if (mappedDotted) return isPrivateOrLocalHost(mappedDotted[1]);
      const normalized = value.replace(/^::ffff:/, "");
      const hexPair = normalized.match(/^([\da-f]{1,4}):([\da-f]{1,4})$/i);
      if (hexPair) {
        const first = Number.parseInt(hexPair[1], 16);
        const second = Number.parseInt(hexPair[2], 16);
        return isPrivateOrLocalHost(`${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`);
      }
      return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
        value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
    }
    return !value.includes(".");
  }

  function resolveSession() {
    const rawArgs = window.arguments?.[0];
    let session = rawArgs?.wrappedJSObject || rawArgs || null;
    if (!session) {
      try {
        const sid = new URL(window.location?.href || "").searchParams.get("sid") || "";
        const registry = window.opener?.Zotero?._autoFullTextChallengeSessions;
        if (sid && registry?.has?.(sid)) {
          session = registry.get(sid);
          registry.delete(sid);
        }
      } catch {
        // Ignore fallback lookup failure.
      }
    }
    return session;
  }

  const initialSession = resolveSession();
  try {
    initialSession?.onWindowReady?.(window);
  } catch {
    // Ignore ready callback failure.
  }

  function init() {
    const session = initialSession || resolveSession();
    const statusEl = document.getElementById("si-challenge-status");
    const urlEl = document.getElementById("si-challenge-url");
    const reloadBtn = document.getElementById("si-challenge-reload");
    const extractBtn = document.getElementById("si-challenge-extract");
    const cancelBtn = document.getElementById("si-challenge-cancel");
    const browser = document.getElementById("si-challenge-browser");

    const windowAbortController = typeof AbortController === "function" ? new AbortController() : null;
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let navRetryTimer = null;
    let readyRetryTimer = null;
    let progressListener = null;
    let httpModifyObserver = null;
    let httpResponseObserver = null;
    let quitObserver = null;
    let savedPrefs = [];
    let pageVerifiedAt = 0;
    let lastVerifiedURL = "";
    let inDownloadPhase = false;
    let mode = session?.mode || "article";
    let targetURL = session?.url || "";
    let secondaryTargetHost = "";
    let forceExtractRequested = false;
    let secondaryResolve = null;
    let secondaryReject = null;
    const observedHosts = new Set(["challenges.cloudflare.com", "brunhild.challenges.cloudflare.com"]);

    function debugLog(message, error) {
      try {
        const suffix = error ? `: ${String(error?.message || error)}` : "";
        window.opener?.Zotero?.debug?.(`[Zotero PaperFlow][Challenge] ${message}${suffix}`);
      } catch {
        // Ignore debug log failures in minimal environments.
      }
    }

    function setStatus(text, currentURL = "") {
      const normalized = String(text || "");
      if (statusEl) statusEl.textContent = normalized;
      if (urlEl && currentURL) urlEl.textContent = String(currentURL);
      try {
        session?.onStatus?.(normalized, currentURL);
      } catch {
        // Ignore status callback error.
      }
    }

    function isHostBlocked(host) {
      if (typeof session?.isBlockedHost === "function") return Boolean(session.isBlockedHost(host));
      return isPrivateOrLocalHost(host);
    }

    function getServices() {
      if (typeof Services !== "undefined" && Services) return Services;
      try {
        if (window.Services) return window.Services;
      } catch {}
      try {
        if (window.opener?.Services) return window.opener.Services;
      } catch {}
      return null;
    }

    function applyTempPrefs() {
      const svc = getServices();
      if (!svc?.prefs) return;
      const prefs = svc.prefs;
      for (const [name, type, desired] of TEMP_PREF_OVERRIDES) {
        try {
          const hadUserValue = typeof prefs.prefHasUserValue === "function" && prefs.prefHasUserValue(name);
          const current = type === "int"
            ? prefs.getIntPref(name, desired)
            : prefs.getBoolPref(name, desired);
          if (current === desired) continue;
          savedPrefs.push({ name, type, hadUserValue, previous: current });
          if (type === "int") prefs.setIntPref(name, desired);
          else prefs.setBoolPref(name, desired);
        } catch {
          // Some Gecko builds omit optional tracking-protection prefs.
        }
      }
    }

    function restoreTempPrefs() {
      const svc = getServices();
      if (!svc?.prefs) {
        savedPrefs = [];
        return;
      }
      const prefs = svc.prefs;
      while (savedPrefs.length) {
        const entry = savedPrefs.pop();
        try {
          if (!entry.hadUserValue && typeof prefs.clearUserPref === "function") {
            prefs.clearUserPref(entry.name);
          } else if (entry.type === "int") {
            prefs.setIntPref(entry.name, entry.previous);
          } else {
            prefs.setBoolPref(entry.name, entry.previous);
          }
        } catch {
          // Ignore cleanup failure during window teardown.
        }
      }
    }

    function allowCookiesForOrigins(origins) {
      const svc = getServices();
      if (!svc?.perms || !svc?.scriptSecurityManager) return;
      const ssm = svc.scriptSecurityManager;
      const allow = svc.perms.ALLOW_ACTION ?? 1;
      const expireSession = svc.perms.EXPIRE_SESSION ?? 1;
      for (const origin of origins) {
        if (!origin) continue;
        try {
          const principal = typeof ssm.createContentPrincipalFromOrigin === "function"
            ? ssm.createContentPrincipalFromOrigin(origin)
            : ssm.createContentPrincipal?.(svc.io.newURI(origin), {});
          if (!principal) continue;
          if (typeof svc.perms.addFromPrincipal === "function") {
            svc.perms.addFromPrincipal(principal, "cookie", allow, expireSession);
          }
        } catch {
          // Ignore unsupported permission API variants.
        }
      }
    }

    function trackOriginForURL(url) {
      try {
        const parsed = new URL(url);
        if (!/^https?:$/i.test(parsed.protocol)) return;
        const host = parsed.hostname.toLowerCase();
        if (isHostBlocked(host)) return;
        if (!observedHosts.has(host)) {
          observedHosts.add(host);
          allowCookiesForOrigins([parsed.origin, ...CHALLENGE_ORIGINS]);
        }
      } catch {
        // Ignore non-HTTP(S) URLs.
      }
    }

    function matchesObservedHost(hostname) {
      const host = String(hostname || "").toLowerCase();
      if (!host) return false;
      if (observedHosts.has(host)) return true;
      return host === "challenges.cloudflare.com" || host.endsWith(".challenges.cloudflare.com");
    }

    function isChannelFromChallengeBrowser(channel) {
      try {
        const topBC = browser?.browsingContext;
        const channelBC = channel?.loadInfo?.browsingContext;
        if (topBC && channelBC && (channelBC === topBC || channelBC.top === topBC)) return true;
      } catch {
        // Ignore unavailable loadInfo browsingContext.
      }
      return false;
    }

    function attachObservers(userAgent) {
      const svc = getServices();
      if (!svc?.obs?.addObserver) return;

      httpModifyObserver = {
        observe(subject, topic) {
          if (topic !== "http-on-modify-request") return;
          try {
            const channel = typeof Components !== "undefined" && Components.interfaces?.nsIHttpChannel
              ? subject.QueryInterface(Components.interfaces.nsIHttpChannel)
              : subject;
            const scheme = String(channel?.URI?.scheme || "").toLowerCase();
            if (scheme !== "http" && scheme !== "https") return;
            const host = String(channel?.URI?.host || "").toLowerCase();
            const fromOurBrowser = isChannelFromChallengeBrowser(channel);

            if (fromOurBrowser && isHostBlocked(host)) {
              const abortCode = typeof Components !== "undefined" && Components.results?.NS_ERROR_ABORT
                ? Components.results.NS_ERROR_ABORT
                : 0x80004004;
              channel.cancel?.(abortCode);
              return;
            }

            if (!fromOurBrowser && !matchesObservedHost(host)) return;
            if (userAgent) {
              channel.setRequestHeader?.("User-Agent", userAgent, false);
            }
          } catch {
            // Ignore non-HTTP channels or restricted headers.
          }
        },
      };

      httpResponseObserver = {
        observe(subject, topic) {
          if (topic !== "http-on-examine-response" || mode !== "secondary" || !secondaryResolve || settled) return;
          try {
            const channel = typeof Components !== "undefined" && Components.interfaces?.nsIHttpChannel
              ? subject.QueryInterface(Components.interfaces.nsIHttpChannel)
              : subject;
            const host = String(channel?.URI?.host || "").toLowerCase();
            if (!secondaryTargetHost || host !== secondaryTargetHost) return;
            const status = Number(channel?.responseStatus || 0);
            if (status < 200 || status >= 300) return;
            let cfMitigated = "";
            let disposition = "";
            let contentType = "";
            try { cfMitigated = String(channel.getResponseHeader?.("cf-mitigated") || "").trim().toLowerCase(); } catch {}
            try { disposition = String(channel.getResponseHeader?.("content-disposition") || "").trim().toLowerCase(); } catch {}
            try { contentType = String(channel.getResponseHeader?.("content-type") || "").split(";")[0].trim().toLowerCase(); } catch {}
            if (cfMitigated === "challenge") return;
            const isFileDownload = /^\s*attachment\b/i.test(disposition) ||
              (contentType && !["text/html", "application/xhtml+xml"].includes(contentType));
            if (!isFileDownload) return;

            const cancelCode = typeof Components !== "undefined" && Components.results?.NS_BINDING_ABORTED
              ? Components.results.NS_BINDING_ABORTED
              : 0x804b0002;
            try { channel.cancel?.(cancelCode); } catch {}
            const resolveSecondary = secondaryResolve;
            secondaryResolve = null;
            secondaryReject = null;
            inDownloadPhase = true;
            stopMonitoring();
            const resolvedURL = channel?.URI?.spec || targetURL;
            setStatus("二次安全验证已通过，正在自动下载 SI 附件…", resolvedURL);
            resolveSecondary({ responseURL: resolvedURL, doc: null });
          } catch {
            // Ignore inspection errors on non-HTTP channels.
          }
        },
      };

      quitObserver = {
        observe(_subject, topic) {
          if (topic === "quit-application-granted") restoreTempPrefs();
        },
      };

      try { svc.obs.addObserver(httpModifyObserver, "http-on-modify-request"); } catch { httpModifyObserver = null; }
      try { svc.obs.addObserver(httpResponseObserver, "http-on-examine-response"); } catch { httpResponseObserver = null; }
      try { svc.obs.addObserver(quitObserver, "quit-application-granted"); } catch { quitObserver = null; }
    }

    function detachObservers() {
      const svc = getServices();
      if (httpModifyObserver) {
        try { svc?.obs?.removeObserver?.(httpModifyObserver, "http-on-modify-request"); } catch {}
        httpModifyObserver = null;
      }
      if (httpResponseObserver) {
        try { svc?.obs?.removeObserver?.(httpResponseObserver, "http-on-examine-response"); } catch {}
        httpResponseObserver = null;
      }
      if (quitObserver) {
        try { svc?.obs?.removeObserver?.(quitObserver, "quit-application-granted"); } catch {}
        quitObserver = null;
      }
    }

    function configureBrowser(userAgent) {
      if (!browser) return;
      try {
        if (userAgent && browser.browsingContext) {
          browser.browsingContext.customUserAgent = userAgent;
        }
      } catch {
        // Older or mocked environments may not support customUserAgent.
      }
      try {
        const docShell = browser.docShell;
        if (docShell) {
          docShell.allowJavascript = true;
          docShell.allowImages = true;
          docShell.allowSubframes = true;
          docShell.allowMetaRedirects = true;
          docShell.allowAuth = true;
          docShell.allowWindowControl = true;
          if ("allowMedia" in docShell) docShell.allowMedia = true;
          if ("allowDNSPrefetch" in docShell) docShell.allowDNSPrefetch = true;
        }
      } catch {
        // Ignore read-only docShell flags in mocked or restricted contexts.
      }
    }

    function normalizeHttpURL(raw) {
      const value = String(raw || "").trim();
      return /^https?:\/\//i.test(value) ? value : "";
    }

    function clearNavRetry() {
      if (navRetryTimer) {
        clearTimeout(navRetryTimer);
        navRetryTimer = null;
      }
    }

    function tryNavigateMethod(url, methodIndex) {
      const svc = getServices();
      const ssm = svc?.scriptSecurityManager;
      const systemPrincipal = ssm?.getSystemPrincipal?.();
      const nullPrincipal = ssm?.createNullPrincipal?.({});
      if (methodIndex === 0 && typeof browser.fixupAndLoadURIString === "function" && systemPrincipal) {
        browser.fixupAndLoadURIString(url, { triggeringPrincipal: systemPrincipal });
        return true;
      }
      if (methodIndex === 1 && typeof browser.loadURI === "function" && svc?.io?.newURI && systemPrincipal) {
        browser.loadURI(svc.io.newURI(url), { triggeringPrincipal: systemPrincipal });
        return true;
      }
      if (methodIndex === 2 && typeof browser.webNavigation?.loadURI === "function" && systemPrincipal) {
        browser.webNavigation.loadURI(url, { triggeringPrincipal: systemPrincipal });
        return true;
      }
      if (methodIndex === 3 && typeof browser.fixupAndLoadURIString === "function" && nullPrincipal) {
        browser.fixupAndLoadURIString(url, { triggeringPrincipal: nullPrincipal });
        return true;
      }
      if (methodIndex === 4 && typeof browser.contentWindow?.location?.assign === "function") {
        browser.contentWindow.location.assign(url);
        return true;
      }
      if (methodIndex === 5 && typeof browser.setAttribute === "function") {
        browser.setAttribute("src", url);
        return true;
      }
      return false;
    }

    function navigate(url, startMethodIndex = 0) {
      if (!browser || !url) return;
      targetURL = url;
      clearNavRetry();
      configureBrowser(session?.userAgent || "");
      trackOriginForURL(url);
      allowCookiesForOrigins(CHALLENGE_ORIGINS);
      setStatus("正在加载出版商页面…", url);

      let dispatchedMethod = -1;
      for (let methodIndex = startMethodIndex; methodIndex <= 5; methodIndex += 1) {
        try {
          if (tryNavigateMethod(url, methodIndex)) {
            dispatchedMethod = methodIndex;
            break;
          }
        } catch (error) {
          debugLog(`Navigation method ${methodIndex} failed for ${url}`, error);
        }
      }

      if (dispatchedMethod < 0) {
        debugLog(`No available browser navigation method succeeded for ${url}`);
        return;
      }

      const nextMethodIndex = dispatchedMethod + 1;
      if (nextMethodIndex <= 5) {
        navRetryTimer = setTimeout(() => {
          navRetryTimer = null;
          if (settled || inDownloadPhase || targetURL !== url) return;
          if (currentLocation()) return;
          try {
            if (browser?.webProgress?.isLoadingDocument) return;
          } catch {
            // Ignore unreadable webProgress.
          }
          debugLog(`Browser still at about:blank after method ${dispatchedMethod}; retrying with method ${nextMethodIndex}`);
          navigate(url, nextMethodIndex);
        }, 1200);
      }
    }

    function isChallengeDoc(doc, currentURL) {
      if (typeof session?.isChallengeDocument === "function") {
        return Boolean(session.isChallengeDocument(doc, currentURL));
      }
      if (!doc || !doc.documentElement || !/^https?:\/\//i.test(String(currentURL || ""))) return true;
      const title = String(doc.title || "");
      if (/just a moment|attention required|checking your browser|one more step|verify you are human|security check|ddos-guard|请稍候|正在检查|安全验证/i.test(title)) {
        return true;
      }
      if (typeof doc.querySelector === "function" && doc.querySelector(
        '#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running, #cf-wrapper, #turnstile-wrapper, .cf-browser-verification, .cf-turnstile, input[name="cf-turnstile-response"], form[action*="__cf_chl"], iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha, #px-captcha',
      )) {
        return true;
      }
      const htmlPrefix = String(doc.documentElement.outerHTML || "").slice(0, 16384);
      if (/Enable JavaScript and cookies to continue|Checking if the site connection is secure/i.test(htmlPrefix)) {
        return true;
      }
      return /\/cdn-cgi\/challenge-platform\//i.test(htmlPrefix) &&
        /(?:\b_cf_chl_opt\b|challenge-error-text|cf-browser-verification|managed_checking_msg)/i.test(htmlPrefix);
    }

    function isLoginOrAuthDoc(doc, currentURL) {
      try {
        if (typeof doc?.querySelector === "function" && doc.querySelector('input[type="password"]')) {
          return true;
        }
      } catch {
        // Ignore query errors.
      }
      return /(?:\/(?:login|signin|sign-in|auth|sso|shibboleth|wayf|openathens|idp)\b)/i.test(String(currentURL || ""));
    }

    function currentLocation() {
      try {
        const fromURI = normalizeHttpURL(browser?.currentURI?.spec);
        if (fromURI) return fromURI;
      } catch {
        // Fall through to contentDocument URL.
      }
      try {
        const fromDoc = normalizeHttpURL(browser?.contentDocument?.location?.href);
        if (fromDoc) return fromDoc;
      } catch {
        // Fall through to contentWindow URL.
      }
      try {
        return normalizeHttpURL(browser?.contentWindow?.location?.href);
      } catch {
        return "";
      }
    }

    function isDOIRedirectHost(url) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        return host === "doi.org" || host === "dx.doi.org";
      } catch {
        return false;
      }
    }

    function hasMeaningfulBody(doc) {
      try {
        const body = doc?.body;
        if (!body) return false;
        const children = body.children?.length || 0;
        const textLen = String(body.textContent || "").trim().length;
        return children > 0 || textLen > 40;
      } catch {
        return false;
      }
    }

    function stopMonitoring() {
      clearNavRetry();
      if (readyRetryTimer) {
        clearTimeout(readyRetryTimer);
        readyRetryTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (progressListener && browser && typeof browser.removeProgressListener === "function") {
        try {
          browser.removeProgressListener(progressListener);
        } catch {
          // Ignore if browser already detached.
        }
      }
      progressListener = null;
    }

    function cleanup() {
      stopMonitoring();
      detachObservers();
      if (session?.signal) {
        try {
          session.signal.removeEventListener("abort", onAbort);
        } catch {
          // Ignore.
        }
      }
      restoreTempPrefs();
    }

    function closeSafely() {
      cleanup();
      try {
        window.close();
      } catch {
        // Ignore in mocked windows.
      }
    }

    function failSession(error) {
      if (settled) return;
      settled = true;
      windowAbortController?.abort();
      const reject = session?.reject;
      closeSafely();
      reject?.(error);
    }

    function succeedSession(payload) {
      if (settled) return;
      settled = true;
      const resolve = session?.resolve;
      closeSafely();
      resolve?.(payload);
    }

    function onAbort() {
      const error = new Error("Supporting information verification cancelled.");
      error.name = "AbortError";
      failSession(error);
    }

    async function fetchInWindow(fileURL, referrerURL, maxBytes) {
      const contentWin = browser?.contentWindow;
      if (!contentWin || typeof contentWin.fetch !== "function") {
        throw Object.assign(new Error("Challenge window fetch API is unavailable."), { name: "ChallengeFetchUnavailable" });
      }
      const currentURL = currentLocation();
      if (currentURL) {
        try {
          if (new URL(fileURL).origin !== new URL(currentURL).origin) {
            throw Object.assign(new Error("Cross-origin SI URL uses session HTTP download."), { name: "ChallengeFetchCrossOrigin" });
          }
        } catch (error) {
          if (error?.name === "ChallengeFetchCrossOrigin") throw error;
        }
      }
      trackOriginForURL(fileURL);
      const controller = typeof contentWin.AbortController === "function"
        ? new contentWin.AbortController()
        : (typeof AbortController === "function" ? new AbortController() : null);
      const abort = () => controller?.abort();
      session?.signal?.addEventListener("abort", abort, { once: true });
      windowAbortController?.signal?.addEventListener("abort", abort, { once: true });
      if (session?.signal?.aborted || windowAbortController?.signal?.aborted) abort();
      let oversized = false;
      try {
        const response = await contentWin.fetch(fileURL, {
          method: "GET",
          credentials: "include",
          redirect: "follow",
          cache: "no-store",
          referrer: referrerURL || undefined,
          headers: {
            Accept: "application/pdf,application/octet-stream,*/*;q=0.5",
          },
          signal: controller?.signal,
        });
        if (response.type === "opaque" || response.type === "opaqueredirect") {
          throw Object.assign(new Error("Opaque fetch response cannot be inspected."), { name: "ChallengeFetchOpaque" });
        }
        const contentLength = Number.parseInt(response.headers?.get?.("content-length") || "0", 10) || 0;
        if (contentLength > maxBytes) {
          oversized = true;
          abort();
          throw new Error("Supporting file exceeds the 100 MB download limit.");
        }

        let bytes;
        if (response.body && typeof response.body.getReader === "function") {
          const reader = response.body.getReader();
          const chunks = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            total += chunk.byteLength;
            if (total > maxBytes) {
              oversized = true;
              try { await reader.cancel(); } catch {}
              abort();
              throw new Error("Supporting file exceeds the 100 MB download limit.");
            }
            chunks.push(chunk);
          }
          bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        } else {
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > maxBytes) {
            oversized = true;
            throw new Error("Supporting file exceeds the 100 MB download limit.");
          }
          bytes = new Uint8Array(buffer);
        }

        return {
          status: Number(response.status || 0),
          type: String(response.type || ""),
          responseURL: response.url || fileURL,
          bytes,
          getHeader(name) {
            return response.headers?.get?.(name) || "";
          },
        };
      } catch (error) {
        if (oversized) throw new Error("Supporting file exceeds the 100 MB download limit.");
        throw error;
      } finally {
        session?.signal?.removeEventListener("abort", abort);
        windowAbortController?.signal?.removeEventListener("abort", abort);
      }
    }

    function createSessionHandle() {
      return {
        signal: windowAbortController?.signal || null,
        setStatus,
        fetchInWindow,
        navigateForSecondaryChallenge(nextURL) {
          return new Promise((resolve, reject) => {
            inDownloadPhase = false;
            mode = "secondary";
            pageVerifiedAt = 0;
            lastVerifiedURL = "";
            forceExtractRequested = false;
            try {
              secondaryTargetHost = new URL(nextURL).hostname.toLowerCase();
            } catch {
              secondaryTargetHost = "";
            }
            secondaryResolve = resolve;
            secondaryReject = reject;
            setStatus("SI 文件主机需要二次安全验证，等待自动跳过或请手动完成验证…", nextURL);
            navigate(nextURL);
            startPolling();
          });
        },
        close: closeSafely,
      };
    }

    function checkPageState() {
      if (settled || inDownloadPhase) return;
      const currentURL = currentLocation();
      if (!currentURL || !/^https?:\/\//i.test(currentURL)) return;
      trackOriginForURL(currentURL);
      if (urlEl) urlEl.textContent = currentURL;

      let doc;
      try {
        doc = browser?.contentDocument;
      } catch {
        return;
      }
      if (!doc || !doc.documentElement) return;
      if (isDOIRedirectHost(currentURL)) {
        setStatus("正在解析 DOI 并跳转至出版商页面…", currentURL);
        return;
      }

      const hasLink = typeof session?.hasSupportingLink === "function"
        ? Boolean(session.hasSupportingLink(doc, currentURL))
        : false;

      if (isChallengeDoc(doc, currentURL) && !(forceExtractRequested && hasLink)) {
        pageVerifiedAt = 0;
        lastVerifiedURL = "";
        forceExtractRequested = false;
        setStatus("检测到 Cloudflare / 安全验证，正在等待自动跳过；如出现验证框请手动点击完成…", currentURL);
        return;
      }

      const ready = doc.readyState === "interactive" || doc.readyState === "complete";
      if (!ready || !hasMeaningfulBody(doc)) return;

      if (mode === "secondary") {
        if (secondaryResolve) {
          inDownloadPhase = true;
          stopMonitoring();
          const resolveSecondary = secondaryResolve;
          secondaryResolve = null;
          secondaryReject = null;
          setStatus("二次安全验证已通过，正在自动下载 SI 附件…", currentURL);
          resolveSecondary({ responseURL: currentURL, doc });
        }
        return;
      }

      if (!hasLink && !forceExtractRequested && isLoginOrAuthDoc(doc, currentURL)) {
        pageVerifiedAt = 0;
        setStatus("检测到机构或账号登录页面，请完成登录，回到文章页后将自动提取 SI…", currentURL);
        return;
      }

      if (currentURL !== lastVerifiedURL) {
        lastVerifiedURL = currentURL;
        pageVerifiedAt = Date.now();
      }

      const elapsed = Date.now() - pageVerifiedAt;
      if (!hasLink && !forceExtractRequested && (doc.readyState !== "complete" || elapsed < HYDRATION_SETTLE_MS)) {
        setStatus("验证已通过，正在等待文章页及 SI 链接加载完成…", currentURL);
        return;
      }

      inDownloadPhase = true;
      stopMonitoring();
      setStatus("验证已通过，正在自动识别并下载 Supporting Information…", currentURL);
      const html = String(doc.documentElement.outerHTML || "");
      const handle = createSessionHandle();
      if (typeof session?.onVerified === "function") {
        Promise.resolve(session.onVerified({ doc, responseURL: currentURL, html, handle }))
          .then((result) => succeedSession(result))
          .catch((error) => failSession(error));
      } else {
        succeedSession({ doc, responseURL: currentURL, html, handle });
      }
    }

    function startPolling() {
      stopMonitoring();
      pollTimer = setInterval(checkPageState, POLL_INTERVAL_MS);
      timeoutTimer = setTimeout(() => {
        if (secondaryReject) {
          const rejectSecondary = secondaryReject;
          secondaryResolve = null;
          secondaryReject = null;
          rejectSecondary(new Error("等待二次安全验证超时。"));
          return;
        }
        failSession(Object.assign(new Error("等待出版商安全验证超时。"), {
          name: "SupportingInfoAccessError",
          publisherURL: targetURL,
        }));
      }, session?.timeoutMs || MAX_POLL_MS);

      if (browser && typeof browser.addProgressListener === "function") {
        progressListener = {
          QueryInterface(iid) {
            if (
              typeof Components !== "undefined" &&
              (iid.equals?.(Components.interfaces.nsIWebProgressListener) ||
                iid.equals?.(Components.interfaces.nsISupportsWeakReference) ||
                iid.equals?.(Components.interfaces.nsISupports))
            ) {
              return this;
            }
            return this;
          },
          onStateChange(_webProgress, _request, stateFlags) {
            const stopFlag = typeof Components !== "undefined"
              ? Components.interfaces?.nsIWebProgressListener?.STATE_STOP
              : 0x00000010;
            if (stateFlags & stopFlag) checkPageState();
          },
          onLocationChange(_webProgress, _request, location) {
            const nextURL = normalizeHttpURL(location?.spec);
            if (nextURL) {
              clearNavRetry();
              trackOriginForURL(nextURL);
              if (urlEl) urlEl.textContent = nextURL;
            }
            checkPageState();
          },
          onProgressChange() {},
          onStatusChange() {},
          onSecurityChange() {},
          onContentBlockingEvent() {},
        };
        try {
          browser.addProgressListener(progressListener);
        } catch {
          progressListener = null;
        }
      }
    }

    if (reloadBtn) {
      reloadBtn.addEventListener("click", () => {
        if (inDownloadPhase) return;
        pageVerifiedAt = 0;
        lastVerifiedURL = "";
        forceExtractRequested = false;
        const activeURL = currentLocation();
        if (activeURL && typeof browser?.reload === "function") {
          setStatus("正在重新加载页面…", activeURL);
          try { browser.reload(); return; } catch (error) {
            debugLog("browser.reload failed; falling back to navigate", error);
          }
        }
        navigate(activeURL || targetURL);
      });
    }

    if (extractBtn) {
      extractBtn.addEventListener("click", () => {
        if (inDownloadPhase) return;
        forceExtractRequested = true;
        checkPageState();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        const error = Object.assign(new Error("已取消安全验证，SI 尚未导入。"), {
          name: "SupportingInfoChallengeCancelledError",
          publisherURL: targetURL,
        });
        windowAbortController?.abort();
        if (secondaryReject) {
          const rejectSecondary = secondaryReject;
          secondaryResolve = null;
          secondaryReject = null;
          rejectSecondary(error);
        }
        failSession(error);
      });
    }

    window.addEventListener("unload", () => {
      if (settled) {
        cleanup();
        return;
      }
      const error = Object.assign(new Error("安全验证窗口已关闭，SI 尚未导入。"), {
        name: "SupportingInfoChallengeCancelledError",
        publisherURL: targetURL,
      });
      windowAbortController?.abort();
      if (secondaryReject) {
        const rejectSecondary = secondaryReject;
        secondaryResolve = null;
        secondaryReject = null;
        rejectSecondary(error);
      }
      settled = true;
      cleanup();
      session?.reject?.(error);
    });

    if (browser) {
      browser.addEventListener("DOMContentLoaded", checkPageState, true);
      browser.addEventListener("load", checkPageState, true);
    }

    if (session?.signal) {
      if (session.signal.aborted) {
        onAbort();
        return;
      }
      session.signal.addEventListener("abort", onAbort, { once: true });
    }

    applyTempPrefs();
    attachObservers(session?.userAgent || "");

    const startNavigationWhenReady = (attempt = 0) => {
      if (settled) return;
      const browserReady = Boolean(
        browser?.browsingContext ||
        browser?.docShell ||
        browser?.webNavigation ||
        attempt >= 20,
      );
      if (!browserReady) {
        readyRetryTimer = setTimeout(() => {
          readyRetryTimer = null;
          startNavigationWhenReady(attempt + 1);
        }, 50);
        return;
      }
      configureBrowser(session?.userAgent || "");
      startPolling();
      if (targetURL) {
        navigate(targetURL);
      } else {
        failSession(new Error("Challenge window was opened without a target URL."));
      }
    };
    startNavigationWhenReady(0);
  }

  if (document.readyState !== "complete" && typeof window.addEventListener === "function") {
    window.addEventListener("load", init, { once: true });
  } else {
    init();
  }
})();
