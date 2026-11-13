# 抖音无水印下载器（macOS）

在本机运行的抖音视频下载工具：Flask 后端 + Tampermonkey 前端脚本 + yt-dlp 解析。

所有内容只保存在本机，不上传任何第三方服务器。

> 关键词：本地服务 · 油猴脚本注入 · 剪贴板监听 · 来源校验 · 边界处理

---

## 能力

- **浏览器一键下载**：油猴脚本在视频页、推荐、关注、朋友页右侧注入浮动按钮，通过 `fetch` 调用本地 API。
- **剪贴板监听**：手机通过 Handoff 复制分享文案后，自动识别 `v.douyin.com` 链接并下载。
- **多账号映射 / 指定归档**：把其他账号发布的视频归档到同一个主文件夹，文件名保持原样。
- **复制作者 UID**：只解析元数据不下载，方便维护映射表。
- **快捷键 C**：下载当前视频，同时保留抖音原生的"取消收藏"行为。
- **自动连播**：自动下载 → 模拟取消收藏 → 滚动下一个，适合收藏夹挂机。

---

## 架构

```
┌─────────────────────┐        fetch         ┌──────────────────────┐
│  Tampermonkey 脚本   │  ──────────────────> │  Flask 本地服务 :5001 │
│  (douyin.com 页面内) │  <────────────────── │  app.py              │
└─────────────────────┘        JSON          └──────────┬───────────┘
                                                         │
                                          ┌──────────────┼──────────────┐
                                          ▼              ▼              ▼
                                     yt-dlp 解析     作者 UID 映射   文件归档
```

- **前端脚本**：只做三件事——识别当前视频、发请求、显示结果。不做解析，避免在页面环境里跑复杂逻辑。
- **后端服务**：负责链接规范化、视频解析、下载、命名、归档、任务状态。
- **剪贴板监听**：独立线程，与 HTTP 服务并行运行。

---

## 工程与安全设计

这一节是代码里实际做的防御，不是事后总结。

| 机制 | 实现 | 解决什么 |
| --- | --- | --- |
| **来源校验** | `_origin_allowed()` 只放行 `douyin.com` 及其子域、`127.0.0.1`、`localhost` | 防止任意网页通过浏览器调用本地服务下载/写文件 |
| **链接规范化** | `canonicalize_douyin_url()` 统一短链、分享文案、带参数链接 | 同一视频的不同写法归一到同一 ID，避免重复下载 |
| **类型化异常** | `InvalidDouyinLink` / `VideoResolveError` 分开 | 前端能区分"链接无效"和"解析失败"，给出不同提示 |
| **端口冲突处理** | `_port_available()` + `_explain_busy_port()` | 端口被占用时给出可执行命令（含 `lsof` 排查），而不是抛栈 |
| **文件名安全** | `safe_folder_component()`、拼音首字母生成、非法字符过滤 | 中文、emoji、超长昵称都不会导致写文件失败 |
| **任务状态隔离** | `DownloadJob` + `DownloadManager` 管理任务生命周期 | 批量下载时单任务失败不影响其他任务 |
| **服务边界** | `create_app()` 工厂函数 + CLI 参数解析 | 便于测试时注入不同配置，而不是全局状态 |

---

## 安装与运行

```bash
mkdir -p ~/DouyinTool && cd ~/DouyinTool
# 放入 app.py、douyin_downloader.user.js、requirements.txt

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python3 app.py            # 默认监听 127.0.0.1:5001
```

然后在浏览器安装 Tampermonkey，新建脚本并粘贴 `douyin_downloader.user.js` 的内容。

> `yt-dlp` 建议保持最新版：抖音解析规则经常变化，旧版本会解析失败。

---

## HTTP API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/folders` | 列出可归档的目标文件夹 |
| `GET` | `/api/author_info` | 解析链接对应的作者信息（不下载） |
| `POST` | `/api/download` | 提交下载任务，返回 `job_id` |
| `GET` | `/api/status/<job_id>` | 查询任务进度与结果 |

示例：

```bash
curl -X POST http://127.0.0.1:5001/api/download \
  -H "Content-Type: application/json" \
  -d '{"url":"https://v.douyin.com/xxxxxxx/"}'

curl http://127.0.0.1:5001/api/status/<job_id>
```

---

## 可测试的纯函数

核心解析逻辑与 IO 解耦，下列函数都是纯函数，可以直接针对输入输出写断言：

| 函数 | 输入 | 可验证的性质 |
| --- | --- | --- |
| `canonicalize_douyin_url` | 短链 / 分享文案 / 带参链接 | 同一视频应归一到同一 ID；非法域名应抛 `InvalidDouyinLink` |
| `extract_video_id_from_url` | 各种 URL 形式 | 正确提取；非抖音链接返回 `None` |
| `safe_folder_component` | 中文、emoji、超长、含 `/` 的昵称 | 输出不含路径分隔符，长度受限 |
| `make_author_folder_name` | 昵称 + UID | 不同作者不冲突；同作者稳定 |
| `match_folder_name` | 已有文件夹列表 + 查询词 | 精确/模糊匹配行为符合预期 |

> 当前这些性质通过手动回归验证。下一步计划用 `pytest` 覆盖上述表格中的每一行。

---

## 已知限制

- 仅在 macOS 上验证，其他平台需自行调整路径与剪贴板实现；
- 依赖抖音页面结构，前端脚本的 DOM 选择器可能随改版失效；
- 仅用于个人备份已获授权的内容，请遵守平台服务条款。

---

## 目录结构

```
app.py                      # Flask 服务：解析、下载、归档、任务管理
douyin_downloader.user.js   # Tampermonkey 脚本：页面注入与交互
authors_mapping.example.json# 作者 UID → 目标文件夹映射示例
requirements.txt            # Python 依赖
```

> `authors_mapping.json` 含个人账号映射，已加入 `.gitignore`，不在公开仓库中。
