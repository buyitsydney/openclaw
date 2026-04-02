# Twitter 数据源 — 经验手册

这不是指令，是给你的参考。你自己决定怎么抓。

## 可用数据源（2026-02-14 验证）

| 源                           | URL 格式                                      | curl/web_fetch             | browser              | 备注                                           |
| ---------------------------- | --------------------------------------------- | -------------------------- | -------------------- | ---------------------------------------------- |
| **xcancel.com/with_replies** | `https://xcancel.com/{username}/with_replies` | ⚠️ Musk 可用，其他常 503   | ✅ 稳定              | 首选。包含回复和转推，数据最全                 |
| **xcancel.com**              | `https://xcancel.com/{username}`              | ⚠️ 间歇性 "No items found" | ✅ 可用              | 主页有时缺数据                                 |
| **nitter.net**               | `https://nitter.net/{username}`               | ❌ 返回空（TLS 指纹拦截）  | ✅ 可用              | 2/14 重新验证可用！DOM 结构与 xcancel 几乎一致 |
| x.com（游客模式）            | `https://x.com/{username}`                    | ❌ 需要 JS 渲染            | ⚠️ 只显示 Highlights | 不是完整时间线，仅限热门帖                     |

## ❌ 已确认不可用（别浪费时间）

nitter.poast.org (503)、nitter.privacydev.net (DNS 死)、nitter.cz (403)、nitter.woodland.cafe (DNS 死)、bird.trom.tf (DNS 死)、nitter.1d4.us (DNS 死)、nitter.lucabased.xyz (521)

## 经验教训

### curl/web_fetch vs browser

- **curl + User-Agent 头**对 xcancel 的 Musk 账号连续多天可用，但对其他账号（Google、Anthropic、Cursor 等）几乎必定 503
- **nitter.net 对 curl 返回 200 但 content-length: 0**（服务端 TLS 指纹检测），只有真实浏览器能拿到内容
- **browser 工具**（headless Chromium）对所有源都稳定可用，是最可靠的万能方案
- 如果你想省资源可以先试 curl，但 browser 永远是可靠的 fallback

### 页面结构（xcancel / nitter 共用）

- `.timeline-item` 分割每条推文
- Pinned: 开头包含 "Pinned Tweet"
- Retweet: 包含 `.retweet-header`
- 时间戳: `a[href*="/status/"]` 的 `title` 属性，格式如 `Feb 8, 2026 · 11:36 PM UTC`
- 内容: `.tweet-content.media-body`
- 引用: `.quote-text`
- 图片: `.still-image` 的 `href`
- 统计: `.tweet-stats` 内的数字

### 一个聪明的做法（Docker 4 验证）

直接用 `browser.act` 的 `evaluate` 在页面内执行 JS 解析推文，一步拿到结构化 JSON。比 snapshot → Python 正则更优雅可靠。

## 更新日志

有新发现就追加在这里。

- 2026-02-15: cron job 失败 - xcancel/nitter 全部被阻，browser 服务未运行。需要在有 browser 服务的环境执行。

- 2026-02-14: nitter.net 用 browser 重新验证可用！curl/web_fetch 仍不可用（TLS 指纹拦截）。与 xcancel 形成双源冗余。
- 2026-02-14: xcancel curl 对 Musk 连续5天可用，其他账号持续 503，browser fallback 100% 成功率。
- 2026-02-14: Docker 内 AI 使用 browser.evaluate + JS 注入方式解析推文，比 Python 正则更可靠。
