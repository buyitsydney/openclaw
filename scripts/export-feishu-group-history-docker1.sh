#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTAINER_NAME="carher-1"
CHAT_ID=""
CHAT_NAME=""
OUTPUT_DIR=""

usage() {
  cat <<'EOF'
用法:
  scripts/export-feishu-group-history-docker1.sh --chat-id=<oc_xxx> [--container=carher-1] [--output-dir=tmp/dir]
  scripts/export-feishu-group-history-docker1.sh --chat-name=<群名> [--container=carher-1] [--output-dir=tmp/dir]

说明:
  - 只读导出：使用 carher Docker 容器中的当前 user_access_token
  - 严格模式：任何分页失败、消息重复、资源下载失败，脚本都会非 0 退出
  - 会同时输出：
      group-rankings.json   当前可见群的消息数排名
      export-manifest.json  导出摘要 + 失败详情
      raw-messages.json     完整原始消息 JSON
      messages.jsonl        每行一条标准化消息
      resources/            资源文件（图片/文件/视频封面）
      review.md             人工核对说明
EOF
}

for arg in "$@"; do
  case "$arg" in
    --container=*)
      CONTAINER_NAME="${arg#--container=}"
      ;;
    --chat-id=*)
      CHAT_ID="${arg#--chat-id=}"
      ;;
    --chat-name=*)
      CHAT_NAME="${arg#--chat-name=}"
      ;;
    --output-dir=*)
      OUTPUT_DIR="${arg#--output-dir=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$CHAT_ID" && -n "$CHAT_NAME" ]]; then
  echo "--chat-id 和 --chat-name 只能二选一" >&2
  exit 1
fi

if [[ -z "$CHAT_ID" && -z "$CHAT_NAME" ]]; then
  echo "必须提供 --chat-id 或 --chat-name" >&2
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
  echo "容器未运行: $CONTAINER_NAME" >&2
  exit 1
fi

if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="$REPO_ROOT/tmp/feishu-group-history-export/$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$OUTPUT_DIR"

export EXPORT_CONTAINER_NAME="$CONTAINER_NAME"
export EXPORT_CHAT_ID="$CHAT_ID"
export EXPORT_CHAT_NAME="$CHAT_NAME"
export EXPORT_OUTPUT_DIR="$OUTPUT_DIR"

python3 - <<'PY'
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "https://open.feishu.cn/open-apis"
CONTAINER_NAME = os.environ["EXPORT_CONTAINER_NAME"]
CHAT_ID = os.environ.get("EXPORT_CHAT_ID", "").strip()
CHAT_NAME = os.environ.get("EXPORT_CHAT_NAME", "").strip()
OUTPUT_DIR = Path(os.environ["EXPORT_OUTPUT_DIR"]).resolve()
RESOURCES_DIR = OUTPUT_DIR / "resources"
RESOURCES_DIR.mkdir(parents=True, exist_ok=True)


def fail(message: str, *, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def docker_python(code: str) -> str:
    proc = subprocess.run(
        ["docker", "exec", "-i", CONTAINER_NAME, "python3", "-c", code],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        fail(
            f"docker exec 失败\ncommand=python3 -c ...\nstdout={proc.stdout}\nstderr={proc.stderr}",
            code=proc.returncode or 1,
        )
    return proc.stdout


def load_single_user_token() -> dict:
    paths = json.loads(
        docker_python(
            "import glob, json; "
            "print(json.dumps(sorted(glob.glob('/data/.openclaw/feishu-user-tokens/*.json'))))"
        )
    )
    if not isinstance(paths, list) or not paths:
        fail("容器中未找到任何飞书 user token 文件")
    if len(paths) != 1:
        fail(f"容器中存在多个 user token 文件，当前脚本要求严格单用户：{paths}")
    token_path = paths[0]
    token_doc = json.loads(
        docker_python(
            "import json; "
            f"print(json.dumps(json.load(open({json.dumps(token_path)}, 'r', encoding='utf-8')), ensure_ascii=False))"
        )
    )
    required = ["open_id", "access_token", "scopes"]
    missing = [key for key in required if key not in token_doc]
    if missing:
        fail(f"user token 缺少字段: {missing}")
    return token_doc


TOKEN_DOC = load_single_user_token()
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN_DOC['access_token']}"}


def request_json(path: str, *, query: dict[str, str] | None = None) -> dict:
    qs = urllib.parse.urlencode(query or {})
    url = f"{BASE_URL}{path}"
    if qs:
        url = f"{url}?{qs}"
    req = urllib.request.Request(url, headers=AUTH_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            fail(f"JSON API HTTP 错误 {exc.code}: {raw}")
        fail(f"JSON API 失败 {path}: code={payload.get('code')} msg={payload.get('msg')}")
    except urllib.error.URLError as exc:
        fail(f"JSON API 网络错误 {path}: {exc.reason}")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"JSON API 返回非 JSON: {path}: {exc}")

    if payload.get("code") != 0:
        fail(f"JSON API 返回失败 {path}: code={payload.get('code')} msg={payload.get('msg')}")
    return payload


def request_binary(message_id: str, file_key: str, resource_type: str) -> tuple[bytes, dict]:
    path = f"/im/v1/messages/{urllib.parse.quote(message_id)}/resources/{urllib.parse.quote(file_key)}"
    query = urllib.parse.urlencode({"type": resource_type})
    url = f"{BASE_URL}{path}?{query}"
    req = urllib.request.Request(url, headers=AUTH_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read(), dict(resp.headers.items())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw_body": raw}
        raise RuntimeError(
            json.dumps(
                {
                    "http_status": exc.code,
                    "api_code": payload.get("code"),
                    "api_msg": payload.get("msg"),
                    "raw_body": payload.get("raw_body"),
                },
                ensure_ascii=False,
            )
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(json.dumps({"network_error": str(exc.reason)}, ensure_ascii=False)) from exc


def list_visible_groups() -> list[dict]:
    groups: list[dict] = []
    page_token = ""
    while True:
        query = {"page_size": "100"}
        if page_token:
            query["page_token"] = page_token
        payload = request_json("/im/v1/chats", query=query)
        data = payload.get("data", {})
        items = data.get("items", [])
        if not isinstance(items, list):
            fail("/im/v1/chats 返回 items 非数组")
        groups.extend(items)
        if not data.get("has_more"):
            return groups
        page_token = data.get("page_token", "")
        if not isinstance(page_token, str) or not page_token:
            fail("/im/v1/chats has_more=true 但缺少 page_token")


def select_group(groups: list[dict]) -> dict:
    if CHAT_ID:
        matches = [g for g in groups if g.get("chat_id") == CHAT_ID]
        if len(matches) != 1:
            fail(f"未找到唯一 chat_id={CHAT_ID} 的群，匹配数={len(matches)}")
        return matches[0]
    matches = [g for g in groups if g.get("name") == CHAT_NAME]
    if len(matches) != 1:
        fail(f"按群名精确匹配失败，群名={CHAT_NAME}，匹配数={len(matches)}")
    return matches[0]


def fetch_all_messages(chat_id: str) -> tuple[list[dict], list[dict]]:
    items: list[dict] = []
    pages: list[dict] = []
    seen_ids: set[str] = set()
    page_token = ""
    page_index = 0
    while True:
        query = {
            "container_id_type": "chat",
            "container_id": chat_id,
            "page_size": "50",
        }
        if page_token:
            query["page_token"] = page_token
        payload = request_json("/im/v1/messages", query=query)
        data = payload.get("data", {})
        page_items = data.get("items", [])
        if not isinstance(page_items, list):
            fail("/im/v1/messages 返回 items 非数组")
        for item in page_items:
            message_id = item.get("message_id")
            if not isinstance(message_id, str) or not message_id:
                fail("发现缺少 message_id 的消息")
            if message_id in seen_ids:
                fail(f"发现重复 message_id: {message_id}")
            seen_ids.add(message_id)
            items.append(item)
        pages.append(
            {
                "page_index": page_index,
                "page_token_in": page_token,
                "page_token_out": data.get("page_token", ""),
                "item_count": len(page_items),
                "has_more": bool(data.get("has_more")),
            }
        )
        if not data.get("has_more"):
            return items, pages
        page_token = data.get("page_token", "")
        if not isinstance(page_token, str) or not page_token:
            fail("/im/v1/messages has_more=true 但缺少 page_token")
        page_index += 1


def parse_body_content(message: dict) -> object:
    body = message.get("body")
    if not isinstance(body, dict):
        return None
    content = body.get("content")
    if not isinstance(content, str):
        return content
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return content


def walk_content(node: object):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk_content(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk_content(value)


def collect_resources(message: dict, parsed: object) -> list[dict]:
    resources: list[dict] = []
    msg_type = message.get("msg_type")
    message_id = message.get("message_id")
    if not isinstance(message_id, str):
        fail("消息缺少合法 message_id")
    seen: set[tuple[str, str]] = set()

    def push(resource_type: str, file_key: str, *, source: str, file_name: str | None = None) -> None:
        if not isinstance(file_key, str) or not file_key:
            fail(f"消息 {message_id} 的资源 key 非法: {file_key!r}")
        sig = (resource_type, file_key)
        if sig in seen:
            return
        seen.add(sig)
        resources.append(
            {
                "message_id": message_id,
                "msg_type": msg_type,
                "resource_type": resource_type,
                "file_key": file_key,
                "source": source,
                "file_name": file_name,
            }
        )

    if msg_type == "image" and isinstance(parsed, dict):
        push("image", parsed.get("image_key"), source="image.body")
    elif msg_type in {"file", "folder", "audio"} and isinstance(parsed, dict):
        push("file", parsed.get("file_key"), source=f"{msg_type}.body", file_name=parsed.get("file_name"))
    elif msg_type == "media" and isinstance(parsed, dict):
        push("file", parsed.get("file_key"), source="media.file", file_name=parsed.get("file_name"))
        image_key = parsed.get("image_key")
        if image_key:
            push("image", image_key, source="media.cover")
    if isinstance(parsed, (dict, list)):
        for node in walk_content(parsed):
            tag = node.get("tag")
            if tag == "img" and "image_key" in node:
                push("image", node.get("image_key"), source=f"{msg_type}.tag:img")
            elif tag == "media":
                push("file", node.get("file_key"), source=f"{msg_type}.tag:media")
                if node.get("image_key"):
                    push("image", node.get("image_key"), source=f"{msg_type}.tag:media.cover")
    return resources


def message_summary(msg_type: str, parsed: object) -> str:
    if parsed is None:
        return ""
    if isinstance(parsed, str):
        return parsed
    if msg_type == "text" and isinstance(parsed, dict):
        return str(parsed.get("text", ""))
    if msg_type == "system" and isinstance(parsed, dict):
        template = str(parsed.get("template", ""))
        names: list[str] = []
        for key in ("from_user", "to_chatters"):
            value = parsed.get(key)
            if isinstance(value, list):
                names.extend(str(x) for x in value)
        suffix = f" | participants={', '.join(names)}" if names else ""
        return template + suffix
    if msg_type in {"file", "folder"} and isinstance(parsed, dict):
        return f"{parsed.get('file_name', '')} [{parsed.get('file_key', '')}]"
    if msg_type == "audio" and isinstance(parsed, dict):
        return f"audio duration_ms={parsed.get('duration')} [{parsed.get('file_key', '')}]"
    if msg_type == "media" and isinstance(parsed, dict):
        return (
            f"{parsed.get('file_name', '')} duration_ms={parsed.get('duration')} "
            f"file={parsed.get('file_key', '')} cover={parsed.get('image_key', '')}"
        )
    if msg_type == "image" and isinstance(parsed, dict):
        return f"image [{parsed.get('image_key', '')}]"
    if msg_type in {"post", "interactive"} and isinstance(parsed, dict):
        parts: list[str] = []
        for node in walk_content(parsed):
            tag = node.get("tag")
            if tag == "text" and isinstance(node.get("text"), str):
                text = node["text"].strip()
                if text:
                    parts.append(text)
            elif tag == "a" and isinstance(node.get("href"), str):
                href = node["href"].strip()
                if href:
                    parts.append(f"LINK:{href}")
            elif tag == "img" and isinstance(node.get("image_key"), str):
                parts.append(f"IMG:{node['image_key']}")
            elif tag == "media" and isinstance(node.get("file_key"), str):
                parts.append(f"MEDIA:{node['file_key']}")
            elif tag == "at" and isinstance(node.get("user_id"), str):
                parts.append(f"AT:{node['user_id']}")
        title = parsed.get("title")
        if isinstance(title, str) and title.strip():
            parts.insert(0, f"TITLE:{title.strip()}")
        return " | ".join(parts)
    return json.dumps(parsed, ensure_ascii=False)


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value)
    cleaned = cleaned.strip("._")
    return cleaned or "blob"


def choose_suffix(content_type: str | None, resource_type: str) -> str:
    ctype = (content_type or "").split(";")[0].strip().lower()
    guessed = mimetypes.guess_extension(ctype) if ctype else None
    if guessed:
        return guessed
    return ".bin" if resource_type == "file" else ".img"


visible_groups = list_visible_groups()
selected_group = select_group(visible_groups)

group_rankings: list[dict] = []
selected_messages: list[dict] | None = None
selected_pages: list[dict] | None = None
for group in visible_groups:
    chat_id = group.get("chat_id")
    if not isinstance(chat_id, str) or not chat_id:
        fail(f"发现缺少 chat_id 的群条目: {group}")
    messages, pages = fetch_all_messages(chat_id)
    group_rankings.append(
        {
            "chat_id": chat_id,
            "name": group.get("name"),
            "message_count": len(messages),
            "pages": len(pages),
        }
    )
    if chat_id == selected_group.get("chat_id"):
        selected_messages = messages
        selected_pages = pages

group_rankings.sort(key=lambda item: (-item["message_count"], str(item.get("name", ""))))
if selected_messages is None or selected_pages is None:
    fail("内部错误：未拿到目标群的消息列表")

parsed_messages: list[dict] = []
resource_refs: list[dict] = []
msg_type_counter = Counter()
for index, message in enumerate(selected_messages):
    parsed = parse_body_content(message)
    msg_type = message.get("msg_type")
    msg_type_counter[str(msg_type)] += 1
    sender = message.get("sender")
    sender_id = None
    sender_type = None
    if isinstance(sender, dict):
        sender_id = sender.get("id")
        sender_type = sender.get("sender_type")
    parsed_messages.append(
        {
            "index": index,
            "message_id": message.get("message_id"),
            "root_id": message.get("root_id"),
            "parent_id": message.get("parent_id"),
            "chat_id": message.get("chat_id"),
            "msg_type": msg_type,
            "create_time": message.get("create_time"),
            "create_time_iso": datetime.fromtimestamp(
                int(message.get("create_time", "0")) / 1000, tz=timezone.utc
            ).isoformat()
            if str(message.get("create_time", "")).isdigit()
            else None,
            "deleted": message.get("deleted"),
            "updated": message.get("updated"),
            "sender_id": sender_id,
            "sender_type": sender_type,
            "body_parsed": parsed,
            "summary": message_summary(str(msg_type), parsed),
        }
    )
    resource_refs.extend(collect_resources(message, parsed))

resource_results: list[dict] = []
resource_failures: list[dict] = []
for ref in resource_refs:
    file_key = ref["file_key"]
    message_id = ref["message_id"]
    resource_type = ref["resource_type"]
    try:
        blob, headers = request_binary(message_id, file_key, resource_type)
        content_type = headers.get("Content-Type")
        original_name = ref.get("file_name")
        if isinstance(original_name, str) and "." in original_name:
            suffix = Path(original_name).suffix
            file_stem = safe_name(Path(original_name).stem)
        elif isinstance(original_name, str) and original_name:
            suffix = choose_suffix(content_type, resource_type)
            file_stem = safe_name(original_name)
        else:
            suffix = choose_suffix(content_type, resource_type)
            file_stem = safe_name(f"{resource_type}_{file_key}")
        target_dir = RESOURCES_DIR / safe_name(message_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / f"{file_stem}{suffix}"
        target_path.write_bytes(blob)
        resource_results.append(
            {
                **ref,
                "status": "downloaded",
                "saved_path": str(target_path.relative_to(OUTPUT_DIR)),
                "bytes": len(blob),
                "content_type": content_type,
            }
        )
    except RuntimeError as exc:
        detail = json.loads(str(exc))
        failure = {**ref, "status": "failed", **detail}
        resource_results.append(failure)
        resource_failures.append(failure)

rankings_path = OUTPUT_DIR / "group-rankings.json"
raw_messages_path = OUTPUT_DIR / "raw-messages.json"
messages_jsonl_path = OUTPUT_DIR / "messages.jsonl"
manifest_path = OUTPUT_DIR / "export-manifest.json"
review_path = OUTPUT_DIR / "review.md"

rankings_path.write_text(json.dumps(group_rankings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
raw_messages_path.write_text(json.dumps(selected_messages, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
with messages_jsonl_path.open("w", encoding="utf-8") as handle:
    for row in parsed_messages:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")

manifest = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "container": CONTAINER_NAME,
    "token_open_id": TOKEN_DOC["open_id"],
    "requested_chat_id": CHAT_ID or None,
    "requested_chat_name": CHAT_NAME or None,
    "selected_group": {
        "chat_id": selected_group.get("chat_id"),
        "name": selected_group.get("name"),
        "message_count": len(selected_messages),
        "page_count": len(selected_pages),
        "is_top_group_now": bool(group_rankings and group_rankings[0]["chat_id"] == selected_group.get("chat_id")),
    },
    "message_type_counts": dict(msg_type_counter),
    "pages": selected_pages,
    "resource_summary": {
        "resource_ref_count": len(resource_refs),
        "downloaded_count": len([x for x in resource_results if x["status"] == "downloaded"]),
        "failed_count": len(resource_failures),
    },
    "resource_results": resource_results,
}
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

review_lines = [
    "# Feishu Group History Export Review",
    "",
    f"- container: `{CONTAINER_NAME}`",
    f"- token_open_id: `{TOKEN_DOC['open_id']}`",
    f"- selected chat_id: `{selected_group.get('chat_id')}`",
    f"- selected chat_name: `{selected_group.get('name')}`",
    f"- selected message_count: `{len(selected_messages)}`",
    f"- selected page_count: `{len(selected_pages)}`",
    f"- selected is_top_group_now: `{manifest['selected_group']['is_top_group_now']}`",
    "",
    "## Group Ranking",
    "",
]
for row in group_rankings:
    review_lines.append(f"- {row['name']} | {row['chat_id']} | {row['message_count']} messages")
review_lines.extend(
    [
        "",
        "## Message Type Counts",
        "",
    ]
)
for msg_type, count in sorted(msg_type_counter.items()):
    review_lines.append(f"- {msg_type}: {count}")
review_lines.extend(
    [
        "",
        "## Resource Summary",
        "",
        f"- resource_ref_count: {len(resource_refs)}",
        f"- downloaded_count: {len([x for x in resource_results if x['status'] == 'downloaded'])}",
        f"- failed_count: {len(resource_failures)}",
        "",
        "## Manual Review Checklist",
        "",
        f"- 对照飞书客户端里的 `{selected_group.get('name')}` 群，确认总消息数是否一致。",
        "- 按时间顺序抽查 `messages.jsonl` 里的前 10 条和后 10 条。",
        "- 对照 `resource_results`，确认每条 file/media/interactive/img 是否都能在客户端中找到。",
        "- 如果脚本非 0 退出，优先看 `export-manifest.json` 的 `resource_results` 失败详情。",
    ]
)
review_path.write_text("\n".join(review_lines) + "\n", encoding="utf-8")

print(f"导出目录: {OUTPUT_DIR}")
print(f"目标群: {selected_group.get('name')} ({selected_group.get('chat_id')})")
print(f"消息总数: {len(selected_messages)}")
print(f"资源引用数: {len(resource_refs)}")
print(f"资源失败数: {len(resource_failures)}")

if resource_failures:
    fail(f"存在 {len(resource_failures)} 个资源下载失败，未达到 100% 全量导出标准", code=2)
PY
