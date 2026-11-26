/* Runs in Zotero's Settings window sandbox and hands the inserted pane root to the plugin. */
document.addEventListener("load", function mount(event) {
  if (event.target.id !== "zotero-auto-fulltext-pane") return;
  document.removeEventListener("load", mount, true);
  Services.obs.notifyObservers(
    { wrappedJSObject: { root: event.target, win: window } },
    "zotero-auto-fulltext:prefpane",
  );
}, true);
