/* Loads plugin modules after Zotero's bootstrap globals are available. */
var AutoFullTextScope = null;
var AutoFullTextChromeHandle = null;

async function startup({ id, version, rootURI }, reason) {
  try {
    await Zotero.initializationPromise;
    if (typeof rootURI !== "string" || !rootURI) {
      throw new Error("Zotero did not provide the plugin rootURI to bootstrap startup.");
    }
    const baseURI = rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
    try {
      const aomStartup = Components?.classes?.["@mozilla.org/addons/addon-manager-startup;1"]
        ?.getService?.(Components.interfaces?.amIAddonManagerStartup);
      if (aomStartup && Services?.io?.newURI) {
        AutoFullTextChromeHandle?.destruct?.();
        AutoFullTextChromeHandle = aomStartup.registerChrome(Services.io.newURI(`${baseURI}manifest.json`), [
          ["content", "zotero-auto-fulltext", "content/"],
        ]);
      }
    } catch (chromeError) {
      Zotero.debug(`[Zotero PaperFlow] Dynamic chrome registration skipped: ${String(chromeError)}`);
    }
    const scope = {
      Zotero,
      Services,
      Components,
      ChromeUtils,
      URL,
      DOMParser,
      TextDecoder,
      TextEncoder,
      XMLSerializer,
      atob,
      btoa,
      setTimeout,
      clearTimeout,
      get AbortController() {
        return typeof AbortController === "function" ? AbortController : Zotero.getMainWindow()?.AbortController;
      },
      OS: ChromeUtils.importESModule(
        "chrome://zotero/content/osfile.mjs",
      ).OS,
    };
    const scripts = [
      "content/modules/core.js",
      "content/modules/pdf-export.js",
      "content/modules/translation-client.js",
      "content/modules/supporting-info.js",
      "content/modules/fulltext-translation.js",
      "content/modules/main.js",
    ];
    for (const script of scripts) {
      Services.scriptloader.loadSubScript(`${baseURI}${script}`, scope);
    }
    AutoFullTextScope = scope;
    await scope.AutoFullTextMain.startup({ id, version, rootURI });
  } catch (error) {
    Zotero.logError(error);
    Zotero.debug(`[Zotero PaperFlow] Startup failed: ${String(error)}\n${error?.stack || ""}`);
  }
}

function install() {}
function uninstall() {}

async function shutdown(data, reason) {
  try {
    await AutoFullTextScope?.AutoFullTextMain?.shutdown(data, reason);
  } catch (error) {
    Zotero.logError(error);
  } finally {
    try {
      AutoFullTextChromeHandle?.destruct?.();
    } catch (chromeError) {
      Zotero.logError(chromeError);
    }
    AutoFullTextChromeHandle = null;
    AutoFullTextScope = null;
  }
}
