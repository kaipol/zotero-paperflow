# Zotero PaperFlow

一个独立的 Zotero **10.0.8–10.x** bootstrap 插件，用于在新增文献时按用户勾选的选项自动处理附件。插件独立实现，不依赖 `zotero-pdf-translate` 目录，也不复用其代码。

**启动故障修复说明：** bootstrap 的 `startup()` 和 `shutdown()` 现为顶层函数声明，避免在定义前先求值模块导入；Zotero 自带的 `Services` 直接取宿主全局，`OS` 则在 `startup()` 的 `try/catch` 中从 `chrome://zotero/content/osfile.mjs` 导入。即使导入失败也会通过 `Zotero.logError` 记录实际异常，不再让生命周期对象因文件顶层求值失败而未定义。

**启动故障修复：** 0.1.4 修正了 OS 模块 URL；0.1.5 修正了 bootstrap 参数：Zotero 传入的是 `{ id, version, rootURI }`，不是带 `resourceURI.spec` 的参数，因此脚本加载地址现由 `rootURI` 解析。bootstrap 会校验 `rootURI` 并在失败时记录完整异常。插件安装后还需在插件管理器确认 **Zotero PaperFlow** 已启用。

**0.1.7 设置页修复：** `prefpane.xhtml` 是 Zotero 插入 Preferences 的 XML 片段，文件开头不能包含 XML declaration；本版已移除，避免 `XML or text declaration not at start of entity` 导致设置页内容为空。pane 图标补上明确的 24×24 尺寸，并声明为插件图标。

**0.3.7 全面审计修复：**增加文章/资源 SSRF 与重定向防护、响应大小提前限制、行内 SVG 与 CSS 净化、本地 PDF CSP、生命周期取消/注册竞争处理、逐段简中/异常短译文门禁、供应商/提示词/响应大小上限、每 20 段安全进度批次文件及逐文件 XPI 验证。

**0.3.8 SI 抓取修复：**文章页和 SI 资源支持 HTTP/HTTPS；HTTP 限于公网站点与标准端口，HTTPS 降级重定向仅允许可信出版商域名。真实请求取消异常不再误算为“跳过”，失败会保留 `si-error.txt` 和临时工作区。SI 下载使用重定向后的文章页作为 Referer；扩展名缺失时从服务器 `Content-Disposition` 文件名和 MIME 类型补全。

**0.3.9 手动恢复：**复用 Zotero 的独立网页窗口，让用户在出版商页面按提示操作；插件不自动通过站点验证。通过同一条目的本地导入命令保存已下载的 SI。兼容 XPI 的 `jar:` 脚本路径，并区分站点拦截、处理中、取消和失败。

**0.3.10 右键菜单精简：**只保留「导入 SI」和「生成全文翻译」。同一个 SI 入口可从出版商获取第一份公开文件，也可导入已下载的本地文件；受阻时从对话框进入 Zotero 网页窗口。

**0.3.11 验证窗口：**遇到 403 或 Cloudflare 验证时打开 Zotero 的独立网页窗口。该版的后台验证下载回退已在 0.3.12 移除。

**0.3.12 SI 重试：**点击「导入 SI」直接从出版商获取，不再弹出来源选择框，也不再提供插件内本地文件导入。每次点击都可在上一任务结束后发起新请求；失败或网页窗口打开后不保留 SI 锁。失败记录区分 HTTP 拒绝、连接异常和处理阶段。

**0.3.14 Cloudflare 质询窗口与自动导入（仿 Zotero Connector 流程）：**修复 Zotero 内置浏览器在 Cloudflare Turnstile（如 `challenges.cloudflare.com`、`brunhild.challenges.cloudflare.com`）下因 Cookie 隔离/追踪保护/UA 含 `Zotero/` 导致 `CORS request did not succeed (Status code: null)` 而无法跳过验证的问题。遇到 403 / Cloudflare 质询时自动弹出独立安全验证窗口（临时放行会话 Cookie、追踪保护与网络状态分区，并统一纯净 Firefox UA，关闭后自动还原全部偏好）；验证自动或手动通过后，自动提取文章页 SI 链接、在已验证会话内下载 SI 文件（必要时支持跨域会话回退与下载主机二次验证）、非 PDF 转 PDF、关闭窗口并自动导入为 Zotero 子附件。

**0.3.15 SI 实时进度卡片、取消按钮与质询窗口启动修复：**修正 `chrome.manifest` 的 `content/` 路径并在 `bootstrap.js` 增加 `amIAddonManagerStartup.registerChrome` 动态注册，同时为质询窗口增加 6 秒初始化握手超时保护与会话表兜底，彻底解决 Zotero 10 打包 XPI 中质询窗口未弹出且任务锁死在「正在处理中」的问题；导入 SI 时在 Zotero 右下角实时显示当前阶段进度条，提供一键「取消导入」与「显示验证窗口」按钮，并在插件启停时彻底重置任务状态。

## 功能与实现结构

```text
bootstrap.js                         加载脚本模块和插件生命周期
manifest.json                        Zotero 插件身份与最低版本
chrome.manifest                      插件 content 资源注册
defaults/preferences/prefs.js        自动处理选项、供应商配置与自定义提示词
prefpane.xhtml                      Zotero Settings 注册时插入的 pane host
prefpane.js                         在 Settings sandbox 中通过 Services.obs 移交 pane root
pane-icon.svg                       设置侧栏图标
content/challenge-window.xhtml       独立出版商安全验证窗口（Cloudflare Turnstile / 人工验证）
content/challenge-window.js          验证窗口会话控制、临时 Gecko 偏好恢复、自动/手动过检与会话内下载
content/modules/core.js              偏好、条目、日志和附件公共操作
content/modules/main.js              Zotero Notifier 新条目队列、设置 pane 与文库右键菜单
content/modules/supporting-info.js   SI 链接发现、质询窗口协同、会话内/回退下载和 PDF 转换
content/modules/fulltext-translation.js
                                     正文清洗、逐段翻译/中文校验、失败中止与本地中间文件生命周期
content/modules/translation-client.js
                                     多个 OpenAI-compatible Chat Completions 供应商、Cometix 提示词和环境变量密钥
content/modules/pdf-export.js        临时目录、Office/浏览器 PDF 转换、HTML 打印、Zotero 附件导入
content/office-to-pdf.vbs              Windows Office COM 安全自动化入口（Word/Excel/PowerPoint）
scripts/build-xpi.mjs                  以临时新归档构建并验证 XPI（拒绝覆盖旧包）
test/pdf-smoke.html                  PDF 输出基础样例
test/pdf-smoke.pdf                   Edge headless PDF 渲染结果
test/site-style-smoke.html           makeWebsitePdfPage() 生成的网页式样例
test/site-style-smoke.pdf            页面 CSS/公式/图片/链接 smoke 结果
test/static-smoke.mjs                检查 bootstrap 清单、偏好和静态回归点
test/behavior-smoke.mjs              VM 行为测试：安全 URL/重定向/大小限制、供应商/提示词、中文校验、取消与 SI 首项
test/package-smoke.mjs               验证 XPI ZIP 完整性、源文件成员清单与版本一致性
test/generate-website-style-smoke.mjs 用于生成网页样式 smoke HTML
```

### 选项一：Supporting Information

勾选 **“抓取 Supporting Information；非 PDF 文件先转换为 PDF 再附加”** 后，插件监听 Zotero 的新条目 `add` 通知，只对普通文献条目处理。插件读取条目的 URL 或 DOI 页面，筛选标注为 Supporting Information / Supplementary material 的安全 HTTP/HTTPS 链接，按页面顺序筛选并去重后**只处理第一个可识别的 SI 文件**；如果该文件已存在或下载/转换失败，不会继续尝试第二个。下载到随机临时目录，PDF 原样附加；非 PDF 文件由本机 Microsoft Office Word、Excel 或 PowerPoint 导出为 PDF，再通过 Zotero `Attachments.importFromFile` 作为子附件导入。标题前缀为 `Supporting Information`。

当前网络策略支持公开 HTTP/HTTPS 文章、SI 和图片资源并逐跳手动校验重定向；拒绝本地/IP/非标准端口和 URL query 中疑似凭据的地址（签名 query token 下载链接可能无法抓取）。HTTP 未加密，存在被中间人读取或篡改的风险；从 HTTPS 页面降级到 HTTP 的重定向仅允许可信出版商域名，跨域资源仍须通过出版商白名单校验。SI 单文件响应上限 100 MB，依据 Content-Length 与实际下载进度提前取消。不支持的格式明确报错。非 PDF 文件只支持插件列出的 Office 可读文档、表格、演示文稿、文本/HTML/CSV/XML、ODF 与常见图片格式；具体转换取决于相应 Office 组件能否打开文件。Microsoft Office 自动化仅适用于 Windows；Office 首次启动、授权、受保护视图或损坏文件对话框可能造成转换失败/超时，PowerPoint 转换可能显示应用窗口。插件不绕过这些提示，也不承诺无界面成功。

### 选项二：中文「全文翻译」

勾选 **“生成中文「全文翻译」PDF 附件（仅中文译文）”** 后：

1. 通过 URL/DOI 加载文献页面并选取最长的 `article/main/[role=main]` 主体；原始响应在 HTML 解析前保存到本机临时工作区，再移除导航、页眉页脚、侧栏、广告、推荐和操作控件。
2. 以“致谢/Acknowledgements”标题为终点（保留致谢正文）；参考文献、Bibliography、Appendix、Supplementary Material 等段落均剔除。如果页面未提供可读 HTML 全文或无法定位有效正文，不生成附件。
3. 文章与样式请求使用匿名公开 HTTP/HTTPS，逐跳校验重定向（最多 5 次）；SI 响应 Content-Length 或进度超过 100 MB 会取消；图片最多 100 张、合计 40 MB、单图 12 MB；网页响应限 30 MB、样式表单个限 2 MB/合计 8 MB。CSS 外链/导入被移除，SVG 与内联样式净化；PDF CSP 阻止文档加载脚本、表单和外部资源。主机名检查可阻断明确的私网/IP/本机地址，但未对 DNS 解析结果做 socket-level pinning，不能防御可信域名遭 DNS 劫持/重绑定的所有情形。
4. MathML、MathJax/KaTeX、图片、代码块和链接通过不透明保护标记保留；若翻译服务改写或漏掉保护标记，则停止处理并保留本地中间文件。
5. 按句点、换行、中文句号或空格等自然边界，将每段拆成约 1200 字符片段（保护标记不可拆，每段最多 100 片）；最多 2 路并发，按源顺序组装。任一 API 请求或校验报错都会取消在途请求、停止派发后续片段并直接报错，不重试、不切换供应商、不生成部分 PDF。各个需要翻译的片段及合并后的正文块都必须有非空简体中文译文且保护标记完整，才进入导出阶段；短译文启发式仅用于发现可疑截断，不能证明语义完整。
6. 使用 Cometix Translate 的 `Academic Paper Translation Expert`（“学术论文翻译师”）单段 system prompt，填入 `{{to}}` 等模板占位符；论文标题与摘要以单独标记的非可信用户上下文发送，系统提示词额外要求仅输出简体中文译文且保护标记不变。用户可自定义提示词。
7. 保留并内联经过清理的出版商 CSS、正文祖先容器、class/id 与安全内联样式；保存内联资源页面、最终译文 HTML 和 PDF，打印并导入 `全文翻译` 子附件。原始网页响应在解析前落盘；每 20 段完成后写进度状态和一个批次 JSON，批次文件包含该组段落原文/译文；失败时不足 20 段的尾批也会写盘。这样避免重复序列化全量进度或生成数千个小文件。单篇最多 5000 个请求片段，超限即失败且不导出。附件成功导入后才清理本地工作区；失败时保留原网页、净化页、翻译进度、提示词和错误记录，并在错误中给出目录路径。失败目录可能含受版权保护的全文与译文，应按需手动检查并清理。

## 已有文献补处理

1. 本插件只添加两个文献右键菜单：**导入 SI** 和 **生成全文翻译**。手动命令不依赖新增文献时的自动选项。
2. 点击 **导入 SI** 直接从出版商获取第一份可识别的 SI，不弹来源选择框。有 DOI 时优先使用 DOI 解析地址，否则使用条目网址。多选时逐条处理。PDF 直接附加；受支持的非 PDF 文件在 Windows 上用 Microsoft Office 转换。只有 Zotero 返回已保存的子附件才报告完成。
3. 导入遇到 HTTP 403 或识别出 Cloudflare / 安全验证页时，仿照 Zotero Connector 流程自动弹出独立安全验证窗口：窗口开启期间临时放行验证所需会话 Cookie、追踪保护及网络分区并统一 Firefox UA，支持自动跳过或手动点击验证框，通过后自动提取第一份 SI 链接并在当前已验证会话内下载（跨域回退至带会话 Cookie 的 HTTP 请求，下载主机若二次质询则在同一窗口完成验证）、转换 PDF、自动关闭窗口并导入子附件；窗口关闭后立即恢复原有 Zotero 偏好。用户也可在工具栏手动点击「已通过，立即提取 SI」或「取消」。单条手动请求遇到状态 0、超时或离线时，询问是否打开网页检查；后台遇到这些连接错误只给非模态提示，不阻断全文翻译。
4. 失败或取消验证后，SI 任务立即释放锁。再次点击 **导入 SI** 会从文章页发起新请求，不复用上一次请求的本地 HTTP 缓存、工作区或失败状态；同一出版商已通过验证的会话 Cookie 可被后续请求自动复用。正在运行的同条目 SI 不会重复启动，全文翻译仍在运行不妨碍再次发起 SI。
5. 失败保留 `si-error.txt` 与已有中间文件，记录处理阶段以及可取得的请求来源、HTTP 状态和 Gecko 通道状态。全文翻译失败会停止该手动批次；失败详情也可见于 Zotero Debug Output。

## 翻译服务配置

在 Zotero **编辑 → 设置 → Zotero PaperFlow** 中可添加多个供应商配置、选择当前使用的供应商，并填写名称、OpenAI-compatible Chat Completions 端点和模型。内置 OpenAI、DeepSeek、SiliconFlow、OpenRouter 预设，也可填写自定义兼容端点；每次只调用选中的供应商；翻译错误不会自动切换备用供应商。

每个供应商配置填写一个 **API 密钥环境变量名**，密钥本身只放在操作系统环境变量中，不写入插件偏好、源码或 Zotero Login Manager。环境变量必须在启动 Zotero 前设置；修改后需重新启动 Zotero。0.2.0 及更早版本曾把密钥保存在 Zotero Login Manager，新版不再读取或自动删除该旧记录，请按需在 Zotero 密码管理器中自行清除。

系统提示词默认使用 Cometix Translate `paper` 预设 **Academic Paper Translation Expert** 的 `systemPrompt` 模板（来自本机 `default_config.json`），自动填充目标语言；论文标题和摘要作为单独标记的非可信元数据仅随第一个片段发送，其余片段只附标题上下文。用户可在设置中自定义提示词。全文翻译会将正文和首段请求元数据发送至当前配置的兼容服务。根据维护者确认，Cometix `paper` 提示词模板的公开使用授权已取得；项目不包含其 provider bundle、扩展私有配置或密钥。

## 安装与试用

1. 用 7-Zip 将 `zotero-paperflow-0.3.15.xpi` 作为压缩包打开并确认根目录含 `manifest.json`、`bootstrap.js`、`chrome.manifest` 与 `defaults/`。
2. 在 Zotero 中选择 **工具 → 插件 → 齿轮 → Install Plugin From File…**，选取该 XPI，按提示重启 Zotero。
3. 打开 **编辑 → 设置 → Zotero PaperFlow**，分别选择两个选项并保存。全文翻译需选择已配置的供应商、设置模型与密钥环境变量、保存或自定义系统提示词；SI 的非 PDF 转换需要 Windows 与可用的 Microsoft Office 组件。PowerPoint 的 PDF 导出可能显示 PowerPoint 窗口。
4. 新增具有 DOI/网页 URL 的测试文献验证自动选项；已有文献可在文库中选中后右键，分别执行补抓 SI 或生成中文全文翻译。

清单中的 `update_url` 使用保留的 `.invalid` 域名占位，避免在没有托管更新服务时请求第三方地址。因此本包不支持自动更新；后续版本需手动安装新版 XPI。若要启用自动更新，应先将更新清单和 XPI 发布到由你控制的 HTTPS 地址，再修改 `applications.zotero.update_url`。

## 构建与打包验证

在仓库根目录运行：

```bash
node scripts/build-xpi.mjs
node test/package-smoke.mjs ../zotero-paperflow-0.3.15.xpi
```

## 当前验证边界

- 已用 `test/pdf-smoke.html` 经 Microsoft Edge headless 打印并查看 `test/pdf-smoke.pdf`：一页中文排版、MathML 公式、SVG 图片与链接均可见。
- 已在 Node VM 中调用实际 `makeWebsitePdfPage()` 生成 `test/site-style-smoke.html`，再由 Edge 打印并查看 `test/site-style-smoke.pdf`：模拟出版商 CSS、标题、正文颜色、公式、内嵌图和链接均保留。
- `node test/behavior-smoke.mjs` 在 VM 中验证多供应商、Cometix 模板/自定义提示词与旧端点迁移回退、环境变量密钥、HTTP/HTTPS URL 与安全重定向、响应限额及取消区分、在途请求取消、段落拆分/并发/中文门禁、SI 首文件、Cloudflare 质询窗口自动/手动通过与会话内下载/跨域回退/二次验证/取消恢复、失败保留临时文件和卸载期间停止任务。
- `node test/static-smoke.mjs` 检查模块清单、默认偏好、设置恢复/容量、请求限制、质询窗口配置、原始响应先保存、翻译门禁与导出顺序、Office 转换退出/清理路径；完整 JavaScript 语法、XHTML 与 manifest JSON 另行检查。
- `node test/package-smoke.mjs <XPI>` 验证归档完整性、版本与清单，并逐字节比较全部 16 个包内源文件；`node scripts/build-xpi.mjs` 从临时新归档构建，仅在版本包不存在时创建，创建后再次校验。
- 本机 Microsoft Office COM 小样例实际转换已验证：Word `.txt`、Excel `.csv`、PowerPoint `.pptx` 均以退出码 0 生成带 `%PDF-` 文件头的 PDF；PowerPoint 自动化可能显示应用窗口。
- 逐段字符门禁拒绝空译文、缺少中文的文本段、日文假名/韩文和词表能识别的部分繁体字符，并筛查明显未译原文与异常短输出；这些启发式不能证明句子语义完整或翻译准确。其余未覆盖项包括 Zotero XUL `nsIWebBrowserPrint` 的版本兼容、插件安装、真实网站正文提取、真实 API 请求、Office 对损坏/受保护文件的自动化行为、Zotero 附件导入或其他 Office 版本对 ODF/图片的兼容性。
- SI 重试、Cloudflare 质询窗口自动/手动跳过、会话内下载、二次验证、状态 0 诊断和每次请求不使用本地 HTTP 缓存均用 VM 模拟验证。未在实际 Zotero 或出版商站点执行整套流程。
- 为避免影响日常 Zotero 库，本项目不启动 Zotero 做测试。动态渲染且只通过 JavaScript 加载正文的期刊页目前不能保证提取成功；插件遇到失败时不创建翻译附件。
- PDF 会尽量沿用对应网页样式表、正文容器和内联样式，但浏览器打印分页和网页屏幕布局存在差异，不承诺与任何现有「全文翻译」附件逐页像素级一致；不依赖旧附件模板源码。
