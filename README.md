# JavDB 全分页磁链采集

油猴脚本：采集当前排行榜、清单、演员、番号前缀、片商或分类筛选的全部分页，为每部影片选一条磁链，导出可直接批量下载的磁链 TXT。

## 一键导入、安装、更新

**[一键导入到油猴](https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.user.js)** · **[一键安装](https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.user.js)** · **[一键更新到最新版](https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.user.js)**

这三个入口使用同一个稳定地址：未安装时进入安装页，已安装时进入更新或重新安装页。需要先安装并启用 [Tampermonkey（篡改猴）](https://www.tampermonkey.net/)，并在扩展打开的页面确认“安装”或“更新”。

如果链接只显示源代码，可在油猴的 URL 导入／安装入口粘贴：

```text
https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.user.js
```

已手动安装旧版的用户也可使用上面的更新链接。脚本名称和 namespace 保持不变，以便识别已有脚本；升级前可先导出需要保留的采集结果。

## 自动更新

- **脚本版本**：已配置 `@updateURL` 和 `@downloadURL`。把油猴的脚本更新检查间隔设为“每天”；仓库发布更高版本后，油猴会按其设置检查和处理更新。也可以直接点击上方“一键更新”。
- **最新地址**：打开 JavDB 网页时读取站点公告，缓存 24 小时；页面持续打开时到期重查。浏览器关闭期间，下次打开时补查。检查失败会保留已知地址，并在 1 小时后重试。
- **域名匹配**：支持 `javdb.com`、`www.javdb.com`、`javdb580.com` 及未来 `javdb数字.com` 的 `www`／非 `www` 版本。如果官方完全改变域名格式，需要发布新的匹配规则。

版本检查地址：[javdb-collector.meta.js](https://raw.githubusercontent.com/roronoia/javdb-collector.user/main/javdb-collector.meta.js)。

## 使用

1. 打开具体的影片作品列表，调整好筛选条件和排序。
2. 点击右下角“开始采集”。从该列表第 1 页一直处理到最后一页。
3. 等待完成，点击“导出 TXT”，或直接点击“复制磁链”粘贴到下载工具。

导出默认每行一条磁链，可以整段复制到 qBittorrent 的“添加链接”窗口或迅雷的批量下载窗口。需要核对番号时，可在“导出格式”中改选“番号 + 磁链”。

支持暂停、继续、刷新后恢复、失败重试及磁力哈希去重。文件名默认使用页面名称；分类筛选时包含所有已选分类，也可在面板中修改。

每部影片优先级：**高清且有中文字幕 → 高清 → 有中文字幕 → 第一条有效磁链**。磁链名称明确写出分辨率时，以名称为准，1080P 及以上算高清；否则沿用站点标签。

默认导出（纯磁链，每行一条，不含番号和分隔线，可直接粘贴到 qBittorrent / 迅雷批量下载）：

```text
magnet:?xt=urn:btih:...
magnet:?xt=urn:btih:...
```

“番号 + 磁链”格式（每行一条，番号和磁链之间两个空格）：

```text
ABC-001  magnet:?xt=urn:btih:...
BBAN-612  magnet:?xt=urn:btih:...
```

登录、年龄确认、站点验证或限流出现时会暂停，完成必要操作后继续。关闭标签页会停止采集；换域名前先暂停旧标签页。不同域名的登录状态不会跨站转发。

完整说明见 [使用说明.md](使用说明.md)。

## 开发与验证

运行环境：Node.js 20 或更新版本。脚本本身无运行时第三方依赖，`linkedom` 仅用于测试。

```sh
npm ci
npm test
npm run check
```

当前包含 54 项自动化测试，覆盖选择规则、分页完整性、恢复、两种导出格式、剪贴板复制、域名缓存及跨域名任务复制。另已核对真实站点 DOM，并用本地浏览器样例验证下载和面板操作；尚未完成完整真实站点批量采集验收。

## 发布新版本

修改脚本后提升 `@version`，同步 `.meta.js` 的元数据头，再运行测试。将两个文件一起推送到 `main`，确保安装和更新地址始终指向同一版本。
