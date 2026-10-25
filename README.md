# 抖音无水印下载器（macOS）

一个在本机运行的抖音视频下载工具，包含以下能力：

- **剪贴板监听**：手机通过 Handoff 复制抖音分享文案后，自动识别 `v.douyin.com` 链接并下载。
- **浏览器一键下载**：Tampermonkey 脚本在抖音视频页、推荐、关注、朋友页右侧注入浮动按钮，通过 `fetch` 调用本地 API。
- **复制作者 UID**：只解析元数据，不下载视频，方便维护多账号映射。
- **指定归档 / 多账号映射**：把其他账号发布的视频归档到同一个主文件夹，文件名保持原样。
- **快捷键 C**：按 C 下载当前视频，同时保留抖音原生的“取消收藏”行为。
- **自动连播**：自动下载 → 模拟 C 取消收藏 → 滚动下一个，适合收藏夹挂机。

下载使用 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，保存目录固定为 `~/Douyin_Saved`（直接位于用户主目录，**不会保存到桌面**）。所有内容都保存在本机，不会上传到第三方服务器。

> 公开仓库不会包含 `authors_mapping.json`，避免泄露个人账号映射。首次启动会自动生成空的 `{}` 文件；也可以复制 `authors_mapping.example.json` 后修改。

---

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `app.py` | Flask API、剪贴板监听、yt-dlp 下载、UID 分类、映射与归档逻辑 |
| `douyin_downloader.user.js` | Tampermonkey 油猴脚本（下载、复制 UID、指定归档、快捷键 C、自动连播） |
| `authors_mapping.json` | 作者 UID → 目标文件夹映射；本地自动生成，已加入 `.gitignore` |
| `authors_mapping.example.json` | 空的映射示例文件，公开仓库不包含真实 UID |
| `requirements.txt` | Python 依赖 |

---

## 1. 安装依赖

建议把工具放在 `~/DouyinTool`，然后使用虚拟环境（macOS 的 Homebrew Python 通常会阻止直接写系统环境）：

```bash
mkdir -p ~/DouyinTool
cd ~/DouyinTool
# 把 app.py、douyin_downloader.user.js、requirements.txt 放到这里

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --upgrade yt-dlp flask pypinyin pyperclip requests
```

如果不想用虚拟环境，对应的单行命令是：

```bash
python3 -m pip install --upgrade yt-dlp flask pypinyin pyperclip requests
```

也可以直接安装 `requirements.txt`：

```bash
python -m pip install --upgrade -r requirements.txt
```

> `yt-dlp` 必须尽量保持最新。抖音的接口和校验经常变化，旧版本最常见的报错就是 `Fresh cookies ... are needed` 或 `HTTP 403`。

---

## 2. 配置抖音 Cookie（可选，推荐）

`app.py` 已内置抖音 `x-secsdk-web-signature` 兼容补丁，公开视频通常不配置 Cookie 也能解析。配置 Cookie 可以提升成功率、画质，并访问登录后可见的内容。

如果仍看到：

```text
[Douyin] ...: Fresh cookies (not necessarily logged in) are needed
```

先确认启动日志里有：

```text
已启用 Douyin x-secsdk-web-signature 兼容补丁
```

没有的话，说明还在运行旧版 `app.py`，重启服务即可。

### 方式 A：直接读取浏览器 Cookie（推荐）

先在前台运行一次，完成 macOS 可能弹出的钥匙串/权限确认：

```bash
cd ~/DouyinTool
source .venv/bin/activate

# Chrome
python app.py --cookies-from-browser chrome

# Edge
python app.py --cookies-from-browser edge

# Safari
python app.py --cookies-from-browser safari

# Firefox
python app.py --cookies-from-browser firefox
```

如果使用 Chrome 的某个独立 Profile：

```bash
python app.py --cookies-from-browser "chrome:Profile 1"
```

注意事项：

- Chrome / Edge 读取 Cookie 时可能弹出“钥匙串访问”提示，选择**允许**。
- Safari 需要给终端（Terminal / iTerm）授予 **完全磁盘访问权限**：
  `系统设置 → 隐私与安全性 → 完全磁盘访问权限`。
- 如果浏览器正在运行导致 Cookie 数据库被锁，先完全退出浏览器再试。
- Cookie 等同于登录凭证，不要发给别人，也不要提交到 Git。

### 方式 B：使用 cookies.txt 文件

用浏览器扩展导出 Netscape 格式的 `cookies.txt`（例如 “Get cookies.txt LOCALLY”），然后：

```bash
python app.py --cookies ~/Downloads/douyin-cookies.txt
```

`--cookies` 和 `--cookies-from-browser` 只能二选一。

---

## 3. 前台启动

```bash
cd ~/DouyinTool
source .venv/bin/activate
python app.py --cookies-from-browser chrome
```

默认监听：`http://127.0.0.1:5001`。

> **为什么不用 5000？** macOS 的“隔空播放接收器”（ControlCenter）经常占用 5000，所以本项目默认使用 5001，油猴脚本也已同步写成 5001。若 5001 也被占用，可以用 `--port 5002`，并同步修改脚本里的 `API_BASE`。

检查服务是否正常：

```bash
curl http://127.0.0.1:5001/api/health
```

正常返回示例：

```json
{
  "ok": true,
  "service": "douyin-downloader",
  "base_dir": "/Users/你的用户名/Douyin_Saved",
  "clipboard_watcher": true,
  "pending_jobs": 0,
  "recent_links": 0
}
```

可选参数：

```text
--port 5001                 修改 HTTP 端口
--interval 0.8              剪贴板轮询间隔（秒）
--no-clipboard              只启动 API，不监听剪贴板
--cookies PATH              指定 cookies.txt
--cookies-from-browser ...  从浏览器读取 Cookie
--verbose                   输出调试日志
```

---

## 4. 触发方式一：剪贴板监听

启动 `app.py` 后，脚本会在后台线程中轮询剪贴板：

1. 在手机上点击抖音的“分享 → 复制链接”。
2. 通过 Handoff / 通用剪贴板，让链接出现在 Mac 剪贴板。
3. 程序检测到文本里包含 `v.douyin.com` 后，用正则提取纯链接并下载。
4. 最近处理过的 **10 个链接**会保留在内存中；如果剪贴板里还是旧链接，不会重复下载。
5. 同一个视频即使换成了另一种链接形式（例如短链和 `www.douyin.com/video/...`），也会通过视频 ID 避免重复下载。

说明：

- 程序启动时如果剪贴板里已经有一个抖音链接，会立即处理一次。
- 下载失败的任务会从“最近链接”中移除，方便通过按钮或 API 重试；剪贴板内容本身仍然遵循“相同内容不重复触发”。
- 剪贴板监听使用 `pyperclip`，失败时自动回退到 macOS 的 `pbpaste`。

---

## 5. 触发方式二：Tampermonkey 悬浮按钮

### 安装脚本

1. 在 Chrome / Edge / Safari 安装 Tampermonkey（油猴）扩展。
2. 打开 Tampermonkey 管理面板 → “添加新脚本”。
3. 删除模板内容，把 `douyin_downloader.user.js` 的完整内容粘贴进去。
4. 保存（`Cmd + S`），确认脚本已启用。

   > 当前脚本版本为 **1.3.2**。从旧版本更新时请**整段替换**旧脚本；如果 Tampermonkey 提示新增权限，请允许。

5. 打开抖音视频页或信息流页都行：

   ```text
   https://www.douyin.com/video/7xxxxxxxxxxxxxxxxxx
   https://www.douyin.com/?recommend=1
   https://www.douyin.com/follow
   https://www.douyin.com/friend
   https://www.douyin.com/?modal_id=7xxxxxxxxxxxxxxxxxx
   ```

6. 页面右侧中间会出现主按钮 **“⬇ 一键下载”**，下方新增：

   - **📋 复制作者UID**：只调用元数据接口，不下载视频；成功后用 `navigator.clipboard.writeText()` 复制 UID，并弹窗提示 `✅ 已复制 UID：xxx，请前往 JSON 文件进行映射`。
   - **📁 指定归档**：打开带自动补全的文件夹选择弹窗，可跨账号把当前视频归档到指定目录。

   信息流页面（推荐/关注/朋友）的地址栏不会随视频切换而变化，脚本会从当前正在播放的卡片中读取视频 ID，再构造规范链接并 `POST` 到：

   ```text
   http://127.0.0.1:5001/api/download
   ```

   识别顺序为：

   1. 地址栏中的 `/video/<id>`、`modal_id` 等；
   2. `[data-e2e="feed-active-video"]` 当前卡片上的 `data-e2e-vid`；
   3. 当前视频地址中的 `__vid`；
   4. 拦截页面自己的 `aweme/v1/web` 信息流响应，用视频 CDN 地址反查 ID；
   5. 卡片周边链接与 React 组件数据。

   如果这些手段都没有拿到 ID，脚本会提示先让视频出现在画面中并开始播放，再点一次。

### 快捷键 C 与自动连播

主按钮下方还有：

- **☑ 启用快捷键 C**（默认勾选）
  - 按 `C` 或 `Shift+C` 下载当前视频。
  - 1 秒防抖，连续按只提交一次。
  - 不调用 `preventDefault()`，所以抖音原生的 `C`（取消收藏）仍会执行。
  - `Cmd+C`、`Ctrl+C`、`Alt+C` 不会触发下载，避免影响复制。
  - 在输入框/搜索框中按 C 不会触发。
- **▶ 开始自动连播**
  - 点击后按钮变为 **⏸ 停止连播**。
  - 每轮执行：
    1. 提交当前播放视频；
    2. **只有“启用快捷键 C”勾选时**，才 `dispatchEvent` 模拟按下 C（取消收藏）；未勾选则跳过这一步；
    3. 等待 2500ms（无论是否按 C 都保持这个等待）；
    4. 切换到下一个视频；
    5. 等待 2000ms；
    6. 继续循环。
  - 收藏夹弹窗实际是 Swiper 的 `transform` 动画，不是可滚动容器，`window.scrollBy` 不会切换视频。v1.3.1 改为优先调用页面自身的 `playNextFunc`，成功后再等待 2 秒；失败时才回退到滚动 / `ArrowDown`。
  - 如果合成的 C 已经让页面自动切换，脚本会跳过额外切换，避免一次跳两个视频。
  - 当前视频 ID 优先从正在播放的卡片读取，避免地址栏 `modal_id` 滞后导致一直下载同一个视频。
  - 点击“停止连播”会立即让当前 `await` 定时器返回并退出循环，不需要等 2.5 秒/2 秒结束。
  - 自动连播派发的合成 C 事件不会再次触发快捷键下载，避免一轮提交两次。
  - 快捷键 C 复选框与自动连播联动：勾选时自动按 C；取消勾选时自动连播仍会下载和切换视频，但完全不按 C。
  - 连播面板会显示当前状态：`快捷键 C：启用（会按 C）` 或 `快捷键 C：关闭（不按 C）`。
  - 页面跳转到不支持的页面或关闭时，会自动停止连播并释放定时器。

> 自动连播不会校验视频是否已收藏，也不会寻找收藏按钮，完全按上面流程执行。

### 首次使用可能遇到的浏览器提示

- Chrome 可能提示是否允许访问本地网络，选择允许。
- 如果页面 CSP 或 Chrome 的 Private Network Access 拦截了 `fetch`，脚本会自动回退到 `GM_xmlhttpRequest`（需要允许 Tampermonkey 访问 `127.0.0.1`）。
- Safari 可能提示本地网络权限，也需要允许。
- 如果改过 Python 端口，记得同步修改脚本开头的：

  ```js
  const API_BASE = 'http://127.0.0.1:5001';
  ```

### 按钮不显示？

- 推荐页、关注页、朋友页和视频详情页都会显示按钮；如果没看到，先确认油猴脚本已经保存并启用，然后刷新页面。
- 脚本更新后建议整段替换旧脚本，并在 Tampermonkey 中重新保存。
- 如果按钮出现但点击后提示“没有识别到当前视频 ID”，请让目标视频完整显示在画面中并开始播放后再点一次。
- 抖音网页结构会变化；如果长期无法识别，请更新脚本，或改用剪贴板分享链接方式。

---

## 6. 用 API 直接调用

```bash
curl -X POST http://127.0.0.1:5001/api/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://v.douyin.com/xxxxxxx/"}'
```

也可以直接传分享文案，后端会自动提取链接：

```bash
curl -X POST http://127.0.0.1:5001/api/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"7.43 复制打开抖音，看看…… https://v.douyin.com/xxxxxxx/ 复制此链接"}'
```

返回：

```json
{
  "ok": true,
  "duplicate": false,
  "message": "已加入下载队列。",
  "job": {
    "id": "a1b2c3d4e5f6",
    "status": "queued"
  }
}
```

指定归档目标时，额外传入 `target_author`（值是从 `/api/folders` 选中的文件夹名）：

```bash
curl -X POST http://127.0.0.1:5001/api/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.douyin.com/video/7xxxxxxxxxxxxxxxxxx","target_author":"D大老王子（_UID_222222222）"}'
```

### 只获取作者 UID（不下载）

```bash
curl --get http://127.0.0.1:5001/api/author_info \
  --data-urlencode 'url=https://www.douyin.com/video/7xxxxxxxxxxxxxxxxxx'
```

返回：

```json
{
  "ok": true,
  "author_nickname": "元气弹",
  "uid": "3284940304680567",
  "video_id": "7700164284748523441",
  "title": "视频标题"
}
```

### 获取归档文件夹列表

```bash
curl http://127.0.0.1:5001/api/folders
```

返回 `~/Douyin_Saved` 下的一级文件夹（自动过滤隐藏目录和符号链接）：

```json
{
  "ok": true,
  "count": 3,
  "folders": [
    "Aalex（_UID_333333333）",
    "D大老王子（_UID_222222222）",
    "L老王（_UID_111111111）"
  ]
}
```

查询任务状态：

```bash
curl http://127.0.0.1:5001/api/status/a1b2c3d4e5f6
```

状态依次为：`queued` → `downloading` → `success` / `error`。成功时 `job.file` 是保存位置，`job.folder` 是作者目录。

---

## 7. 后台一直运行（nohup）

先确保保存目录存在，再启动：

```bash
cd ~/DouyinTool
mkdir -p ~/Douyin_Saved

nohup .venv/bin/python app.py --cookies-from-browser chrome \
  > ~/DouyinTool/app.log 2>&1 &

echo $! > ~/DouyinTool/app.pid
```

查看状态和日志：

```bash
curl http://127.0.0.1:5001/api/health
tail -f ~/DouyinTool/app.log
```

停止：

```bash
kill "$(cat ~/DouyinTool/app.pid)"
```

后台启动后，关闭终端窗口也会继续运行。但 `nohup` **不会在重启电脑后自动启动**；如果需要开机自启，可把这条启动命令做成 Automator 应用并加入“登录项”，或用 `launchd` 管理。

> 如果后台模式首次读取 Chrome Cookie 时弹出钥匙串授权窗口，点允许即可。若一直失败，建议先在前台运行一次完成授权，或改用导出的 `cookies.txt`。

---

## 8. 保存目录与命名规则

```text
~/Douyin_Saved/
├── Aalex（_UID_987654321）/
│   └── 原始视频标题.mp4
├── L老王（_UID_123456789）/
│   └── 原始视频标题.mp4
├── Y杨超越（_UID_3284940304680567）/
│   └── 原始视频标题.mp4
└── 🐶小狗（_UID_555555555）/
    └── 原始视频标题.mp4
```

作者目录规则：

| 作者昵称 | 作者 UID | 文件夹 |
| --- | --- | --- |
| `老王` | `123456789` | `L老王（_UID_123456789）` |
| `alex` | `987654321` | `Aalex（_UID_987654321）` |
| `杨超越工作室` | `3284940304680567` | `Y杨超越工作室（_UID_3284940304680567）` |
| `🐶小狗` | `555555555` | `🐶小狗（_UID_555555555）` |
| `123abc` | `666666666` | `123abc（_UID_666666666）` |

核心实现：

- 优先使用 yt-dlp 元数据里的 `uploader_id`（抖音数字 UID）。
- 如果数字 UID 不存在，则回退到 `channel_id`（抖音 `sec_uid`）。
- 每次下载前扫描 `~/Douyin_Saved`，只按 `_UID_<uid>）` 匹配目录，绝不按昵称匹配。
- 如果作者改名，自动尝试把旧目录重命名为最新的 `[前缀+昵称]（_UID_xxx）`；失败则继续使用旧目录。
- 找不到 UID 时会停止下载，避免退回使用昵称目录。
- 旧版本产生的、只有昵称没有 UID 的目录（如 `L老王`）**不会自动合并**，因为无法可靠判断 UID；程序会新建 UID 目录并保留旧目录，需手动确认迁移。
- 中文：用 `pypinyin` 取第一个汉字的拼音首字母并大写，前缀拼上完整昵称。
- 英文字母：取第一个字母大写作为前缀，再拼上完整昵称（因此 `alex` → `Aalex`）。
- Emoji、特殊符号、数字：不添加任何字母，直接使用原名。
- 仅对 `/`、`\`、`:`、控制字符等不适合作为路径的字符替换为 `_`；其他字符（包括中文和 Emoji）保留。

视频文件名：

- 所有归档模式都使用 yt-dlp 从抖音获取的标题作为文件名，不添加作者、时间、随机数或 ID 前后缀。
- 手动指定归档、UID 映射和默认下载都保持原视频文件名，不添加作者昵称或任何其他前缀。
- 抖音并没有像普通下载链接那样暴露一个传统意义上的“原始文件名”，标题就是平台提供的文件名来源。
- yt-dlp 会自动替换路径中非法的字符；文件扩展名原样保留。
- 同名文件默认不覆盖（`overwrites=False`）。

---

## 9. UID 映射与跨账号归档

映射文件位于 **`app.py` 同级目录**：

```text
authors_mapping.json
```

文件不存在时后端会自动生成空对象：

```json
{}
```

格式为 `作者 UID -> 目标文件夹名`：

```json
{
  "3284940304680567": "小号合并主文件夹",
  "555555555": "L老王（_UID_123456789）"
}
```

说明：

- UID 是视频**当前发布者**的 UID，可以用网页上的“📋 复制作者UID”获取。
- 目标文件夹位于 `~/Douyin_Saved` 下；不存在时会自动创建。
- 每次下载任务都会重新读取映射文件，修改后不需要重启 Python 服务。
- **必须是合法 JSON**：两条映射之间要有英文逗号，最后一条后面不能有逗号。
- 如果 JSON 有语法错误，下载任务会直接报错，不会再静默退回默认目录并错误创建文件夹。
- 映射值里 `（_UID_...）` 前后的多余空格会自动清理。
- 修改后建议先验证：

  ```bash
  python3 -m json.tool authors_mapping.json
  ```

  能正常输出格式化 JSON 才算有效。

下载时后端严格按以下优先级选目录：

1. **手动指定 `target_author`**：来自“📁 指定归档”弹窗，优先于映射。
2. **UID 映射表**：`authors_mapping.json` 包含当前视频作者 UID。
3. **本地 UID 扫描**：查找名称包含 `_UID_<uid>）` 的文件夹，并尝试更新为当前昵称。
4. **默认新建**：`[拼音首字母+昵称]（_UID_uid）`。

跨账号归档示例：

```text
~/Douyin_Saved/小号合并主文件夹/原视频标题.mp4
```

自己的 UID 文件夹也保持同样的原文件名：

```text
~/Douyin_Saved/Y元气弹（_UID_3284940304680567）/原视频标题.mp4
```

`GET /api/folders` 会过滤隐藏目录（以 `.` 开头）和符号链接。

---

## 10. 结构与安全说明

- Flask 只绑定 `127.0.0.1`，局域网中的其他设备访问不到。
- CORS 只允许 `douyin.com` 子域和本机来源；并额外处理了 Chrome 的 Private Network Access 预检。
- 下载队列只有一个后台 worker，避免多个触发源同时下载产生冲突。
- 链接只接受 `douyin.com` 域名，避免把本地服务变成任意 URL 下载器。
- 剪贴板内容和 Cookie 不会上传到任何地方。
- 请仅下载你有权保存的视频，遵守平台条款和版权要求。

---

## 11. 常见问题

### `Fresh cookies (not necessarily logged in) are needed`

先确认启动日志包含：

```text
已启用 Douyin x-secsdk-web-signature 兼容补丁
```

如果没有，说明当前运行的还是旧版 `app.py`，先重启服务。

如果补丁已启用仍失败，通常是 Cookie 缺失、过期，或浏览器数据库无法读取。

**Chrome 有多个用户 Profile 时，只写 `chrome` 会默认读 `Default`，可能读不到你正在用的 Profile。** 例如当前实际使用的是 `Profile 1`：

```bash
python app.py --cookies-from-browser "chrome:Profile 1"
```

注意 `chrome:Profile 1` 中间有空格，必须加引号。Profile 名称可以在 Chrome 地址栏打开 `chrome://version` 查看“配置文件路径”，或运行：

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/Library/Application Support/Google/Chrome/Local State')
d = json.load(open(p))
print('last_used:', d.get('profile', {}).get('last_used'))
for key, value in d.get('profile', {}).get('info_cache', {}).items():
    print(key, '|', value.get('name'))
PY
```

其他排查：

1. 先退出浏览器，再运行带 Profile 的命令。
2. 允许 macOS 钥匙串访问。
3. 给终端完全磁盘访问权限（Safari 尤其需要）。
4. 更新 yt-dlp：
   ```bash
   source .venv/bin/activate
   python -m pip install -U yt-dlp
   ```

### `Requested format is not available`

通常说明抖音的可下载格式发生了变化，或者只返回了水印格式。先更新 yt-dlp；程序不会为了“能下载”而退回到带水印格式。

### `Address already in use` / 端口被占用

本项目默认使用 5001。先查看是谁占用：

```bash
lsof -nP -iTCP:5001 -sTCP:LISTEN
```

如果 5001 确实被其他程序占用，换一个端口启动：

```bash
python app.py --port 5002 --cookies-from-browser chrome
```

同时把油猴脚本里的 `API_BASE` 改成 `http://127.0.0.1:5002`。

> 5000 在 macOS 上通常被 ControlCenter 的“隔空播放接收器”占用，所以不要直接把项目改回 5000，除非先关闭该系统功能。

### 油猴按钮无法连接本地服务

1. 确认 `http://127.0.0.1:5001/api/health` 能打开。
2. 确认 Tampermonkey 脚本已启用，并允许访问 `127.0.0.1`。
3. Chrome 若出现本地网络权限提示，选择允许。
4. 检查端口是否与脚本中的 `API_BASE` 一致。

### 需要 ffmpeg 吗？

本工具优先选择抖音已经合并好的 MP4 格式，通常不需要 ffmpeg。如果 yt-dlp 提示需要合并音视频或处理 HLS，可安装：

```bash
brew install ffmpeg
```

### 更新工具

抖音解析依赖 yt-dlp，建议定期：

```bash
cd ~/DouyinTool
source .venv/bin/activate
python -m pip install -U -r requirements.txt
```

---

## 12. 本地测试：复制 UID 与前缀搜索

先确保服务在前台运行：

```bash
cd ~/DouyinTool
source .venv/bin/activate
python app.py --cookies-from-browser "chrome:Profile 1"
```

### 测试复制作者 UID

1. 在 Chrome 打开一个抖音视频，例如：

   ```text
   https://www.douyin.com/video/7700164284748523441
   ```

2. 点击页面右侧的 **📋 复制作者UID**。
3. 应该弹出：

   ```text
   ✅ 已复制 UID：3284940304680567，请前往 JSON 文件进行映射
   ```

4. 在终端验证剪贴板：

   ```bash
   pbpaste
   ```

   应输出：

   ```text
   3284940304680567
   ```

5. 也可以不经过油猴，直接测试后端元数据接口：

   ```bash
   curl --get http://127.0.0.1:5001/api/author_info \
     --data-urlencode 'url=https://www.douyin.com/video/7700164284748523441'
   ```

   应返回 `uid` 和 `author_nickname`，且不会产生视频文件。

> 如果页面没有焦点，浏览器可能拒绝普通 `navigator.clipboard` 写入；弹窗会改为显示 UID 让你手动复制。

### 测试前缀搜索和模糊搜索

1. 先创建几个测试目录：

   ```bash
   mkdir -p \
     "$HOME/Douyin_Saved/L老王（_UID_111111111）" \
     "$HOME/Douyin_Saved/D大老王子（_UID_222222222）" \
     "$HOME/Douyin_Saved/Aalex（_UID_333333333）" \
     "$HOME/Douyin_Saved/.hidden_folder"
   ```

2. 检查接口已过滤隐藏目录：

   ```bash
   curl http://127.0.0.1:5001/api/folders
   ```

   `folders` 中应有前三个，不应有 `.hidden_folder`。

3. 在抖音页面点击 **📁 指定归档**，弹窗会显示全部文件夹。

4. 输入 `L`：

   - 只显示以 `L` 开头的文件夹，例如 `L老王（_UID_111111111）`。
   - 提示应为“前缀匹配”。

5. 输入 `老王`：

   - 没有任何文件夹以“老王”开头，因此回退到模糊包含匹配。
   - 应同时显示 `L老王（_UID_111111111）` 和 `D大老王子（_UID_222222222）`。
   - 提示应为“前缀无结果，模糊匹配”。

6. 点选 `D大老王子（_UID_222222222）`，再点“归档下载”：

   - 视频会保存到该文件夹；
   - 文件名保持原视频标题，不加 `[元气弹]` 之类的前缀。

7. 也可以直接测后端匹配：

   ```bash
   curl -X POST http://127.0.0.1:5001/api/download \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://www.douyin.com/video/7700164284748523441","target_author":"D"}'
   ```

   后端会把前缀 `D` 解析成实际文件夹，再入队。

### 测试 authors_mapping.json

1. 打开 `app.py` 同级的 `authors_mapping.json`，写入：

   ```json
   {
     "3284940304680567": "小号合并主文件夹"
   }
   ```

2. 验证 JSON 语法：

   ```bash
   python3 -m json.tool authors_mapping.json
   ```

3. 不需要重启服务。

4. 在抖音页面点普通 **⬇ 一键下载**。

5. 文件应保存为：

   ```text
   ~/Douyin_Saved/小号合并主文件夹/原视频标题.mp4
   ```

6. 测完后把 JSON 恢复为：

   ```json
   {}
   ```

### 清理测试目录

```bash
rmdir "$HOME/Douyin_Saved/L老王（_UID_111111111）" \
      "$HOME/Douyin_Saved/D大老王子（_UID_222222222）" \
      "$HOME/Douyin_Saved/Aalex（_UID_333333333）" \
      "$HOME/Douyin_Saved/.hidden_folder" 2>/dev/null || true
```
