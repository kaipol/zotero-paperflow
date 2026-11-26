var AutoFullTextMain = (function () {
  const PANE_TOPIC = "zotero-auto-fulltext:prefpane";
  const MENU_ID = "zotero-auto-fulltext-existing-item-actions";
  const IMPORT_SI = "导入 SI";
  const GENERATE_TRANSLATION = "生成全文翻译";
  const SI_RETRY_HINT = `可再次点击「${IMPORT_SI}」，从头发起新请求。`;
  let observerID = null;
  let registeredPaneID = null;
  let registeredMenuID = null;
  let paneObserverRegistered = false;
  const pendingItems = [];
  const queuedItems = new Set();
  const activeActions = new Map();
  const activeSIRuns = new Map();
  const activeTranslationRuns = new Map();
  const activeControllers = new Set();
  const activeProgressPanels = new Map();
  let draining = false;
  let alive = false;
  let uiReady = false;
  let lifecycleToken = 0;

  function hasAttachment(item, title) {
    return AutoFullText.attachmentByTitle(item, title);
  }

  function isCancellation(signal) {
    return Boolean(signal?.aborted);
  }

  function itemDisplayLabel(item) {
    try {
      const title = String(item?.getField?.("title") || "").trim();
      if (title) return title.length > 48 ? `${title.slice(0, 48)}…` : title;
    } catch {
      // Ignore missing getField in minimal test stubs.
    }
    return `文献 ${item?.key || item?.id || ""}`.trim();
  }

  function clearAllProgressPanels() {
    for (const panel of [...activeProgressPanels.values()]) {
      try { panel?.remove?.(); } catch {}
    }
    activeProgressPanels.clear();
  }

  function createTaskProgressPanel(win, {
    kind = "si",
    title = "导入 SI",
    initialStage = "正在准备导入 Supporting Information…",
    cancelLabel = "取消导入",
    cancellingStage = "正在取消 SI 导入并清理状态…",
    accentColor = "#2563eb",
    showChallengeFocus = false,
    totalCount = 1,
    onCancel = null,
  } = {}) {
    const doc = win?.document;
    const host = doc?.documentElement;
    if (!doc || !host || typeof doc.createElementNS !== "function") {
      return {
        update() {},
        setItem() {},
        setChallengeWindow() {},
        finish() {},
        remove() {},
      };
    }

    try {
      activeProgressPanels.get(kind)?.remove?.();
    } catch {}

    const idPrefix = `zotero-auto-fulltext-${kind}`;
    let dismissTimer = null;
    let challengeWin = null;
    let removed = false;

    const existing = doc.getElementById?.(`${idPrefix}-progress`);
    existing?.remove?.();

    const stackId = "zotero-auto-fulltext-progress-stack";
    let stack = doc.getElementById?.(stackId);
    if (!stack) {
      stack = element(doc, "div");
      stack.id = stackId;
      stack.style.cssText = [
        "position:fixed",
        "right:18px",
        "bottom:18px",
        "z-index:2147483000",
        "display:flex",
        "flex-direction:column",
        "gap:10px",
        "align-items:flex-end",
        "pointer-events:none",
      ].join(";");
      host.appendChild(stack);
    }

    const card = element(doc, "div");
    card.id = `${idPrefix}-progress`;
    card.style.cssText = [
      "pointer-events:auto",
      "width:360px",
      "max-width:calc(100vw - 36px)",
      "padding:12px 14px",
      "border-radius:10px",
      "border:1px solid color-mix(in srgb,currentColor 22%,transparent)",
      "background:var(--material-background,Canvas)",
      "color:var(--fill-primary,CanvasText)",
      "box-shadow:0 10px 28px rgba(0,0,0,0.22)",
      "font-family:system-ui,-apple-system,'Segoe UI',sans-serif",
      "font-size:13px",
      "display:grid",
      "gap:8px",
    ].join(";");

    const header = element(doc, "div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;";
    const heading = element(doc, "div", totalCount > 1 ? `Zotero PaperFlow · ${title} (1/${totalCount})` : `Zotero PaperFlow · ${title}`);
    heading.id = `${idPrefix}-heading`;
    heading.style.cssText = "font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    header.appendChild(heading);

    const itemLine = element(doc, "div", "");
    itemLine.id = `${idPrefix}-item`;
    itemLine.style.cssText = "font-size:12px;opacity:.78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

    const stageLine = element(doc, "div", initialStage);
    stageLine.id = `${idPrefix}-stage`;
    stageLine.style.cssText = "font-size:12px;line-height:1.4;";

    const barTrack = element(doc, "div");
    barTrack.style.cssText = "height:6px;width:100%;border-radius:999px;background:color-mix(in srgb,currentColor 14%,transparent);overflow:hidden;";
    const barFill = element(doc, "div");
    barFill.id = `${idPrefix}-bar`;
    barFill.style.cssText = `height:100%;width:10%;border-radius:999px;background:${accentColor};transition:width 180ms ease;`;
    barTrack.appendChild(barFill);

    const actions = element(doc, "div");
    actions.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:8px;";

    let focusChallengeBtn = null;
    if (showChallengeFocus) {
      focusChallengeBtn = element(doc, "button", "显示验证窗口");
      focusChallengeBtn.id = `${idPrefix}-focus-btn`;
      focusChallengeBtn.type = "button";
      focusChallengeBtn.style.cssText = "display:none;padding:4px 10px;cursor:pointer;";
      focusChallengeBtn.addEventListener("click", () => {
        try { challengeWin?.focus?.(); } catch {}
      });
    }

    const cancelBtn = element(doc, "button", cancelLabel);
    cancelBtn.id = `${idPrefix}-cancel-btn`;
    cancelBtn.type = "button";
    cancelBtn.style.cssText = "padding:4px 10px;cursor:pointer;";
    cancelBtn.addEventListener("click", () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = "正在取消…";
      stageLine.textContent = cancellingStage;
      onCancel?.();
    });

    if (focusChallengeBtn) actions.append(focusChallengeBtn, cancelBtn);
    else actions.append(cancelBtn);
    card.append(header, itemLine, stageLine, barTrack, actions);
    stack.appendChild(card);

    const panel = {
      setItem(index, label) {
        if (removed) return;
        heading.textContent = totalCount > 1
          ? `Zotero PaperFlow · ${title} (${index}/${totalCount})`
          : `Zotero PaperFlow · ${title}`;
        itemLine.textContent = String(label || "");
      },
      update(stage, percent) {
        if (removed) return;
        if (stage) stageLine.textContent = String(stage);
        if (typeof percent === "number" && Number.isFinite(percent)) {
          const clamped = Math.max(5, Math.min(100, Math.round(percent)));
          barFill.style.width = `${clamped}%`;
        }
      },
      setChallengeWindow(winRef) {
        if (removed || !focusChallengeBtn) return;
        challengeWin = winRef || null;
        focusChallengeBtn.style.display = challengeWin ? "inline-block" : "none";
      },
      finish(message, { isError = false, delayMs = 2800 } = {}) {
        if (removed) return;
        if (message) stageLine.textContent = String(message);
        barFill.style.width = "100%";
        if (isError) barFill.style.background = "#dc2626";
        else barFill.style.background = "#16a34a";
        if (focusChallengeBtn) focusChallengeBtn.style.display = "none";
        cancelBtn.style.display = "none";
        if (dismissTimer) {
          try { (win.clearTimeout || clearTimeout)(dismissTimer); } catch {}
        }
        const schedule = typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : (typeof setTimeout === "function" ? setTimeout : null);
        if (schedule) dismissTimer = schedule(() => panel.remove(), delayMs);
      },
      remove() {
        if (removed) return;
        removed = true;
        if (dismissTimer) {
          try { (win.clearTimeout || clearTimeout)(dismissTimer); } catch {}
          dismissTimer = null;
        }
        try { card.remove(); } catch {}
        if (activeProgressPanels.get(kind) === panel) activeProgressPanels.delete(kind);
        if (activeProgressPanels.size === 0) {
          try { stack.remove(); } catch {}
        }
      },
    };
    activeProgressPanels.set(kind, panel);
    return panel;
  }

  function createSIProgressPanel(win, { totalCount = 1, onCancel = null } = {}) {
    return createTaskProgressPanel(win, {
      kind: "si",
      title: "导入 SI",
      initialStage: "正在准备导入 Supporting Information…",
      cancelLabel: "取消导入",
      cancellingStage: "正在取消 SI 导入并清理状态…",
      accentColor: "#2563eb",
      showChallengeFocus: true,
      totalCount,
      onCancel,
    });
  }

  function createTranslationProgressPanel(win, { totalCount = 1, onCancel = null } = {}) {
    return createTaskProgressPanel(win, {
      kind: "translation",
      title: "全文翻译",
      initialStage: "正在准备生成中文「全文翻译」…",
      cancelLabel: "取消翻译",
      cancellingStage: "正在取消全文翻译并清理中间文件…",
      accentColor: "#0f766e",
      showChallengeFocus: false,
      totalCount,
      onCancel,
    });
  }

  async function processItem(itemID, requestedActions = null, { progressPanel = null, externalCancelRef = null } = {}) {
    if (!alive) return { completed: 0, failed: 0, skipped: 1, errors: [], translationFailed: false, cancelled: true };
    const wantsSI = requestedActions
      ? Boolean(requestedActions.supportingInfo)
      : Boolean(AutoFullText.getPref("autoDownloadSupportingInfo"));
    const wantsTranslation = requestedActions
      ? Boolean(requestedActions.fullTextTranslation)
      : Boolean(AutoFullText.getPref("autoTranslateFullText"));
    if (!wantsSI && !wantsTranslation) return { completed: 0, failed: 0, skipped: 1, errors: [], translationFailed: false };

    const actionSet = activeActions.get(itemID) || new Set();
    const getSI = wantsSI && !actionSet.has("supportingInfo");
    const getTranslation = wantsTranslation && !actionSet.has("fullTextTranslation");
    const inProgress = Number(wantsSI && !getSI) + Number(wantsTranslation && !getTranslation);
    if (!getSI && !getTranslation) return { completed: 0, failed: 0, skipped: 0, inProgress, errors: [], translationFailed: false };

    const controller = new AbortController();
    const { signal } = controller;
    if (externalCancelRef) {
      externalCancelRef.abortCurrent = () => controller.abort();
      if (externalCancelRef.cancelled) controller.abort();
    }
    const lockedActions = new Set();
    if (getSI) lockedActions.add("supportingInfo");
    if (getTranslation) lockedActions.add("fullTextTranslation");
    let skipped = 0;
    for (const action of lockedActions) actionSet.add(action);
    activeActions.set(itemID, actionSet);
    activeControllers.add(controller);
    const releaseAction = (action) => {
      if (action === "supportingInfo" && activeSIRuns.get(itemID)?.controller === controller) {
        activeSIRuns.delete(itemID);
      }
      if (action === "fullTextTranslation" && activeTranslationRuns.get(itemID)?.controller === controller) {
        activeTranslationRuns.delete(itemID);
      }
      if (!lockedActions.delete(action)) return;
      actionSet.delete(action);
      if (!actionSet.size && activeActions.get(itemID) === actionSet) activeActions.delete(itemID);
    };
    let completed = 0;
    let failed = 0;
    let translationFailed = false;
    let siFailure = null;
    const errors = [];
    const cancelledResult = () => ({
      completed,
      failed,
      skipped,
      inProgress,
      errors,
      translationFailed: false,
      cancelled: true,
    });

    try {
      if (!requestedActions) await Zotero.Promise.delay(500);
      if (!alive || signal.aborted) return cancelledResult();
      const item = Zotero.Items.get(itemID);
      if (!AutoFullText.regularItem(item)) {
        return { completed: 0, failed: 0, skipped: lockedActions.size, inProgress, errors, translationFailed: false };
      }

      if (getSI) {
        const ownProgressPanel = progressPanel || (!requestedActions
          ? createSIProgressPanel(Zotero.getMainWindow(), {
            totalCount: 1,
            onCancel: () => controller.abort(),
          })
          : null);
        if (!progressPanel && ownProgressPanel) ownProgressPanel.setItem(1, itemDisplayLabel(item));
        const runInfo = {
          controller,
          stage: "正在读取出版商文章页…",
          focusChallenge: null,
        };
        activeSIRuns.set(itemID, runInfo);
        let siResult = null;
        try {
          siResult = await AutoFullTextSupportingInfo.addForItem(item, signal, {
            allowChallengeWindow: true,
            onProgress: ({ stage, percent, challengeWindow }) => {
              if (stage) runInfo.stage = stage;
              if (challengeWindow !== undefined) {
                runInfo.focusChallenge = challengeWindow ? () => challengeWindow.focus?.() : null;
                ownProgressPanel?.setChallengeWindow?.(challengeWindow);
              }
              ownProgressPanel?.update?.(stage, percent);
            },
          });
          if (siResult?.skipped) skipped += 1;
          else completed += 1;
          if (!progressPanel && ownProgressPanel) {
            ownProgressPanel.finish(siResult?.skipped ? "该 SI 附件已存在，已跳过。" : "SI 附件已自动导入。");
          }
        } catch (error) {
          if (isCancellation(signal)) {
            if (!progressPanel && ownProgressPanel) ownProgressPanel.finish("SI 导入已取消。", { isError: true, delayMs: 2000 });
            return cancelledResult();
          }
          if (error?.name === "SupportingInfoChallengeCancelledError") {
            if (!progressPanel && ownProgressPanel) ownProgressPanel.finish("已取消安全验证，SI 尚未导入。", { isError: true, delayMs: 2200 });
            if (requestedActions) return cancelledResult();
            skipped += 1;
          } else {
            failed += 1;
            const detail = String(error?.message || error);
            siFailure = {
              publisherURL: error?.publisherURL || "",
              accessBlocked: error?.name === "SupportingInfoAccessError",
            };
            errors.push(`Supporting Information: ${detail}`);
            AutoFullText.log(`Supporting information failed for ${item.key}: ${detail}`);
            if (!progressPanel && ownProgressPanel) ownProgressPanel.finish("SI 导入失败。", { isError: true, delayMs: 3200 });
          }
        } finally {
          releaseAction("supportingInfo");
        }
        if (!alive || signal.aborted) return cancelledResult();
        if (siResult?.usedChallengeWindow && !siResult?.skipped && !requestedActions) {
          showSISuccessNotice(Zotero.getMainWindow(), `文献 ${item.key} 的 Supporting Information 已通过验证并自动导入。`);
        }
        if (siFailure && !requestedActions) {
          showSIFailure(Zotero.getMainWindow(), siFailure, `文献 ${item.key} 的 SI 导入失败。\n${errors[0]}`, false);
        }
      }

      if (getTranslation) {
        if (!alive || signal.aborted) return cancelledResult();
        const externalTranslationPanel = requestedActions?.fullTextTranslation ? progressPanel : null;
        const ownTranslationPanel = externalTranslationPanel || (!requestedActions
          ? createTranslationProgressPanel(Zotero.getMainWindow(), {
            totalCount: 1,
            onCancel: () => controller.abort(),
          })
          : null);
        if (!externalTranslationPanel && ownTranslationPanel) ownTranslationPanel.setItem(1, itemDisplayLabel(item));
        const translationRunInfo = {
          controller,
          stage: "正在读取并解析文章网页…",
        };
        activeTranslationRuns.set(itemID, translationRunInfo);
        try {
          if (hasAttachment(item, "全文翻译")) {
            skipped += 1;
            if (!externalTranslationPanel && ownTranslationPanel) {
              ownTranslationPanel.finish("「全文翻译」附件已存在，已跳过。");
            }
          } else {
            await AutoFullTextTranslation.create(item, signal, {
              onProgress: ({ stage, percent }) => {
                if (stage) translationRunInfo.stage = stage;
                ownTranslationPanel?.update?.(stage, percent);
              },
            });
            completed += 1;
            if (!externalTranslationPanel && ownTranslationPanel) {
              ownTranslationPanel.finish("「全文翻译」PDF 附件已导入。");
            }
          }
        } catch (error) {
          if (isCancellation(signal)) {
            if (!externalTranslationPanel && ownTranslationPanel) {
              ownTranslationPanel.finish("已取消全文翻译。", { isError: true, delayMs: 2000 });
            }
            return cancelledResult();
          }
          failed += 1;
          translationFailed = true;
          const detail = String(error?.message || error);
          errors.push(`全文翻译：${detail}`);
          AutoFullText.log(`Full-text translation stopped for ${item.key}`, error);
          if (!externalTranslationPanel && ownTranslationPanel) {
            ownTranslationPanel.finish("全文翻译已停止。", { isError: true, delayMs: 3600 });
          }
          if (!requestedActions) {
            Zotero.getMainWindow()?.alert(`文献 ${item.key} 的全文翻译已停止。\n${detail}`);
          }
        } finally {
          releaseAction("fullTextTranslation");
        }
      }
      return { completed, failed, skipped, inProgress, errors, translationFailed, siFailure };
    } finally {
      if (externalCancelRef) externalCancelRef.abortCurrent = null;
      for (const action of lockedActions) releaseAction(action);
      activeControllers.delete(controller);
    }
  }

  async function drainQueue() {
    if (draining || !alive || !uiReady) return;
    draining = true;
    try {
      while (alive && uiReady && pendingItems.length) {
        const nextID = pendingItems.shift();
        queuedItems.delete(nextID);
        try {
          await processItem(nextID);
        } catch (error) {
          AutoFullText.log(`Item processing failed for ${nextID}`, error);
        }
      }
    } finally {
      draining = false;
      if (alive && uiReady && pendingItems.length) void drainQueue();
    }
  }

  function enqueueItem(itemID) {
    if (queuedItems.has(itemID)) return;
    queuedItems.add(itemID);
    pendingItems.push(itemID);
    void drainQueue();
  }

  function onNotify(event, type, ids) {
    if (event !== "add" || type !== "item") return;
    for (const id of ids) {
      const itemID = Number(id);
      if (Number.isInteger(itemID) && itemID > 0) enqueueItem(itemID);
    }
  }

  function element(doc, name, text) {
    const node = doc.createElementNS("http://www.w3.org/1999/xhtml", name);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function mountSettingsPane(win, root) {
    const doc = root.ownerDocument;
    const panel = element(doc, "div");
    panel.style.cssText = "display:grid;gap:18px;max-width:820px;padding:12px 4px;color:inherit";

    const title = element(doc, "h2", "添加文献时的自动附件");
    title.style.margin = "0";
    panel.appendChild(title);

    const options = element(doc, "section");
    options.style.cssText = "display:grid;gap:10px";
    const addCheckbox = (labelText, prefKey) => {
      const label = element(doc, "label");
      label.style.cssText = "display:flex;align-items:flex-start;gap:8px;cursor:pointer";
      const input = element(doc, "input");
      input.type = "checkbox";
      input.checked = Boolean(AutoFullText.getPref(prefKey));
      input.addEventListener("change", () => AutoFullText.setPref(prefKey, input.checked));
      label.append(input, doc.createTextNode(labelText));
      options.appendChild(label);
    };
    addCheckbox(
      "抓取 Supporting Information；非 PDF 文件先转换为 PDF 再附加",
      "autoDownloadSupportingInfo",
    );
    addCheckbox(
      "生成中文「全文翻译」PDF 附件（仅中文译文）",
      "autoTranslateFullText",
    );
    const optionsHint = element(
      doc,
      "p",
      "两项功能独立勾选，默认关闭。启用后仅对设置生效之后新增的文献条目自动处理；附件、笔记和注释不会触发。已有文献可在文库条目右键菜单中手动补处理。",
    );
    optionsHint.style.cssText = "margin:0;opacity:.8";
    options.appendChild(optionsHint);
    panel.appendChild(options);

    const translationTitle = element(doc, "h2", "论文翻译供应商");
    translationTitle.style.margin = "0";
    panel.appendChild(translationTitle);
    const providerHint = element(
      doc,
      "p",
      "可保存多个 OpenAI Chat Completions 兼容供应商配置，但每次只使用选中的一个；引擎报错会立即停止，不切换备用供应商。API 密钥只从环境变量读取，不保存到 Zotero。",
    );
    providerHint.style.cssText = "margin:0;opacity:.8";
    panel.appendChild(providerHint);

    let providers;
    let activeProviderID;
    let providerConfigError = "";
    try {
      providers = AutoFullTextTranslator.getProviders();
      activeProviderID = AutoFullTextTranslator.getActiveProviderID();
    } catch (error) {
      providerConfigError = String(error?.message || error);
      providers = [AutoFullTextTranslator.getDefaultProvider()];
      activeProviderID = providers[0].id;
    }
    const providerList = element(doc, "div");
    providerList.style.cssText = "display:grid;gap:12px";
    let providerWarning = null;
    if (providerConfigError) {
      providerWarning = element(doc, "p", `现有供应商配置无法读取：${providerConfigError}。下面显示内置配置；修改任一字段即可保存修复。`);
      providerWarning.style.cssText = "margin:0;color:#b45309";
      panel.appendChild(providerWarning);
    }

    const persistProviders = () => {
      AutoFullText.setPref("translationProviders", JSON.stringify(providers));
      AutoFullText.setPref("activeTranslationProvider", activeProviderID);
      providerConfigError = "";
      providerWarning?.remove();
    };

    const renderProviders = () => {
      providerList.replaceChildren();
      providers.forEach((provider) => {
        const card = element(doc, "fieldset");
        card.style.cssText = "display:grid;gap:8px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:10px";
        const legend = element(doc, "legend", provider.name || "翻译供应商");
        card.appendChild(legend);

        const activeLabel = element(doc, "label");
        activeLabel.style.cssText = "display:flex;gap:8px;align-items:center;cursor:pointer";
        const activeRadio = element(doc, "input");
        activeRadio.type = "radio";
        activeRadio.name = "auto-fulltext-active-provider";
        activeRadio.checked = provider.id === activeProviderID;
        activeRadio.addEventListener("change", () => {
          activeProviderID = provider.id;
          persistProviders();
          renderProviders();
        });
        activeLabel.append(activeRadio, doc.createTextNode("使用此供应商"));
        card.appendChild(activeLabel);

        const fieldGrid = element(doc, "div");
        fieldGrid.style.cssText = "display:grid;grid-template-columns:140px minmax(240px,1fr);gap:8px;align-items:center";
        const addProviderField = (labelText, property, inputType, placeholder = "") => {
          const inputID = `auto-fulltext-${provider.id}-${property}`;
          const label = element(doc, "label", labelText);
          label.htmlFor = inputID;
          const input = element(doc, "input");
          input.id = inputID;
          input.type = inputType;
          input.value = String(provider[property] || "");
          input.placeholder = placeholder;
          input.style.cssText = "min-width:0;width:100%";
          input.addEventListener("change", () => {
            provider[property] = input.value.trim();
            persistProviders();
            if (property === "name") legend.textContent = provider.name || "翻译供应商";
            if (property === "apiKeyEnv") envStatus.textContent = AutoFullTextTranslator.hasApiKey(provider)
              ? "当前 Zotero 进程可读取该变量。"
              : "未读取到；设置环境变量后需重新启动 Zotero。";
          });
          fieldGrid.append(label, input);
          return input;
        };
        addProviderField("供应商名称", "name", "text", "例如：DeepSeek");
        addProviderField("Chat Completions 端点", "endpoint", "url", "https://…/v1/chat/completions");
        addProviderField("模型", "model", "text", "例如：deepseek-chat");
        addProviderField("API 密钥环境变量名", "apiKeyEnv", "text", "ZOTERO_AUTO_FULLTEXT_API_KEY");
        card.appendChild(fieldGrid);

        const envStatus = element(
          doc,
          "p",
          AutoFullTextTranslator.hasApiKey(provider)
            ? "当前 Zotero 进程可读取该变量。"
            : "未读取到；设置环境变量后需重新启动 Zotero。",
        );
        envStatus.style.cssText = "margin:0;opacity:.8";
        card.appendChild(envStatus);

        const removeButton = element(doc, "button", "移除此供应商配置");
        removeButton.type = "button";
        removeButton.disabled = providers.length <= 1;
        removeButton.addEventListener("click", () => {
          providers = providers.filter((entry) => entry.id !== provider.id);
          if (activeProviderID === provider.id) activeProviderID = providers[0]?.id || "";
          persistProviders();
          renderProviders();
        });
        card.appendChild(removeButton);
        providerList.appendChild(card);
      });
    };
    renderProviders();
    panel.appendChild(providerList);

    const addControls = element(doc, "div");
    addControls.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    const providerPreset = element(doc, "select");
    providerPreset.style.cssText = "min-width:200px";
    for (const [value, labelText] of [
      ["openai", "OpenAI"],
      ["deepseek", "DeepSeek"],
      ["siliconflow", "SiliconFlow"],
      ["openrouter", "OpenRouter"],
      ["custom", "自定义兼容端点"],
    ]) {
      const option = element(doc, "option", labelText);
      option.value = value;
      providerPreset.appendChild(option);
    }
    const providerStatus = element(doc, "span");
    providerStatus.setAttribute("role", "status");
    const addProviderButton = element(doc, "button", "添加供应商");
    addProviderButton.type = "button";
    addProviderButton.addEventListener("click", () => {
      if (providers.length >= 12) {
        providerStatus.textContent = "最多可配置 12 个翻译供应商。";
        return;
      }
      const presets = {
        openai: { name: "OpenAI", endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", env: "OPENAI" },
        deepseek: { name: "DeepSeek", endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", env: "DEEPSEEK" },
        siliconflow: { name: "SiliconFlow", endpoint: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V3", env: "SILICONFLOW" },
        openrouter: { name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "openai/gpt-4o-mini", env: "OPENROUTER" },
        custom: { name: "自定义供应商", endpoint: "", model: "", env: "CUSTOM" },
      };
      const preset = presets[providerPreset.value] || presets.custom;
      const id = `provider-${Zotero.Utilities.randomString(10)}`;
      providers.push({
        id,
        name: preset.name,
        endpoint: preset.endpoint,
        model: preset.model,
        apiKeyEnv: `ZOTERO_AUTO_FULLTEXT_${preset.env}_${id.slice(-6).toUpperCase()}_API_KEY`,
      });
      if (!activeProviderID) activeProviderID = id;
      persistProviders();
      renderProviders();
      providerStatus.textContent = "已添加供应商；环境变量需在启动 Zotero 前设置。";
    });
    addControls.append(providerPreset, addProviderButton, providerStatus);
    panel.appendChild(addControls);

    const promptTitle = element(doc, "h3", "系统提示词（可自定义）");
    promptTitle.style.margin = "0";
    panel.appendChild(promptTitle);
    let promptTemplate;
    try {
      promptTemplate = AutoFullTextTranslator.getPromptTemplate();
    } catch (error) {
      promptTemplate = AutoFullTextTranslator.DEFAULT_SYSTEM_PROMPT;
      const warning = element(doc, "p", `现有提示词无法使用：${String(error?.message || error)}。下面显示默认提示词；修改后保存即可修复。`);
      warning.style.cssText = "margin:0;color:#b45309";
      panel.appendChild(warning);
    }
    const promptInput = element(doc, "textarea");
    promptInput.rows = 12;
    promptInput.maxLength = AutoFullTextTranslator.MAX_PROMPT_CHARS;
    promptInput.value = promptTemplate;
    promptInput.style.cssText = "box-sizing:border-box;width:100%;resize:vertical;font-family:monospace";
    promptInput.addEventListener("change", () => {
      AutoFullText.setPref("translationSystemPrompt", promptInput.value);
      promptStatus.textContent = "提示词已保存。";
    });
    panel.appendChild(promptInput);
    const promptHint = element(
      doc,
      "p",
      "默认使用 Cometix Translate 的 Academic Paper Translation Expert 提示词。可编辑 {{to}}、{{title_prompt}}、{{summary_prompt}}、{{terms_prompt}} 模板字段；系统会额外追加简体中文、仅译文和保护标记完整性要求。",
    );
    promptHint.style.cssText = "margin:0;opacity:.8";
    panel.appendChild(promptHint);
    const promptStatus = element(doc, "span");
    panel.appendChild(promptStatus);

    const keyHint = element(
      doc,
      "p",
      "API 密钥只从每个供应商配置的环境变量读取，不写入 Zotero 偏好或 Login Manager。全文翻译会将网页正文发送到当前选中的兼容服务；引擎错误会停止整篇处理，不生成部分 PDF。原始网页、净化网页、翻译进度、最终 HTML/PDF 会暂存在本机；附件成功导入后清理，失败时保留目录并在错误中给出路径。",
    );
    keyHint.style.cssText = "margin:0;opacity:.8";
    panel.appendChild(keyHint);

    const limits = element(
      doc,
      "p",
      "SI 只抓第一个可识别文件；非 PDF 格式依赖 Windows Microsoft Office。PowerPoint 转换可能显示窗口。",
    );
    limits.style.cssText = "margin:0;opacity:.8";
    panel.appendChild(limits);

    root.replaceChildren(panel);
    root.addEventListener("unload", () => panel.remove(), { once: true });
  }

  function selectedRegularItems(context) {
    const seen = new Set();
    const result = [];
    for (const item of [...(context?.items || [])]) {
      if (!AutoFullText.regularItem(item)) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result;
  }

  function showSISuccessNotice(win, description) {
    try {
      const notice = new Zotero.ProgressWindow({ window: win });
      notice.show();
      notice.changeHeadline("SI 已自动导入");
      notice.addDescription(description);
      notice.startCloseTimer(6000);
    } catch (error) {
      AutoFullText.log("Could not show the SI success notice", error);
    }
  }

  function showSIRetryNotice(win, instruction) {
    try {
      const notice = new Zotero.ProgressWindow({ window: win });
      notice.show();
      notice.changeHeadline("SI 尚未导入");
      notice.addDescription(`${instruction}${SI_RETRY_HINT}失败详情见 Zotero Debug Output。`);
      notice.startCloseTimer(8000);
    } catch (error) {
      AutoFullText.log("Could not show the SI retry notice", error);
    }
  }

  function showSIFailure(win, failure, message, interactive = true) {
    if (!alive || !win) return;
    const details = `${message}\n\n${SI_RETRY_HINT}`;
    if (!failure.accessBlocked && !interactive) {
      showSIRetryNotice(win, "");
      return;
    }
    if (!failure.publisherURL) {
      if (interactive) win.alert(details);
      else showSIRetryNotice(win, "");
      return;
    }
    if (!failure.accessBlocked && !win.confirm(`${details}\n是否打开出版商页面检查访问状态？`)) return;
    if (!alive) return;
    try {
      Zotero.openInViewer(AutoFullText.validateArticleURL(failure.publisherURL));
    } catch (error) {
      AutoFullText.log("Could not open the SI publisher page");
      if (interactive) win.alert(`${details}\n无法打开 Zotero 网页窗口。`);
      else showSIRetryNotice(win, "无法打开 Zotero 网页窗口。");
      return;
    }
    showSIRetryNotice(win, "请在出版商网页按提示操作。");
  }

  async function processSelectedItems(context, requestedActions) {
    const items = selectedRegularItems(context);
    const win = Zotero.getMainWindow();
    if (!items.length) {
      win?.alert("请先在文库中选择一个或多个普通文献条目。");
      return;
    }

    const isSIAction = Boolean(requestedActions?.supportingInfo);
    const isTranslationAction = Boolean(requestedActions?.fullTextTranslation);
    const allAlreadyRunning = (isSIAction && items.every((item) => activeActions.get(item.id)?.has("supportingInfo"))) ||
      (isTranslationAction && items.every((item) => activeActions.get(item.id)?.has("fullTextTranslation")));
    if (isSIAction && allAlreadyRunning) {
      const runningInfo = activeSIRuns.get(items[0].id);
      try { runningInfo?.focusChallenge?.(); } catch {}
    }

    const cancelRef = { cancelled: false, abortCurrent: null };
    const onCancel = () => {
      cancelRef.cancelled = true;
      cancelRef.abortCurrent?.();
    };
    const progressPanel = !allAlreadyRunning
      ? (isSIAction
        ? createSIProgressPanel(win, { totalCount: items.length, onCancel })
        : (isTranslationAction
          ? createTranslationProgressPanel(win, { totalCount: items.length, onCancel })
          : null))
      : null;

    const total = { completed: 0, failed: 0, skipped: 0, inProgress: 0, errors: [], processed: 0, stopped: "", siFailure: null };
    for (const item of items) {
      if (!alive || cancelRef.cancelled) {
        if (cancelRef.cancelled) total.stopped = "已取消";
        break;
      }
      total.processed += 1;
      progressPanel?.setItem?.(total.processed, itemDisplayLabel(item));
      progressPanel?.update?.(isSIAction ? "正在启动 SI 导入…" : "正在准备生成中文「全文翻译」…", 8);
      let result;
      try {
        result = await processItem(item.id, requestedActions, { progressPanel, externalCancelRef: cancelRef });
      } catch (error) {
        result = {
          completed: 0,
          failed: 1,
          skipped: 0,
          errors: [String(error?.message || error)],
          translationFailed: Boolean(requestedActions.fullTextTranslation),
        };
        AutoFullText.log(`Manual processing failed for ${item.key}`, error);
      }
      total.completed += result.completed;
      total.failed += result.failed;
      total.skipped += result.skipped;
      total.inProgress += result.inProgress || 0;
      total.errors.push(...(result.errors || []));
      if (result.siFailure && !total.siFailure) total.siFailure = result.siFailure;
      if (result.cancelled || cancelRef.cancelled || !alive) {
        total.stopped = "已取消";
        break;
      }
      if (result.translationFailed) {
        total.stopped = "已因全文翻译错误而停止";
        break;
      }
    }
    if (progressPanel) {
      const taskLabel = isSIAction ? "SI 导入" : "全文翻译";
      if (total.stopped === "已取消") progressPanel.finish(`已取消${taskLabel}。`, { isError: true, delayMs: 2200 });
      else if (total.failed > 0) progressPanel.finish(`${taskLabel}结束：完成 ${total.completed} 项，失败 ${total.failed} 项。`, { isError: true, delayMs: 3400 });
      else progressPanel.finish(`${taskLabel}完成：完成 ${total.completed} 项，跳过 ${total.skipped} 项。`, { isError: false, delayMs: 2600 });
    }
    if (!alive || !win) return;
    const notStarted = items.length - total.processed;
    const details = total.errors.slice(0, 5).map((message) => `\n• ${message}`).join("");
    const runningStage = total.inProgress && items.length === 1
      ? (isSIAction ? activeSIRuns.get(items[0].id)?.stage : activeTranslationRuns.get(items[0].id)?.stage)
      : "";
    const cancelBtnLabel = isSIAction ? "取消导入" : "取消翻译";
    const inProgressNote = total.inProgress
      ? `，已有 ${total.inProgress} 项正在处理中${runningStage ? `（当前阶段：${runningStage}；可在右下角进度条点击「${cancelBtnLabel}」）` : ""}`
      : "";
    const summary = `补处理${total.stopped || "完成"}：已处理 ${total.processed}/${items.length} 条文献，完成 ${total.completed} 项，失败 ${total.failed} 项，跳过 ${total.skipped} 项${inProgressNote}。${notStarted ? ` 还有 ${notStarted} 条未处理。` : ""}${details}\n更多详情见 Zotero Debug Output。`;
    if (total.siFailure && !total.stopped && items.length === 1) {
      showSIFailure(win, total.siFailure, summary);
      return;
    }
    win.alert(summary + (total.siFailure ? `\n可单选失败的文献。${SI_RETRY_HINT}` : ""));
  }

  function registerExistingItemMenus(pluginID) {
    const regularItemsEnabled = (_event, context) => {
      const menuItem = context.menuElem;
      menuItem.disabled = selectedRegularItems(context).length === 0;
    };
    const result = Zotero.MenuManager.registerMenu({
      menuID: MENU_ID,
      pluginID,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          onShowing: (_event, context) => {
            context.menuElem.label = IMPORT_SI;
            regularItemsEnabled(_event, context);
          },
          onCommand: (_event, context) => {
            void processSelectedItems(context, { supportingInfo: true, fullTextTranslation: false });
          },
        },
        {
          menuType: "menuitem",
          onShowing: (_event, context) => {
            context.menuElem.label = GENERATE_TRANSLATION;
            regularItemsEnabled(_event, context);
          },
          onCommand: (_event, context) => {
            void processSelectedItems(context, { supportingInfo: false, fullTextTranslation: true });
          },
        },
      ],
    });
    if (!result) throw new Error("Zotero could not register the existing-item context menu.");
    return result;
  }

  const paneObserver = {
    observe(subject) {
      const { root, win } = subject.wrappedJSObject;
      try {
        mountSettingsPane(win, root);
      } catch (error) {
        Zotero.logError(error);
        const message = element(
          root.ownerDocument,
          "p",
          `自动附件设置加载失败：${String(error)}`,
        );
        root.replaceChildren(message);
      }
    },
  };

  async function registerPreferences(data) {
    return Zotero.PreferencePanes.register({
      pluginID: data.id,
      id: "zotero-auto-fulltext-pane",
      label: "Zotero PaperFlow",
      image: "pane-icon.svg",
      src: "prefpane.xhtml",
      scripts: ["prefpane.js"],
    });
  }

  async function startup(data) {
    const token = ++lifecycleToken;
    alive = true;
    activeActions.clear();
    activeSIRuns.clear();
    activeTranslationRuns.clear();
    activeControllers.clear();
    pendingItems.length = 0;
    queuedItems.clear();
    clearAllProgressPanels();
    AutoFullTextSupportingInfo.resetSessionState?.();
    AutoFullTextPdf.setRootURI(data.rootURI);
    await Zotero.initializationPromise;
    if (!alive || token !== lifecycleToken) return;
    Services.obs.addObserver(paneObserver, PANE_TOPIC);
    paneObserverRegistered = true;
    observerID = Zotero.Notifier.registerObserver({ notify: onNotify }, ["item"]);
    await Promise.all([Zotero.unlockPromise, Zotero.uiReadyPromise]);
    if (!alive || token !== lifecycleToken) return;

    let paneID;
    try {
      paneID = await registerPreferences(data);
      if (!alive || token !== lifecycleToken) {
        if (paneID) Zotero.PreferencePanes.unregister(paneID);
        return;
      }
      registeredPaneID = paneID;
    } catch (error) {
      Zotero.logError(error);
    }
    if (!alive || token !== lifecycleToken) return;

    try {
      const menuID = registerExistingItemMenus(data.id);
      if (!alive || token !== lifecycleToken) {
        if (menuID) Zotero.MenuManager.unregisterMenu(menuID);
        return;
      }
      registeredMenuID = menuID;
    } catch (error) {
      Zotero.logError(error);
    }
    if (!alive || token !== lifecycleToken) return;
    uiReady = true;
    void drainQueue();
    AutoFullText.log("Started.");
  }

  function shutdown() {
    lifecycleToken += 1;
    alive = false;
    uiReady = false;
    pendingItems.length = 0;
    queuedItems.clear();
    for (const controller of activeControllers) controller.abort();
    activeControllers.clear();
    activeActions.clear();
    activeSIRuns.clear();
    activeTranslationRuns.clear();
    clearAllProgressPanels();
    AutoFullTextSupportingInfo.resetSessionState?.();
    if (observerID) {
      try { Zotero.Notifier.unregisterObserver(observerID); }
      catch (error) { Zotero.logError(error); }
    }
    if (registeredPaneID) {
      try { Zotero.PreferencePanes.unregister(registeredPaneID); }
      catch (error) { Zotero.logError(error); }
    }
    if (registeredMenuID) {
      try { Zotero.MenuManager.unregisterMenu(registeredMenuID); }
      catch (error) { Zotero.logError(error); }
    }
    if (paneObserverRegistered) {
      try { Services.obs.removeObserver(paneObserver, PANE_TOPIC); }
      catch (error) { Zotero.logError(error); }
    }
    observerID = null;
    registeredPaneID = null;
    registeredMenuID = null;
    paneObserverRegistered = false;
  }

  return { startup, shutdown };
})();
