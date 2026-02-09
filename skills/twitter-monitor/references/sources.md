# Twitter 数据源列表

## 抓取方法
~~使用 `web_fetch` 获取 nitter 镜像站的 HTML 页面，然后用 python3 正则解析。~~

⚠️ **2026-02-09 更新**: xcancel.com 新增 JS 反爬验证（check1.js / BotD 检测），`curl` 和 `web_fetch` 已无法直接抓取（403/503）。**必须使用 `browser` 工具**（浏览器自动化）绕过 JS challenge 获取页面内容。

## 数据源（按优先级排序）

| 源 | URL格式 | 状态 | 最后验证 | 备注 |
|---|---|---|---|---|
| xcancel.com/with_replies | `https://xcancel.com/{username}/with_replies` | ✅ 首选 | 2026-02-09 | 比主页更稳定，包含回复和转推 |
| xcancel.com | `https://xcancel.com/{username}` | ⚠️ 不稳定 | 2026-02-09 | 间歇性返回"No items found" |
| syndication.twitter.com | `https://syndication.twitter.com/srv/timeline-profile/screen-name/{username}` | ⚠️ 热门only | 2026-02-09 | 返回Top Tweets(历史热门)，非最新timeline。只有pinned是最新的 |
| nitter.poast.org | `https://nitter.poast.org/{username}` | ❌ 503 | 2026-02-09 | Cloudflare 反爬验证 |
| nitter.net | `https://nitter.net/{username}` | ❌ 空内容 | 2026-02-09 | 页面返回但无数据 |
| nitter.privacydev.net | `https://nitter.privacydev.net/{username}` | ❌ DNS失败 | 2026-02-09 | 已下线 |
| nitter.lucabased.xyz | | ❌ 521 | 2026-02-09 | |
| nitter.cz | | ❌ 403 | 2026-02-09 | |
| nitter.woodland.cafe | | ❌ DNS失败 | 2026-02-09 | |
| bird.trom.tf | | ❌ DNS失败 | 2026-02-09 | |
| nitter.1d4.us | | ❌ DNS失败 | 2026-02-09 | |

## HTML 解析要点

### 页面结构 (xcancel.com, 2026-02-09 验证)
- 用 `<div class="timeline-item ">` 分割每条推文
- Pinned 推文：block前300字符包含 "Pinned Tweet"
- Retweet：包含 `class="retweet-header"`
- 推文链接/ID/时间：`href="/{user}/status/{id}#m" title="{timestamp}"`
- 内容：`class="tweet-content media-body"` 的 div
- 引用推文：`class="quote-text"` 的 div
- 图片：`class="still-image" href="{url}"`
- 视频：包含 `class="attachment video"` 或 `gallery-video`
- 统计数据：`class="tweet-stats"` 内，icon-comment/retweet/heart 后跟数字，最后一个数字是浏览量

### 时间戳格式
`Feb 8, 2026 · 11:36 PM UTC` → 需转换为 CST (UTC+8)

## 失败记录
（每次失败后在此追加，积累经验）

- 2026-02-09: nitter.net/poast.org/privacydev.net 均不可用，xcancel.com 首次验证成功
- 2026-02-09 10:10: xcancel.com 主页返回"No items found"，with_replies 正常。syndication API 返回100条但是历史热门排序（仅1条最新）。最终用 with_replies 成功抓取21条推文。新增测试6个nitter镜像全部不可用。
- 2026-02-09 10:10: xcancel.com 主页间歇性返回 "No items found"（curl 获取 HTML 只有 8.9KB）
  - 所有 nitter 镜像均不可用（lucabased/cz/woodland/bird.trom/1d4）
  - xcancel RSS 需要 whitelist 邮件申请
  - syndication.twitter.com 可用但返回历史热门推文（非最新timeline）
  - **突破**: xcancel.com/elonmusk/with_replies 有完整数据（21条），成为新的首选源
  - 新发现的抓取路径优先级: with_replies > 主页 > syndication（仅热门）
- 2026-02-09 10:37: xcancel.com 新增 JS 反爬（check1.js + BotD），curl/web_fetch 返回 403/503。必须用 browser 工具绕过。已验证 browser 方式可正常抓取。
