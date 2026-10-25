#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抖音无水印视频下载器（macOS）

- 剪贴板监听：发现 v.douyin.com 分享链接后自动下载
- 本地 HTTP API：POST /api/download，供 Tampermonkey 脚本调用
- 保存目录：~/Douyin_Saved（不会保存到桌面）
- 作者文件夹：[首字母 + 昵称]（_UID_作者ID）；按 UID 去重，作者改名时自动重命名

依赖：
    pip install -U yt-dlp flask pypinyin pyperclip requests
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import html
import json
import logging
import os
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import unicodedata
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import parse_qs, urlencode, urlparse

import requests
from flask import Flask, jsonify, request
from pypinyin import Style, pinyin
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError, ExtractorError, traverse_obj

try:
    import pyperclip
except ImportError:  # pragma: no cover - macOS 上会回退到 pbpaste
    pyperclip = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# 常量与日志
# ---------------------------------------------------------------------------

HOME = Path.home()
BASE_DIR = HOME / "Douyin_Saved"
APP_DIR = Path(__file__).resolve().parent
AUTHORS_MAPPING_FILE = APP_DIR / "authors_mapping.json"
MAPPING_TEMPLATE: dict[str, str] = {}
RECENT_LINK_LIMIT = 10
MAX_JOB_HISTORY = 300
MAX_VIDEO_ID_HISTORY = 100
DEFAULT_PORT = 5001

COOKIE_HINT = (
    "抖音现在通常需要浏览器 Cookie 才能解析。请用 "
    "`python3 app.py --cookies-from-browser chrome`（或 safari / edge / firefox）"
    "重启服务，或通过 --cookies 指定 Netscape 格式的 cookies.txt。"
)

logger = logging.getLogger("douyin-downloader")


def _install_douyin_signature_patch() -> None:
    """
    兼容抖音 2026 年新增的 x-secsdk-web-signature 校验。

    yt-dlp 稳定版（截至 2026.10.21）仍可能返回：
        Failed to download web detail JSON: HTTP Error 403: Forbidden
        Fresh cookies (not necessarily logged in) are needed

    这里在运行时给 DouyinIE 打补丁，加入 uifid + timestamp + MD5 签名和 Referer。
    思路来自 yt-dlp PR #17826（Unlicense）；yt-dlp 官方合并后可自动跳过。
    """
    try:
        from yt_dlp.extractor.tiktok import DouyinIE
    except Exception:
        logger.exception("无法加载 yt-dlp DouyinIE，签名补丁未启用")
        return

    if getattr(DouyinIE, "_DY_SECSDK_PATCHED", False):
        return
    if hasattr(DouyinIE, "_SEC_SALT") and hasattr(
        DouyinIE, "check_and_get_required_cookies"
    ):
        # 新版 yt-dlp 已内置同类修复。
        DouyinIE._DY_SECSDK_PATCHED = True  # type: ignore[attr-defined]
        logger.info("yt-dlp 已内置 Douyin 签名修复，跳过兼容补丁")
        return

    DouyinIE._SEC_SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"  # type: ignore[attr-defined]
    DouyinIE._REQUIRED_COOKIES = [  # type: ignore[attr-defined]
        "passport_csrf_token",
        "ttwid",
    ]
    DouyinIE._AID = 6383  # type: ignore[attr-defined]
    DouyinIE._CSRF = uuid.uuid4().hex  # type: ignore[attr-defined]

    def _get_ttwid(self):
        self._request_webpage(
            f"{self._WEBPAGE_HOST}ttwid/register",
            None,
            data=json.dumps(
                {"aid": self._AID, "service": "www.douyin.com"}
            ).encode(),
            headers={"content-type": "application/json"},
        )
        cookie = self._get_cookies(self._WEBPAGE_HOST).get("ttwid")
        return cookie.value if cookie else None

    def check_and_get_required_cookies(self):
        for cookie_name in self._REQUIRED_COOKIES:
            if self._get_cookies(self._WEBPAGE_HOST).get(cookie_name):
                continue
            if cookie_name == "ttwid":
                cookie_value = _get_ttwid(self)
            else:
                cookie_value = self._CSRF
            if not cookie_value:
                raise ExtractorError("Unable to generate required Douyin cookies")
            self._set_cookie(".douyin.com", cookie_name, cookie_value)

    def _get_uifid(self):
        cookie_names = (
            "uifid",
            "uifid_temp",
            "uifidtemp",
            "UIFID",
            "UIFID_TEMP",
            "UIFIDTEMP",
        )
        uifid = traverse_obj(
            self._get_cookies(self._WEBPAGE_HOST),
            (cookie_names, "value"),
            get_all=False,
        )
        if not uifid:
            response = self._request_webpage(self._WEBPAGE_HOST, None)
            return response.headers.get("x-tt-trace-host")
        return uifid

    def _sign_query(self, query):
        uifid = _get_uifid(self)
        timestamp = str(int(time.time()))
        query = {**query, "uifid": uifid, "timestamp": timestamp}
        encoded_query = urlencode(query)
        signature = hashlib.md5(
            f"{uifid}_{timestamp}_{self._SEC_SALT}_{encoded_query}".encode()
        ).hexdigest()
        return {**query, "x-secsdk-web-signature": signature}

    def _real_extract(self, url):
        video_id = self._match_id(url)
        check_and_get_required_cookies(self)
        detail = traverse_obj(
            self._download_json(
                "https://www.douyin.com/aweme/v1/web/aweme/detail/",
                video_id,
                "Downloading web detail JSON",
                "Failed to download web detail JSON",
                query=_sign_query(self, {"aweme_id": video_id, "aid": self._AID}),
                fatal=False,
            ),
            ("aweme_detail", {dict}),
        )
        if not detail:
            raise ExtractorError(
                "Fresh cookies (not necessarily logged in) are needed",
                expected=not self._get_cookies(self._WEBPAGE_HOST).get("s_v_web_id"),
            )
        return {
            **self._parse_aweme_video_app(detail),
            "http_headers": {"Referer": self._WEBPAGE_HOST},
        }

    DouyinIE._get_ttwid = _get_ttwid  # type: ignore[attr-defined]
    DouyinIE.check_and_get_required_cookies = check_and_get_required_cookies  # type: ignore[attr-defined]
    DouyinIE._get_uifid = _get_uifid  # type: ignore[attr-defined]
    DouyinIE._sign_query = _sign_query  # type: ignore[attr-defined]
    DouyinIE._real_extract = _real_extract  # type: ignore[attr-defined]
    DouyinIE._DY_SECSDK_PATCHED = True  # type: ignore[attr-defined]
    logger.info("已启用 Douyin x-secsdk-web-signature 兼容补丁")


# ---------------------------------------------------------------------------
# 链接解析与校验
# ---------------------------------------------------------------------------


class InvalidDouyinLink(ValueError):
    """不是可识别的抖音视频链接。"""


class VideoResolveError(RuntimeError):
    """短链接无法解析成视频页面。"""


# 只匹配 ASCII URL 字符，避免把链接后面的中文标点/说明文字一起吞掉。
_SHARE_URL_RE = re.compile(
    r"(?<![A-Za-z0-9.-])(?:https?://)?(?:[A-Za-z0-9-]+\.)*douyin\.com/"
    r"[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+",
    re.IGNORECASE,
)
_VIDEO_ID_RE = re.compile(r"^\d{8,25}$")
_VIDEO_PATH_RE = re.compile(r"/(?:share/)?video/(\d{8,25})(?:/|$)", re.IGNORECASE)
_TRAILING_URL_CHARS = ".,;:!?)]}>，。；：！？、）】》\"'”’"
_SHORT_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{3,80}$")


def _clean_url_candidate(raw: str) -> str:
    value = html.unescape(raw).strip().strip("<>\"'")
    value = value.rstrip(_TRAILING_URL_CHARS)
    if not re.match(r"^https?://", value, re.IGNORECASE):
        value = "https://" + value
    return value


def _douyin_host(host: Optional[str]) -> bool:
    if not host:
        return False
    host = host.lower().rstrip(".")
    return host == "douyin.com" or host.endswith(".douyin.com")


def _extract_video_id_from_url(url: str) -> Optional[str]:
    parsed = urlparse(url)
    match = _VIDEO_PATH_RE.search(parsed.path)
    if match:
        return match.group(1)

    query = parse_qs(parsed.query, keep_blank_values=True)
    fragment = parse_qs(parsed.fragment.lstrip("?"), keep_blank_values=True)
    for key in ("modal_id", "aweme_id", "item_id", "video_id"):
        for source in (query, fragment):
            values = source.get(key) or []
            for value in values:
                if _VIDEO_ID_RE.fullmatch(value):
                    return value

    # 少数分享页会把 /video/<id> 放在 fragment 里。
    match = _VIDEO_PATH_RE.search(parsed.fragment)
    if match:
        return match.group(1)
    return None


def canonicalize_douyin_url(raw: str) -> str:
    """把一个抖音链接标准化；短链保持短链，视频页统一成 /video/<id>。"""
    if not isinstance(raw, str):
        raise InvalidDouyinLink("链接必须是字符串。")

    value = _clean_url_candidate(raw)
    if len(value) > 4096:
        raise InvalidDouyinLink("链接过长。")

    try:
        parsed = urlparse(value)
    except ValueError as exc:
        raise InvalidDouyinLink("链接格式不正确。") from exc

    if parsed.scheme.lower() not in ("http", "https"):
        raise InvalidDouyinLink("只支持 http/https 链接。")
    if parsed.username or parsed.password:
        raise InvalidDouyinLink("链接中不能包含用户名或密码。")
    if not _douyin_host(parsed.hostname):
        raise InvalidDouyinLink("只接受 douyin.com 域名下的链接。")

    try:
        port = parsed.port
    except ValueError as exc:
        raise InvalidDouyinLink("链接端口不正确。") from exc
    if port not in (None, 80, 443):
        raise InvalidDouyinLink("链接端口不受支持。")

    video_id = _extract_video_id_from_url(value)
    if video_id:
        return f"https://www.douyin.com/video/{video_id}"

    host = (parsed.hostname or "").lower().rstrip(".")
    if host == "v.douyin.com":
        code = parsed.path.strip("/")
        if _SHORT_CODE_RE.fullmatch(code):
            return f"https://v.douyin.com/{code}/"

    if "/note/" in parsed.path:
        raise InvalidDouyinLink("这是抖音图文/笔记链接，当前工具只支持视频。")
    raise InvalidDouyinLink(
        "没有识别到视频 ID。请使用 v.douyin.com 分享链接或 "
        "www.douyin.com/video/<数字ID> 链接。"
    )


def extract_douyin_url(text: str) -> Optional[str]:
    """从剪贴板分享文案中提取并标准化第一个有效抖音链接。"""
    if not isinstance(text, str) or not text:
        return None
    for match in _SHARE_URL_RE.finditer(html.unescape(text)):
        try:
            return canonicalize_douyin_url(match.group(0))
        except InvalidDouyinLink:
            continue
    return None


def resolve_video_url(url: str, timeout: float = 20.0) -> str:
    """把 v.douyin.com 短链解析成 www.douyin.com/video/<id>。"""
    canonical = canonicalize_douyin_url(url)
    if _extract_video_id_from_url(canonical):
        return canonical

    parsed = urlparse(canonical)
    if (parsed.hostname or "").lower().rstrip(".") != "v.douyin.com":
        raise VideoResolveError("不是可解析的抖音短链接。")

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        response = requests.get(
            canonical,
            headers=headers,
            allow_redirects=True,
            timeout=(5, timeout),
        )
    except requests.RequestException as exc:
        raise VideoResolveError(f"短链接请求失败：{exc}") from exc

    final_url = response.url or ""
    video_id = _extract_video_id_from_url(final_url)
    if video_id:
        return f"https://www.douyin.com/video/{video_id}"

    # 有些短链会跳到 iesdouyin.com 的分享页；只提取其中的数字 AWEME ID。
    final_match = _VIDEO_PATH_RE.search(final_url)
    if final_match:
        return f"https://www.douyin.com/video/{final_match.group(1)}"

    body = (response.text or "")[:2_000_000]
    for pattern in (
        r'"aweme_id"\s*:\s*"(\d{8,25})"',
        r'\\"aweme_id\\"\s*:\s*\\"(\d{8,25})\\"',
        r"(?:modal_id|aweme_id)=(\d{8,25})",
    ):
        match = re.search(pattern, body)
        if match:
            return f"https://www.douyin.com/video/{match.group(1)}"

    raise VideoResolveError(
        "短链接解析失败。请检查网络，或直接使用 "
        "www.douyin.com/video/<数字ID> 形式的链接。"
    )


# ---------------------------------------------------------------------------
# 作者目录命名（核心规则）
# ---------------------------------------------------------------------------


_CHINESE_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
)
_UNSAFE_PATH_CHARS = re.compile(r"[/\\:\x00-\x1f\x7f]")
_ASCII_LETTER = re.compile(r"^[A-Za-z]$")
# 抖音数字 UID 或 sec_uid（MS4wLjABAAAA...）都只包含这些字符。
_AUTHOR_UID_RE = re.compile(r"^[A-Za-z0-9_-]{5,200}$")


def _is_chinese_char(char: str) -> bool:
    code = ord(char)
    return any(start <= code <= end for start, end in _CHINESE_RANGES)


def _pinyin_initial(char: str) -> str:
    """返回一个中文字符的拼音首字母（大写）。无法转换时返回空字符串。"""
    try:
        result = pinyin(char, style=Style.FIRST_LETTER, strict=False, errors="ignore")
    except Exception:
        logger.warning("pypinyin 无法处理字符 %r，将直接使用原名", char)
        return ""
    if result and result[0]:
        initial = str(result[0][0])
        if _ASCII_LETTER.fullmatch(initial):
            return initial.upper()
    return ""


def make_author_folder_name(nickname: str) -> str:
    """
    规则：
      - 中文：拼音首字母大写 + 原名，如 老王 -> L老王
      - 英文字母：首字母大写 + 原名，如 alex -> Aalex
      - Emoji / 特殊符号 / 数字：直接使用原名，如 🐶小狗 -> 🐶小狗
    仅替换 macOS 路径中不允许或会带来麻烦的字符。
    """
    name = unicodedata.normalize("NFC", str(nickname or "")).strip()
    name = _UNSAFE_PATH_CHARS.sub("_", name).strip()
    if not name or name in (".", ".."):
        name = "未知作者"

    first = name[0]
    if _is_chinese_char(first):
        initial = _pinyin_initial(first)
        return f"{initial}{name}" if initial else name
    if _ASCII_LETTER.fullmatch(first):
        return f"{first.upper()}{name}"
    return name


def extract_author_nickname(info: dict[str, Any]) -> str:
    """
    抖音 extractor 中 channel 才是作者昵称，uploader 通常是抖音号。
    依次尝试多个字段，以兼容 yt-dlp 版本变化。
    """
    for key in ("channel", "creator", "nickname", "author_name"):
        value = info.get(key)
        if isinstance(value, str):
            value = value.strip()
            if value and value.lower() not in {"na", "none", "null", "-"}:
                return value

    author = info.get("author")
    if isinstance(author, dict):
        for key in ("nickname", "name", "unique_id"):
            value = author.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    elif isinstance(author, str) and author.strip():
        return author.strip()

    for key in ("uploader", "uploader_id"):
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    return "未知作者"


def extract_author_uid(info: dict[str, Any]) -> tuple[str, str]:
    """
    从 yt-dlp 元数据里提取稳定的作者身份 ID。

    抖音 extractor 当前映射：
      - channel     -> 作者昵称
      - uploader_id -> 数字 UID（如 3284940304680567，优先使用）
      - channel_id  -> sec_uid（如 MS4wLjABAAAA...，UID 缺失时使用）

    返回 (uid, 字段来源)；找不到时返回 ("", "")。
    """
    author = info.get("author") if isinstance(info.get("author"), dict) else {}
    candidate_fields = (
        ("uploader_id", info.get("uploader_id")),
        ("author.uid", author.get("uid")),
        ("uid", info.get("uid")),
        ("creator_id", info.get("creator_id")),
        ("channel_id", info.get("channel_id")),
        ("author.sec_uid", author.get("sec_uid")),
        ("sec_uid", info.get("sec_uid")),
    )
    for source, value in candidate_fields:
        if isinstance(value, bool) or value is None:
            continue
        text = str(value).strip()
        if text and _AUTHOR_UID_RE.fullmatch(text):
            return text, source
    return "", ""


def build_author_folder_name(nickname: str, uid: str) -> str:
    """
    最终目录名：[拼音首字母大写+昵称]（_UID_作者ID）

    例：L老王（_UID_3284940304680567）
        Aalex（_UID_987654321）
    """
    uid = str(uid or "").strip()
    if not _AUTHOR_UID_RE.fullmatch(uid):
        raise ValueError(f"作者 UID 含有不支持的字符：{uid!r}")
    return f"{make_author_folder_name(nickname)}（_UID_{uid}）"


def find_author_folders(base_dir: Path, uid: str) -> list[Path]:
    """
    扫描基础目录，按 UID 精确查找作者目录。

    不按昵称匹配，避免作者改名后产生两个目录。
    匹配的是完整标记 "_UID_<uid>）"，因此 UID 123 不会误匹配 UID 1234。
    """
    marker = f"_UID_{uid}）"
    try:
        entries = list(base_dir.iterdir())
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise DownloadError(f"无法扫描保存目录 {base_dir}：{exc}") from exc

    matches = [
        entry
        for entry in entries
        if entry.is_dir() and not entry.is_symlink() and marker in entry.name
    ]
    return sorted(matches, key=lambda item: item.name)


def safe_folder_component(value: str) -> str:
    """把映射表里的目标文件夹名限制为单层、安全的目录名。"""
    name = unicodedata.normalize("NFC", str(value or "")).strip()
    if not name or name in (".", "..") or name.startswith("."):
        return ""
    if "/" in name or "\\" in name or any(ord(char) < 32 for char in name):
        return ""
    if Path(name).name != name:
        return ""
    return name


def normalize_mapping_folder_name(value: str) -> str:
    """容错处理手写映射里多余的空格，例如 "X娴娴子 （_UID_x） "。"""
    name = unicodedata.normalize("NFC", str(value or "")).strip()
    name = re.sub(r"\s*（\s*", "（", name)
    name = re.sub(r"\s*）\s*", "）", name)
    name = re.sub(r"\s*_UID_\s*", "_UID_", name)
    return name.strip()


def match_folder_name(folders: list[str], query: str) -> Optional[str]:
    """
    后端的目标文件夹匹配：
      1. 完全匹配；
      2. 忽略大小写的完全匹配；
      3. 忽略大小写的前缀匹配；
      4. 以上都没有时，忽略大小写的包含匹配。
    """
    query = str(query or "").strip()
    if not query:
        return None
    if query in folders:
        return query

    lowered = query.casefold()
    casefolded = {folder.casefold(): folder for folder in folders}

    exact = casefolded.get(lowered)
    if exact:
        return exact

    prefix_matches = [
        folder for folder in folders if folder.casefold().startswith(lowered)
    ]
    if prefix_matches:
        return min(prefix_matches, key=lambda folder: (len(folder), folder.casefold()))

    contains_matches = [folder for folder in folders if lowered in folder.casefold()]
    if contains_matches:
        return min(
            contains_matches,
            key=lambda folder: (folder.casefold().find(lowered), len(folder)),
        )
    return None


def ensure_authors_mapping_file(path: Path = AUTHORS_MAPPING_FILE) -> None:
    """authors_mapping.json 不存在时自动生成 {}。"""
    mapping_path = Path(path)
    if mapping_path.exists():
        return
    try:
        mapping_path.parent.mkdir(parents=True, exist_ok=True)
        mapping_path.write_text(
            json.dumps(MAPPING_TEMPLATE, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        logger.info("已创建映射文件：%s", mapping_path)
    except OSError as exc:
        logger.warning("无法创建映射文件 %s：%s", mapping_path, exc)


def load_authors_mapping(
    path: Path = AUTHORS_MAPPING_FILE,
    *,
    strict: bool = False,
) -> dict[str, str]:
    """
    读取 {UID: 目标文件夹} 映射。兼容两种结构：

        {"小号UID": "L老王（_UID_大号UID）"}
        {"mappings": {"小号UID": "L老王（_UID_大号UID）"}}

    每次下载任务都会重新读取，修改 JSON 后无需重启。
    """
    mapping_path = Path(path)
    ensure_authors_mapping_file(mapping_path)
    try:
        raw = json.loads(mapping_path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        message = f"无法读取映射文件 {mapping_path}：{exc}。请修正 JSON，或删除文件让程序重新生成 {{}}。"
        if strict:
            raise DownloadError(message) from exc
        logger.warning("%s 本次按空映射处理。", message)
        return {}

    if not isinstance(raw, dict):
        message = f"映射文件 {mapping_path} 的顶层必须是 JSON 对象。"
        if strict:
            raise DownloadError(message)
        logger.warning("%s 已忽略。", message)
        return {}

    source = raw.get("mappings") if isinstance(raw.get("mappings"), dict) else raw
    result: dict[str, str] = {}
    for uid, value in source.items():
        uid_text = str(uid).strip()
        if not _AUTHOR_UID_RE.fullmatch(uid_text):
            continue
        target = value
        if isinstance(value, dict):
            target = value.get("folder") or value.get("target")
        if not isinstance(target, str):
            logger.warning("映射 %s 的值不是文件夹名字符串，已忽略。", uid_text)
            continue
        target_name = safe_folder_component(normalize_mapping_folder_name(target))
        if not target_name:
            logger.warning("映射 %s 的目标文件夹 %r 不安全，已忽略。", uid_text, target)
            continue
        result[uid_text] = target_name
    return result


# ---------------------------------------------------------------------------
# 下载器
# ---------------------------------------------------------------------------


BrowserSpec = tuple[str, Optional[str], Optional[str], Optional[str]]


@dataclass(frozen=True)
class DownloaderSettings:
    cookies_file: Optional[str] = None
    cookies_from_browser: Optional[BrowserSpec] = None
    verbose: bool = False


@dataclass(frozen=True)
class VideoMeta:
    video_id: str
    title: str
    author: str
    author_uid: str
    webpage_url: str


@dataclass(frozen=True)
class DownloadDestination:
    folder: Path
    reason: str  # manual / mapping / uid / new


class _YtdlpLogger:
    """把 yt-dlp 的日志接入 logging，并收集错误文本。"""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def debug(self, msg: str) -> None:
        if str(msg).startswith("[debug] "):
            return
        logger.debug("yt-dlp: %s", msg)

    def info(self, msg: str) -> None:
        logger.debug("yt-dlp: %s", msg)

    def warning(self, msg: str) -> None:
        logger.warning("yt-dlp: %s", msg)

    def error(self, msg: str) -> None:
        self.errors.append(str(msg))
        logger.error("yt-dlp: %s", msg)


class DouyinDownloader:
    def __init__(
        self,
        settings: DownloaderSettings,
        base_dir: Path = BASE_DIR,
        mapping_file: Path = AUTHORS_MAPPING_FILE,
    ) -> None:
        _install_douyin_signature_patch()
        self.settings = settings
        self.base_dir = Path(base_dir).expanduser()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.mapping_file = Path(mapping_file)
        ensure_authors_mapping_file(self.mapping_file)

    def list_folders(self) -> list[str]:
        """返回 ~/Douyin_Saved 下的一级文件夹名，过滤隐藏目录和符号链接。"""
        try:
            self.base_dir.mkdir(parents=True, exist_ok=True)
            entries = list(self.base_dir.iterdir())
        except OSError as exc:
            raise DownloadError(f"无法读取保存目录 {self.base_dir}：{exc}") from exc
        folders = [
            entry.name
            for entry in entries
            if entry.is_dir()
            and not entry.is_symlink()
            and not entry.name.startswith(".")
        ]
        return sorted(folders, key=lambda item: (item.casefold(), item))

    def resolve_target_folder(self, query: str) -> Optional[str]:
        return match_folder_name(self.list_folders(), query)

    def mapping_for_uid(self, uid: str, *, strict: bool = False) -> Optional[str]:
        return load_authors_mapping(self.mapping_file, strict=strict).get(str(uid))

    def _ensure_mapping_folder(self, target_name: str) -> Path:
        safe_name = safe_folder_component(normalize_mapping_folder_name(target_name))
        if not safe_name:
            raise DownloadError(f"映射目标文件夹名不安全：{target_name!r}")
        folders = self.list_folders()
        actual_name = next(
            (name for name in folders if name.casefold() == safe_name.casefold()),
            safe_name,
        )
        folder = self.base_dir / actual_name
        if folder.exists():
            if folder.is_symlink() or not folder.is_dir():
                raise DownloadError(f"映射目标不是普通文件夹：{folder}")
            return folder
        try:
            folder.mkdir(parents=False, exist_ok=False)
        except OSError as exc:
            raise DownloadError(f"无法创建映射目标文件夹 {folder}：{exc}") from exc
        logger.info("已创建映射目标文件夹：%s", folder.name)
        return folder

    def resolve_destination(
        self,
        meta: VideoMeta,
        target_folder: Optional[str] = None,
    ) -> DownloadDestination:
        """
        严格按照以下优先级决定目标目录：

        1. 手动指定 target_author；
        2. authors_mapping.json 中的 UID 映射；
        3. 本地已有包含该 UID 的目录；
        4. 按默认规则新建目录。
        """
        # 优先级 1：手动指定。target_author 实际是已选中的文件夹名。
        if target_folder:
            resolved_name = match_folder_name(self.list_folders(), target_folder)
            if not resolved_name:
                raise DownloadError(f"手动指定的目标文件夹不存在：{target_folder}")
            folder = self.base_dir / resolved_name
            if folder.is_symlink() or not folder.is_dir():
                raise DownloadError(f"手动指定的目标不是普通文件夹：{folder}")
            logger.info("目标目录：手动指定 -> %s", folder.name)
            return DownloadDestination(folder, reason="manual")

        # 优先级 2：UID 映射。
        mapped_name = self.mapping_for_uid(meta.author_uid, strict=True)
        if mapped_name:
            folder = self._ensure_mapping_folder(mapped_name)
            logger.info(
                "目标目录：UID %s 映射 -> %s", meta.author_uid, folder.name
            )
            return DownloadDestination(folder, reason="mapping")

        # 优先级 3/4：本地 UID 匹配，或默认新建。
        existing = find_author_folders(self.base_dir, meta.author_uid)
        folder = self._resolve_author_folder(meta.author, meta.author_uid)
        reason = "uid" if existing else "new"
        logger.info("目标目录：%s -> %s", reason, folder.name)
        return DownloadDestination(folder, reason=reason)

    def _common_options(self, ydl_logger: _YtdlpLogger) -> dict[str, Any]:
        options: dict[str, Any] = {
            "quiet": True,
            "no_warnings": False,
            "noprogress": True,
            "noplaylist": True,
            "socket_timeout": 30,
            "retries": 5,
            "fragment_retries": 5,
            "extractor_retries": 2,
            "ignoreerrors": False,
            "no_color": True,
            "consoletitle": False,
            "logger": ydl_logger,
        }
        if self.settings.verbose:
            options["verbose"] = True
        if self.settings.cookies_file:
            options["cookiefile"] = str(Path(self.settings.cookies_file).expanduser())
        if self.settings.cookies_from_browser:
            options["cookiesfrombrowser"] = self.settings.cookies_from_browser
        return options

    def fetch_metadata(self, url: str) -> VideoMeta:
        ydl_logger = _YtdlpLogger()
        options = self._common_options(ydl_logger)
        options.update(
            {
                "skip_download": True,
                "extract_flat": False,
            }
        )

        try:
            with YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=False)
        except DownloadError as exc:
            detail = self._last_ytdlp_error(ydl_logger, exc)
            raise DownloadError(detail) from exc

        if not isinstance(info, dict):
            raise DownloadError("yt-dlp 没有返回视频信息。")

        if info.get("_type") in ("playlist", "multi_video") and info.get("entries"):
            entries = info.get("entries")
            try:
                info = next(iter(entries))
            except StopIteration as exc:
                raise DownloadError("链接中没有可下载的视频。") from exc
        if not isinstance(info, dict):
            raise DownloadError("yt-dlp 返回的视频信息格式异常。")

        video_id = str(info.get("id") or "").strip()
        if not video_id:
            video_id = _extract_video_id_from_url(url) or uuid.uuid4().hex[:12]

        title = str(info.get("title") or "").strip()
        if not title:
            title = f"douyin_{video_id}"

        author = extract_author_nickname(info)
        author_uid, uid_source = extract_author_uid(info)
        if not author_uid:
            raise DownloadError(
                "未能从 yt-dlp 元数据中提取作者 UID/sec_uid，"
                "已停止下载以避免按昵称创建重复目录。"
                "请更新 yt-dlp，或检查该视频是否仍可访问。"
            )
        logger.info(
            "解析成功：作者=%s，UID=%s（来源：%s），视频 ID=%s，标题=%s",
            author,
            author_uid,
            uid_source,
            video_id,
            title,
        )
        return VideoMeta(
            video_id=video_id,
            title=title,
            author=author,
            author_uid=author_uid,
            webpage_url=url,
        )

    def folder_for(self, meta: VideoMeta) -> Path:
        return self._resolve_author_folder(meta.author, meta.author_uid)

    def _resolve_author_folder(self, nickname: str, uid: str) -> Path:
        """
        以 UID 查找作者目录；存在则复用，昵称变化时尝试重命名。
        不存在才创建新的 "[前缀+昵称]（_UID_xxx）" 目录。
        """
        desired_name = build_author_folder_name(nickname, uid)
        desired_path = self.base_dir / desired_name
        matches = find_author_folders(self.base_dir, uid)

        if matches:
            if len(matches) > 1:
                logger.warning(
                    "UID %s 对应多个目录，将使用排序后的第一个；"
                    "其余目录未自动合并：%s",
                    uid,
                    ", ".join(item.name for item in matches),
                )

            exact = next((item for item in matches if item.name == desired_name), None)
            if exact:
                return exact

            current = matches[0]
            if desired_path.exists():
                if desired_path.is_dir():
                    logger.info("同一 UID 的最新昵称目录已存在：%s", desired_path.name)
                    return desired_path
                logger.warning(
                    "目标路径已存在且不是目录，继续使用原目录：%s", desired_path
                )
                return current

            try:
                os.rename(current, desired_path)
            except OSError as exc:
                if desired_path.is_dir():
                    return desired_path
                logger.warning(
                    "作者目录重命名失败，继续使用旧目录 %s：%s",
                    current.name,
                    exc,
                )
                return current

            logger.info(
                "作者昵称已变化，目录已更新：%s -> %s",
                current.name,
                desired_path.name,
            )
            return desired_path

        # 旧版目录只有昵称，没有 UID，不能安全判断是否同一作者，不能自动合并。
        legacy_path = self.base_dir / make_author_folder_name(nickname)
        if legacy_path.is_dir() and not legacy_path.is_symlink():
            logger.warning(
                "发现旧版无 UID 目录 %s；为避免把不同作者误合并，"
                "本次会新建 UID 目录，旧目录请手动确认后迁移。",
                legacy_path.name,
            )

        try:
            desired_path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise DownloadError(f"无法创建作者目录 {desired_path}：{exc}") from exc
        logger.info("新建作者目录：%s", desired_path.name)
        return desired_path

    def download(
        self,
        meta: VideoMeta,
        destination: Optional[DownloadDestination] = None,
    ) -> Path:
        if destination is None:
            destination = DownloadDestination(
                folder=self.folder_for(meta),
                reason="uid",
            )
        folder = destination.folder
        folder.mkdir(parents=True, exist_ok=True)

        ydl_logger = _YtdlpLogger()
        options = self._common_options(ydl_logger)
        finished_paths: list[Path] = []
        started_at = time.time()

        def progress_hook(data: dict[str, Any]) -> None:
            if data.get("status") != "finished":
                return
            filename = data.get("filename")
            if filename:
                candidate = Path(filename)
                if not candidate.is_absolute():
                    candidate = folder / candidate
                finished_paths.append(candidate)

        options.update(
            {
                # 所有归档模式都保持原视频标题作为文件名，不添加作者前缀。
                # 目录名可能包含 %，先转义，避免被 yt-dlp 当成模板字段。
                "outtmpl": {
                    "default": (
                        f"{str(folder).replace('%', '%%')}/%(title)s.%(ext)s"
                    )
                },
                # 只选择不带 watermarked 标记的格式。抖音的 downloadAddr 会被标记为水印版。
                "format": "best[format_note!*=watermarked]",
                "overwrites": False,
                "continuedl": True,
                "merge_output_format": "mp4",
                "progress_hooks": [progress_hook],
                "postprocessor_hooks": [],
                "windowsfilenames": False,
                "restrictfilenames": False,
                "writethumbnail": False,
                "writeinfojson": False,
                "writesubtitles": False,
                "writeautomaticsub": False,
            }
        )

        try:
            with YoutubeDL(options) as ydl:
                info = ydl.extract_info(meta.webpage_url, download=True)
                prepared: Optional[Path] = None
                if isinstance(info, dict):
                    try:
                        prepared = Path(ydl.prepare_filename(info))
                        if not prepared.is_absolute():
                            prepared = folder / prepared
                    except Exception:
                        prepared = None
        except DownloadError as exc:
            detail = self._last_ytdlp_error(ydl_logger, exc)
            raise DownloadError(detail) from exc

        if not isinstance(info, dict):
            raise DownloadError("下载结束但 yt-dlp 没有返回文件信息。")

        # 如果格式选择异常，明确拒绝水印文件。
        for requested in info.get("requested_downloads") or []:
            note = str(requested.get("format_note") or "").lower()
            if "watermark" in note:
                raise DownloadError("只找到带水印的格式，已停止保存。请更新 yt-dlp 后重试。")

        candidates: list[Path] = []
        for raw_path in finished_paths:
            candidates.append(raw_path)
        if prepared:
            candidates.append(prepared)
        filepath = info.get("filepath") or info.get("_filename")
        if filepath:
            candidates.append(Path(filepath))
        for requested in info.get("requested_downloads") or []:
            for key in ("filepath", "filename"):
                value = requested.get(key)
                if value:
                    candidates.append(Path(value))

        for candidate in reversed(candidates):
            if not candidate.is_absolute():
                candidate = folder / candidate
            if (
                candidate.is_file()
                and candidate.suffix.lower() != ".part"
                and candidate.stat().st_size > 0
            ):
                logger.info("下载完成：%s", candidate)
                return candidate

        # 文件已存在时 yt-dlp 可能直接跳过，不会触发 progress hook。
        # 在目标目录中找本次运行期间产生的最新视频文件作为兜底。
        video_exts = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".flv"}
        recent_files = []
        try:
            for candidate in folder.iterdir():
                if (
                    candidate.is_file()
                    and candidate.suffix.lower() in video_exts
                    and candidate.stat().st_size > 0
                    and candidate.stat().st_mtime >= started_at - 10
                ):
                    recent_files.append(candidate)
        except OSError:
            pass
        if recent_files:
            latest = max(recent_files, key=lambda item: item.stat().st_mtime)
            logger.info("下载完成（目录扫描）：%s", latest)
            return latest

        raise DownloadError(f"下载结束，但未在 {folder} 中找到视频文件。")

    @staticmethod
    def _last_ytdlp_error(ydl_logger: _YtdlpLogger, exc: Exception) -> str:
        if ydl_logger.errors:
            return ydl_logger.errors[-1]
        return str(exc)


# ---------------------------------------------------------------------------
# 任务与后台队列
# ---------------------------------------------------------------------------


@dataclass
class DownloadJob:
    id: str
    url: str
    source: str
    status: str = "queued"
    resolved_url: Optional[str] = None
    video_id: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    author_uid: Optional[str] = None
    target_folder: Optional[str] = None
    destination: Optional[str] = None
    dedupe_key: str = ""
    folder: Optional[str] = None
    file: Optional[str] = None
    error: Optional[str] = None
    duplicate_of: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "source": self.source,
            "status": self.status,
            "resolved_url": self.resolved_url,
            "video_id": self.video_id,
            "title": self.title,
            "author": self.author,
            "author_uid": self.author_uid,
            "target_folder": self.target_folder,
            "destination": self.destination,
            "folder": _display_path(self.folder),
            "file": _display_path(self.file),
            "filename": Path(self.file).name if self.file else None,
            "error": self.error,
            "duplicate_of": self.duplicate_of,
            "created_at": _iso_time(self.created_at),
            "updated_at": _iso_time(self.updated_at),
        }


def _display_path(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    path = Path(value)
    try:
        return f"~/{path.relative_to(HOME)}"
    except ValueError:
        return str(path)


def _iso_time(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def friendly_error(exc: Exception) -> str:
    text = _ANSI_RE.sub("", str(exc) or exc.__class__.__name__)
    text = re.sub(r"^(?:ERROR:\s*)+", "", text, flags=re.IGNORECASE).strip()
    text = re.sub(r"\s+", " ", text)

    lower = text.lower()
    if "fresh cookies" in lower or ("cookie" in lower and "needed" in lower):
        text = f"{text} {COOKIE_HINT}"
    elif "requested format is not available" in lower:
        text = f"{text} 可能没有可用的无水印格式，请先更新 yt-dlp。"
    elif "login" in lower or "sign in" in lower:
        text = f"{text} 请更新浏览器 Cookie 后重试。"

    if len(text) > 1200:
        text = text[:1197] + "..."
    return text


class DownloadManager:
    """单 worker 下载队列，保证多个触发源不会同时写文件。"""

    def __init__(self, downloader: DouyinDownloader) -> None:
        self.downloader = downloader
        self._lock = threading.RLock()
        self._queue: queue.Queue[Optional[DownloadJob]] = queue.Queue()
        self._jobs: dict[str, DownloadJob] = {}
        self._job_order: OrderedDict[str, None] = OrderedDict()
        # 最近处理的 10 个请求：dedupe_key -> job id
        self._recent: OrderedDict[str, str] = OrderedDict()
        self._active: dict[str, str] = {}
        # 不同 URL 指向同一个视频时，避免真正重复下载。
        self._video_jobs: OrderedDict[str, str] = OrderedDict()
        self._stop_event = threading.Event()
        self._worker = threading.Thread(
            target=self._worker_loop,
            name="douyin-download-worker",
            daemon=True,
        )
        self._worker.start()

    # ---- 对外接口 ---------------------------------------------------------

    def submit(
        self,
        raw_url: str,
        source: str,
        target_folder: Optional[str] = None,
    ) -> tuple[DownloadJob, bool]:
        url = extract_douyin_url(raw_url) or canonicalize_douyin_url(raw_url)
        # 同一 URL 指定不同归档目录时，应当允许分别执行，不能互相判重。
        dedupe_key = f"{url}\x00{target_folder or ''}"
        with self._lock:
            active_id = self._active.get(dedupe_key)
            if active_id:
                existing = self._jobs.get(active_id)
                if existing:
                    return existing, True

            recent_id = self._recent.get(dedupe_key)
            if recent_id:
                existing = self._jobs.get(recent_id)
                if existing:
                    return existing, True
                self._recent.pop(dedupe_key, None)

            job = DownloadJob(
                id=uuid.uuid4().hex[:12],
                url=url,
                source=source or "unknown",
                target_folder=target_folder,
                dedupe_key=dedupe_key,
            )
            self._jobs[job.id] = job
            self._job_order[job.id] = None
            self._active[dedupe_key] = job.id
            self._remember_key_locked(dedupe_key, job.id)
            self._trim_job_history_locked()

        self._queue.put(job)
        logger.info(
            "任务已入队 [%s] %s（来源：%s，归档目标：%s）",
            job.id,
            url,
            job.source,
            target_folder or "自动",
        )
        return job, False

    def get_job(self, job_id: str) -> Optional[DownloadJob]:
        with self._lock:
            job = self._jobs.get(job_id)
            return DownloadJob(**job.__dict__) if job else None

    def pending_count(self) -> int:
        return self._queue.qsize()

    def recent_count(self) -> int:
        with self._lock:
            return len(self._recent)

    def stop(self) -> None:
        self._stop_event.set()
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        if self._worker.is_alive():
            self._worker.join(timeout=3)

    # ---- worker -----------------------------------------------------------

    def _worker_loop(self) -> None:
        while True:
            try:
                job = self._queue.get(timeout=0.2)
            except queue.Empty:
                if self._stop_event.is_set():
                    return
                continue

            if job is None:
                return

            try:
                self._process_job(job)
            except DownloadError as exc:
                logger.error("任务失败 [%s]：%s", job.id, exc)
                self._fail_job(job, friendly_error(exc))
            except Exception:
                logger.exception("任务处理出现未捕获异常 [%s]", job.id)
                self._fail_job(job, "内部错误，请查看服务日志。")
            finally:
                with self._lock:
                    if self._active.get(job.dedupe_key) == job.id:
                        self._active.pop(job.dedupe_key, None)
                self._queue.task_done()

    def _process_job(self, job: DownloadJob) -> None:
        self._update_job(job, status="downloading")

        resolved_url = job.url
        try:
            resolved_url = resolve_video_url(job.url)
        except (InvalidDouyinLink, VideoResolveError) as exc:
            # 交给 yt-dlp 的 Generic extractor 再试一次短链。
            logger.warning("短链预解析失败，将交给 yt-dlp 尝试：%s", exc)

        self._update_job(job, resolved_url=resolved_url)
        meta = self.downloader.fetch_metadata(resolved_url)

        self._update_job(
            job,
            video_id=meta.video_id,
            title=meta.title,
            author=meta.author,
            author_uid=meta.author_uid,
        )

        # 手动归档和映射归档允许把已下载过的视频再次放进另一个目录，
        # 因此只有“自动归档”路径才使用视频 ID 级别的去重。
        # 手动指定时不读取映射，避免损坏的 JSON 阻塞优先级 1。
        if job.target_folder:
            mapping_target = None
            cross_archive = True
        else:
            mapping_target = self.downloader.mapping_for_uid(
                meta.author_uid,
                strict=True,
            )
            cross_archive = bool(mapping_target)

        if not cross_archive:
            # 同一视频已经在本次进程里成功下载过：直接复用旧路径，避免为了
            # 查重先改目录名，导致旧 job 里的 file 路径失效。
            with self._lock:
                prior_id = self._video_jobs.get(meta.video_id)
                prior = self._jobs.get(prior_id) if prior_id else None
                if (
                    prior
                    and prior.id != job.id
                    and prior.status == "success"
                    and prior.file
                    and Path(prior.file).is_file()
                ):
                    prior_folder = prior.folder or str(Path(prior.file).parent)
                    self._update_job(
                        job,
                        status="success",
                        duplicate_of=prior.id,
                        author=prior.author or meta.author,
                        author_uid=prior.author_uid or meta.author_uid,
                        folder=prior_folder,
                        file=prior.file,
                        title=prior.title or meta.title,
                        destination="duplicate",
                    )
                    logger.info("视频 %s 已存在，跳过重复下载", meta.video_id)
                    return

        destination = self.downloader.resolve_destination(
            meta,
            target_folder=job.target_folder,
        )
        self._update_job(
            job,
            folder=str(destination.folder),
            destination=destination.reason,
        )

        downloaded_file = self.downloader.download(meta, destination)
        self._update_job(
            job,
            status="success",
            file=str(downloaded_file),
            folder=str(downloaded_file.parent),
            duplicate_of=None,
            error=None,
        )

        with self._lock:
            # 只把“自己的 UID 目录”加入视频级去重表。跨账号归档不能阻止
            # 以后把同一视频正常下载到作者自己的目录。
            if destination.reason in ("uid", "new"):
                self._video_jobs[meta.video_id] = job.id
                self._video_jobs.move_to_end(meta.video_id)
                while len(self._video_jobs) > MAX_VIDEO_ID_HISTORY:
                    self._video_jobs.popitem(last=False)
            self._remember_key_locked(job.dedupe_key, job.id)

    def _fail_job(self, job: DownloadJob, message: str) -> None:
        self._update_job(job, status="error", error=message)
        with self._lock:
            if self._active.get(job.dedupe_key) == job.id:
                self._active.pop(job.dedupe_key, None)
            if self._recent.get(job.dedupe_key) == job.id:
                self._recent.pop(job.dedupe_key, None)
            if job.video_id and self._video_jobs.get(job.video_id) == job.id:
                self._video_jobs.pop(job.video_id, None)
        logger.error("任务失败 [%s]：%s", job.id, message)

    def _update_job(self, job: DownloadJob, **fields: Any) -> None:
        with self._lock:
            for key, value in fields.items():
                setattr(job, key, value)
            job.updated_at = time.time()

    def _remember_key_locked(self, dedupe_key: str, job_id: str) -> None:
        self._recent[dedupe_key] = job_id
        self._recent.move_to_end(dedupe_key)
        while len(self._recent) > RECENT_LINK_LIMIT:
            self._recent.popitem(last=False)

    def _trim_job_history_locked(self) -> None:
        if len(self._jobs) <= MAX_JOB_HISTORY:
            return
        for job_id in list(self._job_order.keys()):
            job = self._jobs.get(job_id)
            if not job or job.status not in ("success", "error"):
                continue
            if job_id in self._active.values():
                continue
            self._jobs.pop(job_id, None)
            self._job_order.pop(job_id, None)
            if len(self._jobs) <= MAX_JOB_HISTORY:
                break


# ---------------------------------------------------------------------------
# 剪贴板监听
# ---------------------------------------------------------------------------


class ClipboardWatcher(threading.Thread):
    def __init__(self, manager: DownloadManager, interval: float = 0.8) -> None:
        super().__init__(name="douyin-clipboard-watcher", daemon=True)
        self.manager = manager
        self.interval = max(0.2, float(interval))
        self._stop_event = threading.Event()
        self._warned = False

    def stop(self) -> None:
        self._stop_event.set()
        if self.is_alive():
            self.join(timeout=2)

    def run(self) -> None:
        last_text: Optional[str] = None
        logger.info("剪贴板监听已启动（间隔 %.1f 秒）", self.interval)
        while not self._stop_event.is_set():
            text = self._read_clipboard()
            if text is not None and text != last_text:
                last_text = text
                url = extract_douyin_url(text)
                if url:
                    try:
                        job, duplicate = self.manager.submit(url, "clipboard")
                        if duplicate:
                            logger.debug("剪贴板链接已处理过，忽略：%s", url)
                        else:
                            logger.info("检测到剪贴板链接，已入队 [%s] %s", job.id, url)
                    except InvalidDouyinLink:
                        pass
                    except Exception:
                        logger.exception("剪贴板链接入队失败：%s", url)
            if self._stop_event.wait(self.interval):
                break

    def _read_clipboard(self) -> Optional[str]:
        if pyperclip is not None:
            try:
                value = pyperclip.paste()
                if isinstance(value, str):
                    return value[:200_000]
            except Exception as exc:
                if not self._warned:
                    logger.warning("pyperclip 读取失败，将回退到 pbpaste：%s", exc)
                    self._warned = True

        pbpaste = shutil.which("pbpaste")
        if not pbpaste:
            if not self._warned:
                logger.warning("没有可用的剪贴板读取工具（pyperclip / pbpaste）。")
                self._warned = True
            return None

        try:
            result = subprocess.run(
                [pbpaste],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            if not self._warned:
                logger.warning("pbpaste 读取失败：%s", exc)
                self._warned = True
            return None
        if result.returncode != 0:
            return None
        return result.stdout.decode("utf-8", errors="replace")[:200_000]


# ---------------------------------------------------------------------------
# Flask API
# ---------------------------------------------------------------------------


def _origin_allowed(origin: str) -> bool:
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    return (
        host == "douyin.com"
        or host.endswith(".douyin.com")
        or host in {"127.0.0.1", "localhost", "::1"}
    )


def create_app(
    manager: DownloadManager,
    clipboard_enabled: bool = True,
) -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    app.json.ensure_ascii = False

    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin")
        if origin and _origin_allowed(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Access-Control-Max-Age"] = "86400"
            # Chrome 的 Private Network Access 预检需要这个响应头。
            if (
                request.method == "OPTIONS"
                or request.headers.get("Access-Control-Request-Private-Network") == "true"
            ):
                response.headers["Access-Control-Allow-Private-Network"] = "true"
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    @app.get("/")
    def index():
        return jsonify(
            {
                "ok": True,
                "service": "douyin-downloader",
                "base_dir": str(manager.downloader.base_dir),
                "mapping_file": str(manager.downloader.mapping_file),
                "health": "/api/health",
                "folders": "GET /api/folders",
                "author_info": "GET /api/author_info?url=...",
                "download": "POST /api/download",
            }
        )

    @app.get("/api/health")
    def health():
        try:
            folder_count = len(manager.downloader.list_folders())
        except DownloadError:
            folder_count = None
        return jsonify(
            {
                "ok": True,
                "service": "douyin-downloader",
                "base_dir": str(manager.downloader.base_dir),
                "mapping_file": str(manager.downloader.mapping_file),
                "clipboard_watcher": clipboard_enabled,
                "pending_jobs": manager.pending_count(),
                "recent_links": manager.recent_count(),
                "folder_count": folder_count,
            }
        )

    @app.get("/api/folders")
    def api_folders():
        try:
            folders = manager.downloader.list_folders()
        except DownloadError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        return jsonify({"ok": True, "count": len(folders), "folders": folders})

    @app.get("/api/author_info")
    def api_author_info():
        raw_url = request.args.get("url", "")
        if not isinstance(raw_url, str) or not raw_url.strip():
            return jsonify({"ok": False, "error": "缺少 url 参数。"}), 400
        if len(raw_url) > 8192:
            return jsonify({"ok": False, "error": "url 参数过长。"}), 400

        try:
            canonical = extract_douyin_url(raw_url) or canonicalize_douyin_url(raw_url)
            resolved = resolve_video_url(canonical)
        except InvalidDouyinLink as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except VideoResolveError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502

        try:
            meta = manager.downloader.fetch_metadata(resolved)
        except DownloadError as exc:
            return jsonify({"ok": False, "error": friendly_error(exc)}), 502
        except Exception as exc:
            logger.exception("获取作者信息失败")
            return jsonify({"ok": False, "error": friendly_error(exc)}), 500

        return jsonify(
            {
                "ok": True,
                "author_nickname": meta.author,
                "uid": meta.author_uid,
                "video_id": meta.video_id,
                "title": meta.title,
            }
        )

    @app.post("/api/download")
    def api_download():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "请求体必须是 JSON 对象。"}), 400

        raw = payload.get("url") or payload.get("link") or payload.get("text")
        if not isinstance(raw, str) or not raw.strip():
            return (
                jsonify({"ok": False, "error": "缺少 url 字段，或内容为空。"}),
                400,
            )
        if len(raw) > 8192:
            return jsonify({"ok": False, "error": "url 内容过长。"}), 400

        target_folder: Optional[str] = None
        target_raw = payload.get("target_author")
        if target_raw is not None:
            if not isinstance(target_raw, str):
                return jsonify({"ok": False, "error": "target_author 必须是字符串。"}), 400
            target_query = target_raw.strip()
            if target_query:
                if len(target_query) > 255:
                    return (
                        jsonify({"ok": False, "error": "target_author 过长。"}),
                        400,
                    )
                try:
                    target_folder = manager.downloader.resolve_target_folder(target_query)
                except DownloadError as exc:
                    return jsonify({"ok": False, "error": str(exc)}), 500
                if not target_folder:
                    return (
                        jsonify(
                            {
                                "ok": False,
                                "error": "找不到匹配的目标文件夹，请刷新 /api/folders 后重试。",
                            }
                        ),
                        400,
                    )

        try:
            job, duplicate = manager.submit(
                raw,
                source="api",
                target_folder=target_folder,
            )
        except InvalidDouyinLink as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400

        if duplicate:
            message = "该链接和归档目标已在队列中或最近已处理。"
        elif target_folder:
            message = f"已加入下载队列，将归档到：{target_folder}"
        else:
            message = "已加入下载队列。"
        return (
            jsonify(
                {
                    "ok": True,
                    "duplicate": duplicate,
                    "message": message,
                    "job": job.to_dict(),
                }
            ),
            200 if duplicate else 202,
        )

    @app.get("/api/status/<job_id>")
    def api_status(job_id: str):
        if not re.fullmatch(r"[a-f0-9]{6,32}", job_id):
            return jsonify({"ok": False, "error": "任务 ID 格式不正确。"}), 400
        job = manager.get_job(job_id)
        if not job:
            return jsonify({"ok": False, "error": "任务不存在。"}), 404
        return jsonify({"ok": True, "job": job.to_dict()})

    return app


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------


_SUPPORTED_BROWSERS = {
    "brave",
    "chrome",
    "chromium",
    "edge",
    "firefox",
    "opera",
    "safari",
    "vivaldi",
    "whale",
}


def _parse_browser_spec(value: str) -> BrowserSpec:
    browser, _, profile = value.partition(":")
    browser = browser.strip().lower()
    if browser not in _SUPPORTED_BROWSERS:
        supported = ", ".join(sorted(_SUPPORTED_BROWSERS))
        raise argparse.ArgumentTypeError(f"不支持的浏览器：{browser}。可选：{supported}")
    profile = profile.strip() or None
    return (browser, profile, None, None)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="抖音无水印视频下载器：剪贴板监听 + 本地 HTTP API",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP 端口，默认 5001")
    parser.add_argument(
        "--interval",
        type=float,
        default=0.8,
        help="剪贴板轮询间隔（秒），默认 0.8",
    )
    parser.add_argument(
        "--no-clipboard",
        action="store_true",
        help="只启动 HTTP API，不监听剪贴板",
    )
    parser.add_argument(
        "--cookies",
        metavar="PATH",
        help="Netscape 格式 cookies.txt 路径",
    )
    parser.add_argument(
        "--cookies-from-browser",
        metavar="BROWSER[:PROFILE]",
        type=_parse_browser_spec,
        help="从浏览器读取 Cookie，如 chrome、safari、edge、chrome:'Profile 1'",
    )
    parser.add_argument("--verbose", action="store_true", help="输出调试日志")
    return parser


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("werkzeug").setLevel(logging.INFO)


def _port_available(port: int) -> bool:
    """只检查 127.0.0.1，和 Flask 实际绑定的地址保持一致。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _explain_busy_port(port: int) -> None:
    logger.error("端口 %s 已被占用，服务无法启动。", port)
    if port == 5000:
        logger.error(
            "macOS 上 5000 端口经常被系统的“隔空播放接收器”（ControlCenter）占用。"
        )
        logger.error(
            "本项目默认已改用 5001；直接运行 python3 app.py 即可，无需 --port 5000。"
        )
    else:
        next_port = port + 1 if port < 65535 else port - 1
        logger.error(
            "请换一个端口，例如 --port %s，并把油猴脚本顶部的 API_BASE "
            "改成 http://127.0.0.1:%s。",
            next_port,
            next_port,
        )
    logger.error("查看占用进程：lsof -nP -iTCP:%s -sTCP:LISTEN", port)


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    if args.cookies and args.cookies_from_browser:
        parser.error("--cookies 和 --cookies-from-browser 只能二选一。")
    if not (1 <= args.port <= 65535):
        parser.error("--port 必须在 1 到 65535 之间。")

    if not _port_available(args.port):
        _explain_busy_port(args.port)
        return 1

    cookies_file = None
    if args.cookies:
        cookie_path = Path(args.cookies).expanduser()
        if not cookie_path.is_file():
            parser.error(f"Cookie 文件不存在：{cookie_path}")
        cookies_file = str(cookie_path)

    try:
        BASE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.error("无法创建保存目录 %s：%s", BASE_DIR, exc)
        return 1

    settings = DownloaderSettings(
        cookies_file=cookies_file,
        cookies_from_browser=args.cookies_from_browser,
        verbose=args.verbose,
    )
    downloader = DouyinDownloader(settings)
    manager = DownloadManager(downloader)
    atexit.register(manager.stop)

    watcher: Optional[ClipboardWatcher] = None
    if not args.no_clipboard:
        watcher = ClipboardWatcher(manager, interval=args.interval)
        watcher.start()
    else:
        logger.info("剪贴板监听已禁用。")

    app = create_app(manager, clipboard_enabled=watcher is not None)

    logger.info("=" * 62)
    logger.info("抖音下载器已启动")
    logger.info("保存目录：%s（自动创建）", BASE_DIR)
    logger.info("HTTP API：http://127.0.0.1:%s/api/download", args.port)
    logger.info("健康检查：http://127.0.0.1:%s/api/health", args.port)
    if args.cookies_from_browser:
        browser, profile, _keyring, _container = args.cookies_from_browser
        logger.info(
            "Cookie 来源：%s",
            f"{browser}:{profile}" if profile else browser,
        )
    elif cookies_file:
        logger.info("Cookie 文件：%s", cookies_file)
    else:
        logger.warning("未配置 Cookie；如果下载失败，请参考 README 配置浏览器 Cookie。")
    logger.info("=" * 62)

    try:
        app.run(
            host="127.0.0.1",
            port=args.port,
            debug=False,
            threaded=True,
            use_reloader=False,
        )
    except KeyboardInterrupt:
        logger.info("收到 Ctrl+C，正在退出。")
    except OSError as exc:
        logger.error("HTTP 服务启动失败：%s", exc)
        return 1
    finally:
        if watcher:
            watcher.stop()
        manager.stop()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
