var AutoFullTextPdf = (function () {
  function pathJoin(base, name) {
    return OS.Path.join(base, name);
  }

  async function createWorkspace() {
    const path = pathJoin(
      Zotero.getTempDirectory().path,
      `zotero-auto-fulltext-${Zotero.Utilities.randomString(12)}`,
    );
    await OS.File.makeDir(path);
    return {
      path,
      file(name) {
        return pathJoin(path, name);
      },
      async writeText(name, content) {
        const target = pathJoin(path, name);
        await Zotero.File.putContentsAsync(target, String(content), "UTF-8");
        return target;
      },
      async cleanup() {
        await OS.File.removeDir(path, { ignoreAbsent: true });
      },
    };
  }

  const officeExtensions = new Set([
    "doc", "docx", "rtf", "txt", "htm", "html", "xml", "odt",
    "tif", "tiff", "jpg", "jpeg", "png", "bmp", "svg",
    "xls", "xlsx", "csv", "ods", "ppt", "pptx", "odp",
  ]);
  let rootURI = "";

  function setRootURI(value) {
    rootURI = typeof value === "string" ? value : "";
  }

  function windowsScriptHost() {
    if (Zotero.platform !== "win32") {
      throw new Error("Non-PDF SI conversion currently requires Windows with Microsoft Office installed.");
    }
    const file = Services.dirsvc.get("WinD", Components.interfaces.nsIFile);
    file.append("System32");
    file.append("cscript.exe");
    if (!file.exists() || !file.isExecutable()) {
      throw new Error("Windows Script Host (cscript.exe) is unavailable.");
    }
    return file;
  }

  async function convertToPdf(sourcePath, workspace, signal = null) {
    if (signal?.aborted) {
      const cancelled = new Error("Office conversion cancelled.");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    const source = Zotero.File.pathToFile(sourcePath);
    const header = await Zotero.File.getBinaryContentsAsync(source, 5);
    if (header.startsWith("%PDF-")) return sourcePath;

    const extension = String(source.leafName).split(".").pop().toLowerCase();
    if (!officeExtensions.has(extension)) {
      throw new Error(`No Microsoft Office PDF converter is configured for .${extension} files.`);
    }
    if (!rootURI) throw new Error("The plugin resource root is unavailable for Office conversion.");

    const baseURI = rootURI.endsWith("/") ? rootURI : `${rootURI}/`;
    const scriptURL = `${baseURI}content/office-to-pdf.vbs`;
    const script = Zotero.File.getContentsFromURL(scriptURL);
    if (!script || !script.includes("ConvertWithWord")) {
      throw new Error("The bundled Microsoft Office conversion script could not be loaded.");
    }
    const scriptPath = workspace.file("office-to-pdf.vbs");
    await Zotero.File.putContentsAsync(scriptPath, script, "UTF-8");

    const safeInput = workspace.file(
      `si-${Zotero.Utilities.randomString(8)}-${Zotero.File.getValidFileName(source.leafName)}`,
    );
    await OS.File.copy(sourcePath, safeInput);
    const outputName = safeInput.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    const outputPath = workspace.file(`${outputName}.pdf`);
    const converter = windowsScriptHost();
    const process = Components.classes["@mozilla.org/process/util;1"].createInstance(
      Components.interfaces.nsIProcess,
    );
    process.init(converter);
    process.startHidden = true;
    process.noShell = true;
    const args = ["//B", "//NoLogo", scriptPath, safeInput, outputPath];
    if (typeof process.runwAsync === "function") {
      process.runwAsync(args, args.length);
    } else {
      process.runAsync(args, args.length);
    }

    const startedAt = Date.now();
    while (process.isRunning && Date.now() - startedAt < 180000) {
      if (signal?.aborted) {
        process.kill();
        const killStartedAt = Date.now();
        while (process.isRunning && Date.now() - killStartedAt < 10000) {
          await Zotero.Promise.delay(100);
        }
        if (process.isRunning) throw new Error("Office conversion was cancelled but the converter did not exit after termination.");
        throw Object.assign(new Error("Microsoft Office conversion cancelled."), { name: "AbortError" });
      }
      await Zotero.Promise.delay(250);
    }
    if (process.isRunning) {
      process.kill();
      const killStartedAt = Date.now();
      while (process.isRunning && Date.now() - killStartedAt < 10000) {
        await Zotero.Promise.delay(100);
      }
      if (process.isRunning) {
        throw new Error("Microsoft Office conversion timed out; the converter did not exit after termination.");
      }
      throw new Error("Microsoft Office conversion timed out after 180 seconds.");
    }
    if (process.exitValue !== 0) {
      throw new Error(`Microsoft Office conversion failed with exit code ${process.exitValue}. Check that the matching Office app is installed and can open this file type.`);
    }
    const output = Zotero.File.pathToFile(outputPath);
    if (!output.exists() || output.fileSize < 5) throw new Error("Microsoft Office produced no PDF output.");
    const convertedHeader = await Zotero.File.getBinaryContentsAsync(output, 5);
    if (!convertedHeader.startsWith("%PDF-")) throw new Error("The converted file is not a valid PDF.");
    return outputPath;
  }

  function waitForLoad(browser, expectedURL, signal = null) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        browser.removeEventListener("load", onLoad, true);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Timed out loading HTML for PDF export.")), 30000);
      const onLoad = () => {
        if (browser.currentURI?.spec !== expectedURL) return;
        finish();
      };
      const onAbort = () => {
        const error = new Error("PDF export cancelled.");
        error.name = "AbortError";
        finish(error);
      };
      browser.addEventListener("load", onLoad, true);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function waitForStylesheets(doc) {
    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    await Promise.all(links.map((link) => new Promise((resolve, reject) => {
      if (link.sheet) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error(`Stylesheet load timeout: ${link.href}`)), 30000);
      link.addEventListener("load", () => {
        clearTimeout(timer);
        if (link.sheet) resolve();
        else reject(new Error(`Stylesheet could not be applied: ${link.href}`));
      }, { once: true });
      link.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Stylesheet failed to load: ${link.href}`));
      }, { once: true });
    })));
  }

  async function waitForImages(doc) {
    await Promise.all(Array.from(doc.images, (image) => new Promise((resolve, reject) => {
      if (image.complete) {
        if (image.naturalWidth > 0) resolve();
        else reject(new Error(`Image failed to load: ${image.currentSrc || image.src}`));
        return;
      }
      const timer = setTimeout(() => reject(new Error(`Image load timeout: ${image.src}`)), 30000);
      image.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
      image.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`Image failed: ${image.src}`)); }, { once: true });
    })));
  }

  async function printHtmlToPdf(html, outputPath, workspace, signal = null) {
    if (signal?.aborted) {
      const cancelled = new Error("PDF export cancelled.");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    const htmlPath = workspace.file("document.html");
    await Zotero.File.putContentsAsync(htmlPath, html, "UTF-8");
    const fileURL = Zotero.File.pathToFileURI(htmlPath);
    const win = Zotero.getMainWindow();
    if (!win) throw new Error("Zotero main window is unavailable.");

    const browser = win.document.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("remote", "false");
    browser.style.cssText = "position:fixed;left:-12000px;top:0;width:1024px;height:768px;opacity:0;pointer-events:none;";
    win.document.documentElement.appendChild(browser);

    try {
      const loaded = waitForLoad(browser, fileURL, signal);
      browser.setAttribute("src", fileURL);
      await loaded;
      const doc = browser.contentDocument;
      if (!doc) throw new Error("Could not read the generated HTML document.");
      await waitForStylesheets(doc);
      await waitForImages(doc);
      if (doc.fonts?.ready) await doc.fonts.ready;

      const printSettingsService = Components.classes["@mozilla.org/gfx/printsettings-service;1"].getService(
        Components.interfaces.nsIPrintSettingsService,
      );
      const settings = printSettingsService.createNewPrintSettings();
      settings.printSilent = true;
      settings.outputDestination = settings.kOutputDestinationFile;
      settings.outputFormat = settings.kOutputFormatPDF;
      settings.toFileName = outputPath;
      settings.printBGColors = true;
      settings.printBGImages = true;
      settings.headerStrLeft = "";
      settings.headerStrCenter = "";
      settings.headerStrRight = "";
      settings.footerStrLeft = "";
      settings.footerStrCenter = "";
      settings.footerStrRight = "";

      const requestor = browser.contentWindow.docShell.QueryInterface(
        Components.interfaces.nsIInterfaceRequestor,
      );
      const printer = requestor.getInterface(Components.interfaces.nsIWebBrowserPrint);
      const completion = new Promise((resolve, reject) => {
        const listener = {
          onStateChange(webProgress, request, flags, status) {
            const isStop = flags & Components.interfaces.nsIWebProgressListener.STATE_STOP;
            if (!isStop) return;
            if (status !== Components.results.NS_OK) reject(new Error(`PDF print failed: ${status}`));
            else resolve();
          },
          onProgressChange() {},
          onLocationChange() {},
          onStatusChange() {},
          onSecurityChange() {},
        };
        try {
          printer.print(settings, listener);
        } catch (error) {
          reject(error);
        }
      });
      let timeoutID;
      let onAbort;
      const timeout = new Promise((_, reject) => {
        timeoutID = setTimeout(() => reject(new Error("PDF print timed out.")), 120000);
      });
      const cancelled = signal ? new Promise((_, reject) => {
        onAbort = () => reject(Object.assign(new Error("PDF export cancelled."), { name: "AbortError" }));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }) : new Promise(() => {});
      try {
        await Promise.race([completion, timeout, cancelled]);
      } finally {
        clearTimeout(timeoutID);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) throw Object.assign(new Error("PDF export cancelled."), { name: "AbortError" });

      const output = Zotero.File.pathToFile(outputPath);
      if (!output.exists() || output.fileSize < 5) throw new Error("PDF print produced an empty file.");
      const header = await Zotero.File.getBinaryContentsAsync(output, 5);
      if (!header.startsWith("%PDF-")) throw new Error("PDF export did not produce a valid PDF file.");
    } finally {
      browser.remove();
    }
  }

  async function attachPdf(parentItemID, filePath, title) {
    return Zotero.Attachments.importFromFile({
      file: Zotero.File.pathToFile(filePath),
      parentItemID,
      title,
      contentType: "application/pdf",
    });
  }

  function makePdfPage(content, baseURL, title) {
    const safeTitle = escapeAttribute(String(title || "全文翻译").replace(/[<>]/g, ""));
    const safeContent = String(content || "").replace(/<base\b[^>]*>/gi, "");
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"><title>${safeTitle}</title>
<style>
@page { size:A4; margin:18mm 17mm 20mm; }
html { color:#202124; background:#fff; font-family:"Noto Serif CJK SC","Songti SC","SimSun",serif; font-size:10.5pt; line-height:1.75; }
body { max-width:100%; margin:0 auto; overflow-wrap:anywhere; }
h1 { font-size:20pt; line-height:1.35; margin:0 0 1.4em; break-after:avoid; }
h2 { font-size:15pt; margin:1.7em 0 .6em; break-after:avoid; }
h3,h4,h5,h6 { font-size:12pt; margin:1.3em 0 .5em; break-after:avoid; }
p,li,td,th,figcaption { orphans:3; widows:3; }
figure,img,table,pre,blockquote { max-width:100%; break-inside:avoid; }
img,svg,video { max-width:100%; height:auto; }
table { border-collapse:collapse; width:100%; font-size:9pt; }
th,td { border:1px solid #999; padding:4px 6px; }
a { color:#1558a6; text-decoration:underline; }
</style></head><body>${safeContent}</body></html>`;
  }

  function escapeAttribute(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function makeWebsitePdfPage(content, baseURL, title, styles, bodyAttributes) {
    const attr = (name, value) => value ? ` ${name}="${escapeAttribute(value)}"` : "";
    const styleMarkup = (styles || []).map((style) => {
      if (style.href) return "";
      const closeStyle = new RegExp("<" + "/" + "style", "gi");
      const css = String(style.text || "").replace(closeStyle, "<" + String.fromCharCode(92) + "/style");
      return `<style${attr("media", style.media)}>${css}</style>`;
    }).join("\n");

    const safeTitle = String(title || "全文翻译").replace(/[<>]/g, "");
    const safeContent = String(content || "").replace(/<base\b[^>]*>/gi, "");
    const bodyMarkup = Object.entries(bodyAttributes || {}).map(([name, value]) =>
      ` ${name}="${escapeAttribute(value)}"`,
    ).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"><title>${escapeAttribute(safeTitle)}</title>${styleMarkup}<style>
@media print {
  *, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  img, svg, video { max-width: 100%; }
  img, figure, table, pre, blockquote { break-inside: avoid; }
  a { -webkit-print-color-adjust: exact !important; }
}
</style></head><body${bodyMarkup}>${safeContent}</body></html>`;
  }

    return { setRootURI, createWorkspace, convertToPdf, printHtmlToPdf, attachPdf, makePdfPage, makeWebsitePdfPage };
})();
