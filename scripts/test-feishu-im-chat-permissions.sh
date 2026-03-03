#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CSV_PATH="$REPO_ROOT/docker/users.csv"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
REPORT_DIR="$REPO_ROOT/tmp/feishu-im-chat-permissions/$TIMESTAMP"

mkdir -p "$REPORT_DIR"

REPORT_JSON="$REPORT_DIR/report.json"
REPORT_MD="$REPORT_DIR/report.md"

python3 - "$CSV_PATH" "$REPORT_JSON" "$REPORT_MD" <<'PY'
import csv
import datetime as dt
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://open.feishu.cn/open-apis"
TARGET_USER_ID = "1"

ALL_SCOPES = [
    "im:chat",
    "im:chat:read",
    "im:chat:readonly",
    "im:chat:create",
    "im:chat:update",
    "im:chat:delete",
    "im:chat:operate_as_owner",
    "im:chat.access_event.bot_p2p_chat:read",
    "im:chat.announcement:read",
    "im:chat.announcement:write_only",
    "im:chat.chat_pins:read",
    "im:chat.chat_pins:write_only",
    "im:chat.top_notice:write_only",
    "im:chat.members:read",
    "im:chat.members:write_only",
    "im:chat.members:bot_access",
    "im:chat.managers:write_only",
    "im:chat.moderation:read",
    "im:chat:moderation:write_only",
    "im:chat.menu_tree:read",
    "im:chat.menu_tree:write_only",
    "im:chat.tabs:read",
    "im:chat.tabs:write_only",
    "im:chat.widgets:read",
    "im:chat.widgets:write_only",
    "im:chat.collab_plugins:read",
    "im:chat.collab_plugins:write_only",
]


def fail(message: str) -> None:
    raise SystemExit(message)


def load_user_credentials(csv_path: pathlib.Path, user_id: str) -> tuple[str, str, str]:
    if not csv_path.exists():
        fail(f"users.csv 不存在: {csv_path}")

    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            if not row:
                continue
            if row[0].startswith("#"):
                continue
            if row[0].strip() != user_id:
                continue
            if len(row) < 6:
                fail(f"users.csv 第 {user_id} 行列数不足")

            app_id = row[3].strip()
            app_secret = row[4].strip()
            owner_open_ids = row[5].strip()
            owner_open_id = owner_open_ids.split("|")[0].strip()

            if not app_id:
                fail(f"users.csv 第 {user_id} 行 feishu_app_id 为空")
            if not app_secret:
                fail(f"users.csv 第 {user_id} 行 feishu_app_secret 为空")
            if not owner_open_id:
                fail(f"users.csv 第 {user_id} 行 feishu_owner_open_id 为空")

            return app_id, app_secret, owner_open_id

    fail(f"users.csv 未找到 id={user_id} 的配置")


def mask_secret(value: str) -> str:
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def request_json(
    method: str,
    path: str,
    *,
    token: str | None = None,
    query: dict[str, str] | None = None,
    body: dict | None = None,
) -> dict:
    qs = urllib.parse.urlencode(query or {})
    url = f"{BASE_URL}{path}"
    if qs:
        url = f"{url}?{qs}"

    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url=url, data=data, method=method, headers=headers)

    http_status = None
    raw_text = ""
    transport_error = None

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            http_status = resp.status
            raw_text = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        http_status = e.code
        raw_text = e.read().decode("utf-8")
    except urllib.error.URLError as e:
        transport_error = str(e.reason)

    payload = None
    json_error = None
    if raw_text:
        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as e:
            json_error = str(e)

    api_code = None
    api_msg = None
    if isinstance(payload, dict):
        api_code = payload.get("code")
        api_msg = payload.get("msg")

    return {
        "method": method,
        "path": path,
        "url": url,
        "http_status": http_status,
        "payload": payload,
        "raw_text": raw_text,
        "json_error": json_error,
        "transport_error": transport_error,
        "api_code": api_code,
        "api_msg": api_msg,
    }


def classify_response(resp: dict) -> str:
    if resp["transport_error"] is not None:
        return "FAIL_TRANSPORT"
    if resp["api_code"] is None:
        return "FAIL_NON_JSON"
    if resp["api_code"] == 0:
        return "PASS"
    return "FAIL_API"


def extract_chat_id_from_create(resp: dict) -> str | None:
    payload = resp.get("payload")
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    chat_id = data.get("chat_id")
    return chat_id if isinstance(chat_id, str) else None


def extract_first_chat_id(resp: dict) -> str | None:
    payload = resp.get("payload")
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    items = data.get("items")
    if not isinstance(items, list) or not items:
        return None
    first = items[0]
    if not isinstance(first, dict):
        return None
    chat_id = first.get("chat_id")
    return chat_id if isinstance(chat_id, str) else None


def extract_message_id(resp: dict) -> str | None:
    payload = resp.get("payload")
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    message_id = data.get("message_id")
    return message_id if isinstance(message_id, str) else None


def extract_tab_id(resp: dict) -> str | None:
    payload = resp.get("payload")
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    chat_tabs = data.get("chat_tabs")
    if not isinstance(chat_tabs, list):
        return None
    for tab in chat_tabs:
        if not isinstance(tab, dict):
            continue
        tab_name = tab.get("tab_name")
        tab_id = tab.get("tab_id")
        if tab_name == "perm-test-tab" and isinstance(tab_id, str):
            return tab_id
    for tab in chat_tabs:
        if not isinstance(tab, dict):
            continue
        tab_id = tab.get("tab_id")
        if isinstance(tab_id, str):
            return tab_id
    return None


def add_case_from_response(
    cases: list[dict],
    *,
    scope: str,
    capability: str,
    endpoint: str,
    response: dict,
    note: str | None = None,
) -> None:
    cases.append(
        {
            "scope": scope,
            "capability": capability,
            "method": response["method"],
            "endpoint": endpoint,
            "http_status": response["http_status"],
            "api_code": response["api_code"],
            "api_msg": response["api_msg"],
            "status": classify_response(response),
            "note": note,
        }
    )


def add_skip_case(
    cases: list[dict],
    *,
    scope: str,
    capability: str,
    endpoint: str,
    status: str,
    note: str,
) -> None:
    cases.append(
        {
            "scope": scope,
            "capability": capability,
            "method": None,
            "endpoint": endpoint,
            "http_status": None,
            "api_code": None,
            "api_msg": None,
            "status": status,
            "note": note,
        }
    )


def aggregate_scope_status(cases: list[dict], scope: str) -> str:
    scope_cases = [c for c in cases if c["scope"] == scope]
    if not scope_cases:
        return "SKIP_NOT_PLANNED"

    statuses = {c["status"] for c in scope_cases}
    if "PASS" in statuses:
        return "PASS"
    if any(s.startswith("FAIL") for s in statuses):
        return "FAIL"
    return "SKIP"


def write_markdown(report: dict, path: pathlib.Path) -> None:
    lines: list[str] = []
    lines.append("# Feishu im:chat* 权限实验报告")
    lines.append("")
    lines.append(f"- 生成时间: {report['meta']['generated_at']}")
    lines.append(f"- 目标用户: {report['meta']['target_user_id']}")
    lines.append(f"- App ID: {report['meta']['app_id_masked']}")
    lines.append(f"- 临时测试群: {report['runtime']['temp_chat_id'] or '(未创建成功)'}")
    lines.append("")
    lines.append("## Scope 汇总")
    lines.append("")
    lines.append("| Scope | 总结状态 | 用例数 |")
    lines.append("|---|---|---:|")
    for row in report["scope_summary"]:
        lines.append(f"| `{row['scope']}` | `{row['status']}` | {row['case_count']} |")
    lines.append("")
    lines.append("## 用例明细")
    lines.append("")
    lines.append("| Scope | 能力 | 端点 | 状态 | code | msg | 备注 |")
    lines.append("|---|---|---|---|---:|---|---|")
    for c in report["cases"]:
        code = "" if c["api_code"] is None else str(c["api_code"])
        msg = "" if c["api_msg"] is None else str(c["api_msg"]).replace("\n", " ")
        note = "" if c["note"] is None else str(c["note"]).replace("\n", " ")
        endpoint = c["endpoint"].replace("|", "\\|")
        capability = c["capability"].replace("|", "\\|")
        lines.append(
            f"| `{c['scope']}` | {capability} | `{endpoint}` | `{c['status']}` | {code} | {msg} | {note} |"
        )
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 4:
        fail("参数错误: 需要 CSV_PATH REPORT_JSON REPORT_MD")

    csv_path = pathlib.Path(sys.argv[1])
    report_json_path = pathlib.Path(sys.argv[2])
    report_md_path = pathlib.Path(sys.argv[3])

    app_id, app_secret, owner_open_id = load_user_credentials(csv_path, TARGET_USER_ID)
    cases: list[dict] = []

    auth_resp = request_json(
        "POST",
        "/auth/v3/tenant_access_token/internal",
        body={"app_id": app_id, "app_secret": app_secret},
    )
    if classify_response(auth_resp) != "PASS":
        add_case_from_response(
            cases,
            scope="im:chat",
            capability="获取 tenant_access_token",
            endpoint="/auth/v3/tenant_access_token/internal",
            response=auth_resp,
            note="鉴权失败，后续测试未执行",
        )

        report = {
            "meta": {
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "target_user_id": TARGET_USER_ID,
                "app_id_masked": mask_secret(app_id),
                "owner_open_id_masked": mask_secret(owner_open_id),
            },
            "runtime": {
                "temp_chat_id": None,
                "probe_chat_id": None,
                "token_obtained": False,
            },
            "cases": cases,
            "scope_summary": [
                {"scope": scope, "status": aggregate_scope_status(cases, scope), "case_count": len([c for c in cases if c["scope"] == scope])}
                for scope in ALL_SCOPES
            ],
        }
        report_json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        write_markdown(report, report_md_path)
        fail("获取 tenant_access_token 失败，已输出报告")

    token = auth_resp["payload"]["tenant_access_token"]

    list_chats_resp = request_json("GET", "/im/v1/chats", token=token, query={"page_size": "20"})
    add_case_from_response(
        cases,
        scope="im:chat:readonly",
        capability="获取用户或机器人所在的群列表",
        endpoint="/im/v1/chats",
        response=list_chats_resp,
    )

    first_chat_id = extract_first_chat_id(list_chats_resp)

    create_chat_resp = request_json(
        "POST",
        "/im/v1/chats",
        token=token,
        query={"user_id_type": "open_id"},
        body={
            "name": f"im-chat-perm-test-{dt.datetime.now().strftime('%H%M%S')}",
            "description": "im:chat permission test",
            "chat_type": "private",
            "chat_mode": "group",
        },
    )
    add_case_from_response(
        cases,
        scope="im:chat:create",
        capability="创建群",
        endpoint="/im/v1/chats",
        response=create_chat_resp,
    )

    temp_chat_id = extract_chat_id_from_create(create_chat_resp)
    probe_chat_id = temp_chat_id if temp_chat_id else first_chat_id

    if probe_chat_id:
        get_chat_resp = request_json(
            "GET",
            f"/im/v1/chats/{probe_chat_id}",
            token=token,
            query={"user_id_type": "open_id"},
        )
        add_case_from_response(
            cases,
            scope="im:chat:read",
            capability="获取群信息",
            endpoint="/im/v1/chats/{chat_id}",
            response=get_chat_resp,
        )
    else:
        add_skip_case(
            cases,
            scope="im:chat:read",
            capability="获取群信息",
            endpoint="/im/v1/chats/{chat_id}",
            status="SKIP_DEPENDENCY",
            note="没有可用 chat_id（建群失败且群列表为空）",
        )

    if temp_chat_id:
        update_chat_resp = request_json(
            "PUT",
            f"/im/v1/chats/{temp_chat_id}",
            token=token,
            query={"user_id_type": "open_id"},
            body={"name": f"perm-updated-{dt.datetime.now().strftime('%H%M%S')}"},
        )
        add_case_from_response(
            cases,
            scope="im:chat:update",
            capability="更新群信息",
            endpoint="/im/v1/chats/{chat_id}",
            response=update_chat_resp,
        )

        owner_update_resp = request_json(
            "PUT",
            f"/im/v1/chats/{temp_chat_id}",
            token=token,
            query={"user_id_type": "open_id"},
            body={"description": "operate_as_owner probe"},
        )
        add_case_from_response(
            cases,
            scope="im:chat:operate_as_owner",
            capability="更新应用创建群的信息",
            endpoint="/im/v1/chats/{chat_id}",
            response=owner_update_resp,
            note="该用例在应用创建群中执行，用于探测 owner 相关权限",
        )
    else:
        add_skip_case(
            cases,
            scope="im:chat:update",
            capability="更新群信息",
            endpoint="/im/v1/chats/{chat_id}",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行写操作",
        )
        add_skip_case(
            cases,
            scope="im:chat:operate_as_owner",
            capability="更新应用创建群的信息",
            endpoint="/im/v1/chats/{chat_id}",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行 owner 场景",
        )

    if probe_chat_id:
        members_read_resp = request_json(
            "GET",
            f"/im/v1/chats/{probe_chat_id}/members",
            token=token,
            query={"member_id_type": "open_id", "page_size": "20"},
        )
        add_case_from_response(
            cases,
            scope="im:chat.members:read",
            capability="获取群成员列表",
            endpoint="/im/v1/chats/{chat_id}/members",
            response=members_read_resp,
        )

        is_in_chat_resp = request_json(
            "GET",
            f"/im/v1/chats/{probe_chat_id}/members/is_in_chat",
            token=token,
        )
        add_case_from_response(
            cases,
            scope="im:chat.members:bot_access",
            capability="判断用户或机器人是否在群里",
            endpoint="/im/v1/chats/{chat_id}/members/is_in_chat",
            response=is_in_chat_resp,
        )

        moderation_read_resp = request_json(
            "GET",
            f"/im/v1/chats/{probe_chat_id}/moderation",
            token=token,
            query={"user_id_type": "open_id", "page_size": "20"},
        )
        add_case_from_response(
            cases,
            scope="im:chat.moderation:read",
            capability="获取群成员发言权限",
            endpoint="/im/v1/chats/{chat_id}/moderation",
            response=moderation_read_resp,
        )

        announcement_read_resp = request_json(
            "GET",
            f"/im/v1/chats/{probe_chat_id}/announcement",
            token=token,
        )
        add_case_from_response(
            cases,
            scope="im:chat.announcement:read",
            capability="获取群公告信息",
            endpoint="/im/v1/chats/{chat_id}/announcement",
            response=announcement_read_resp,
        )

        menu_tree_read_resp = request_json(
            "GET",
            f"/im/v1/chats/{probe_chat_id}/menu_tree",
            token=token,
        )
        add_case_from_response(
            cases,
            scope="im:chat.menu_tree:read",
            capability="获取群菜单",
            endpoint="/im/v1/chats/{chat_id}/menu_tree",
            response=menu_tree_read_resp,
        )
    else:
        add_skip_case(
            cases,
            scope="im:chat.members:read",
            capability="获取群成员列表",
            endpoint="/im/v1/chats/{chat_id}/members",
            status="SKIP_DEPENDENCY",
            note="没有可用 chat_id",
        )
        add_skip_case(
            cases,
            scope="im:chat.members:bot_access",
            capability="判断用户或机器人是否在群里",
            endpoint="/im/v1/chats/{chat_id}/members/is_in_chat",
            status="SKIP_DEPENDENCY",
            note="没有可用 chat_id",
        )
        add_skip_case(
            cases,
            scope="im:chat.moderation:read",
            capability="获取群成员发言权限",
            endpoint="/im/v1/chats/{chat_id}/moderation",
            status="SKIP_DEPENDENCY",
            note="没有可用 chat_id",
        )
        add_skip_case(
            cases,
            scope="im:chat.announcement:read",
            capability="获取群公告信息",
            endpoint="/im/v1/chats/{chat_id}/announcement",
            status="SKIP_DEPENDENCY",
            note="没有可用 chat_id",
        )
        add_skip_case(
            cases,
            scope="im:chat.menu_tree:read",
            capability="获取群菜单",
            endpoint="/im/v1/chats/{chat_id}/menu_tree",
            status="SKIP_DEPENDENCY",
            note="没有可用 chat_id",
        )

    member_add_ok = False
    if temp_chat_id:
        members_add_resp = request_json(
            "POST",
            f"/im/v1/chats/{temp_chat_id}/members",
            token=token,
            query={"member_id_type": "open_id"},
            body={"id_list": [owner_open_id]},
        )
        add_case_from_response(
            cases,
            scope="im:chat.members:write_only",
            capability="将用户拉入群聊",
            endpoint="/im/v1/chats/{chat_id}/members",
            response=members_add_resp,
        )
        member_add_ok = classify_response(members_add_resp) == "PASS"
    else:
        add_skip_case(
            cases,
            scope="im:chat.members:write_only",
            capability="将用户拉入群聊",
            endpoint="/im/v1/chats/{chat_id}/members",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行",
        )

    if temp_chat_id and member_add_ok:
        managers_add_resp = request_json(
            "POST",
            f"/im/v1/chats/{temp_chat_id}/managers/add_managers",
            token=token,
            body={"manager_ids": [owner_open_id]},
        )
        add_case_from_response(
            cases,
            scope="im:chat.managers:write_only",
            capability="指定群管理员",
            endpoint="/im/v1/chats/{chat_id}/managers/add_managers",
            response=managers_add_resp,
        )

        members_remove_resp = request_json(
            "DELETE",
            f"/im/v1/chats/{temp_chat_id}/members",
            token=token,
            query={"member_id_type": "open_id"},
            body={"id_list": [owner_open_id]},
        )
        add_case_from_response(
            cases,
            scope="im:chat.members:write_only",
            capability="将用户移出群聊",
            endpoint="/im/v1/chats/{chat_id}/members",
            response=members_remove_resp,
        )
    elif temp_chat_id:
        add_skip_case(
            cases,
            scope="im:chat.managers:write_only",
            capability="指定群管理员",
            endpoint="/im/v1/chats/{chat_id}/managers/add_managers",
            status="SKIP_DEPENDENCY",
            note="拉人失败，无法测试管理员写权限",
        )
        add_skip_case(
            cases,
            scope="im:chat.members:write_only",
            capability="将用户移出群聊",
            endpoint="/im/v1/chats/{chat_id}/members",
            status="SKIP_DEPENDENCY",
            note="拉人失败，跳过移除成员测试",
        )
    else:
        add_skip_case(
            cases,
            scope="im:chat.managers:write_only",
            capability="指定群管理员",
            endpoint="/im/v1/chats/{chat_id}/managers/add_managers",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行",
        )
        add_skip_case(
            cases,
            scope="im:chat.members:write_only",
            capability="将用户移出群聊",
            endpoint="/im/v1/chats/{chat_id}/members",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行",
        )

    tab_id = None
    if temp_chat_id:
        tabs_add_resp = request_json(
            "POST",
            f"/im/v1/chats/{temp_chat_id}/chat_tabs",
            token=token,
            body={
                "chat_tabs": [
                    {
                        "tab_name": "perm-test-tab",
                        "tab_type": "url",
                        "tab_content": {"url": "https://open.feishu.cn"},
                    }
                ]
            },
        )
        add_case_from_response(
            cases,
            scope="im:chat.tabs:write_only",
            capability="添加会话标签页",
            endpoint="/im/v1/chats/{chat_id}/chat_tabs",
            response=tabs_add_resp,
        )
        if classify_response(tabs_add_resp) == "PASS":
            tab_id = extract_tab_id(tabs_add_resp)

        if tab_id:
            tabs_delete_resp = request_json(
                "DELETE",
                f"/im/v1/chats/{temp_chat_id}/chat_tabs/delete_tabs",
                token=token,
                body={"tab_ids": [tab_id]},
            )
            add_case_from_response(
                cases,
                scope="im:chat.tabs:write_only",
                capability="删除会话标签页",
                endpoint="/im/v1/chats/{chat_id}/chat_tabs/delete_tabs",
                response=tabs_delete_resp,
            )
        else:
            add_skip_case(
                cases,
                scope="im:chat.tabs:write_only",
                capability="删除会话标签页",
                endpoint="/im/v1/chats/{chat_id}/chat_tabs/delete_tabs",
                status="SKIP_DEPENDENCY",
                note="未拿到 tab_id，跳过删除测试",
            )
    else:
        add_skip_case(
            cases,
            scope="im:chat.tabs:write_only",
            capability="添加会话标签页",
            endpoint="/im/v1/chats/{chat_id}/chat_tabs",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行",
        )
        add_skip_case(
            cases,
            scope="im:chat.tabs:write_only",
            capability="删除会话标签页",
            endpoint="/im/v1/chats/{chat_id}/chat_tabs/delete_tabs",
            status="SKIP_DEPENDENCY",
            note="建群失败，无法执行",
        )

    message_id = None
    if temp_chat_id:
        send_msg_resp = request_json(
            "POST",
            "/im/v1/messages",
            token=token,
            query={"receive_id_type": "chat_id"},
            body={
                "receive_id": temp_chat_id,
                "msg_type": "text",
                "content": json.dumps({"text": "pin/top_notice permission test"}, ensure_ascii=False),
            },
        )
        if classify_response(send_msg_resp) == "PASS":
            message_id = extract_message_id(send_msg_resp)

    if message_id:
        pin_resp = request_json(
            "POST",
            "/im/v1/pins",
            token=token,
            body={"message_id": message_id},
        )
        add_case_from_response(
            cases,
            scope="im:chat.chat_pins:write_only",
            capability="Pin 消息",
            endpoint="/im/v1/pins",
            response=pin_resp,
        )

        unpin_resp = request_json(
            "DELETE",
            f"/im/v1/pins/{message_id}",
            token=token,
        )
        add_case_from_response(
            cases,
            scope="im:chat.chat_pins:write_only",
            capability="移除 Pin 消息",
            endpoint="/im/v1/pins/{message_id}",
            response=unpin_resp,
        )

        top_notice_put_resp = request_json(
            "POST",
            f"/im/v1/chats/{temp_chat_id}/top_notice/put_top_notice",
            token=token,
            body={
                "chat_top_notice": [
                    {
                        "action_type": "1",
                        "message_id": message_id,
                    }
                ]
            },
        )
        add_case_from_response(
            cases,
            scope="im:chat.top_notice:write_only",
            capability="更新群顶部置顶（message）",
            endpoint="/im/v1/chats/{chat_id}/top_notice/put_top_notice",
            response=top_notice_put_resp,
        )

        top_notice_delete_resp = request_json(
            "POST",
            f"/im/v1/chats/{temp_chat_id}/top_notice/delete_top_notice",
            token=token,
        )
        add_case_from_response(
            cases,
            scope="im:chat.top_notice:write_only",
            capability="撤销群顶部置顶",
            endpoint="/im/v1/chats/{chat_id}/top_notice/delete_top_notice",
            response=top_notice_delete_resp,
        )
    else:
        add_skip_case(
            cases,
            scope="im:chat.chat_pins:write_only",
            capability="Pin/Unpin 消息",
            endpoint="/im/v1/pins",
            status="SKIP_DEPENDENCY",
            note="缺少可用 message_id（发送消息失败或无权限）",
        )
        add_skip_case(
            cases,
            scope="im:chat.top_notice:write_only",
            capability="更新/撤销群顶部置顶",
            endpoint="/im/v1/chats/{chat_id}/top_notice/*",
            status="SKIP_DEPENDENCY",
            note="缺少可用 message_id（发送消息失败或无权限）",
        )

    add_skip_case(
        cases,
        scope="im:chat:moderation:write_only",
        capability="更新群发言权限",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="官方写接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.announcement:write_only",
        capability="更新群公告信息",
        endpoint="/im/v1/chats/{chat_id}/announcement",
        status="SKIP_UNMAPPED",
        note="需要有效 revision + 文档结构 requests，当前脚本不做非确定性构造",
    )
    add_skip_case(
        cases,
        scope="im:chat.chat_pins:read",
        capability="读取群置顶消息列表",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="官方读取接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.menu_tree:write_only",
        capability="创建/更新/删除/排序群菜单",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="写接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.tabs:read",
        capability="拉取会话标签页",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="读取接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.widgets:read",
        capability="读取群小组件",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="官方接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.widgets:write_only",
        capability="创建/更新/删除群小组件",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="官方接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.collab_plugins:read",
        capability="读取协作插件配置",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="官方接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.collab_plugins:write_only",
        capability="修改协作插件配置",
        endpoint="UNMAPPED",
        status="SKIP_UNMAPPED",
        note="官方接口路径未完成稳定映射",
    )
    add_skip_case(
        cases,
        scope="im:chat.access_event.bot_p2p_chat:read",
        capability="读取 bot_p2p_chat access event",
        endpoint="EVENT_ONLY",
        status="SKIP_EVENT_ONLY",
        note="该权限是事件订阅类型，不是同步 OpenAPI 拉取接口",
    )

    if temp_chat_id:
        delete_chat_resp = request_json(
            "DELETE",
            f"/im/v1/chats/{temp_chat_id}",
            token=token,
        )
        add_case_from_response(
            cases,
            scope="im:chat:delete",
            capability="解散群",
            endpoint="/im/v1/chats/{chat_id}",
            response=delete_chat_resp,
            note="清理临时测试群",
        )
    else:
        add_skip_case(
            cases,
            scope="im:chat:delete",
            capability="解散群",
            endpoint="/im/v1/chats/{chat_id}",
            status="SKIP_DEPENDENCY",
            note="建群失败，无需解散",
        )

    add_skip_case(
        cases,
        scope="im:chat",
        capability="聚合能力（读+更）",
        endpoint="AGGREGATED",
        status="SKIP_INCONCLUSIVE",
        note="当前结果无法把 im:chat 与 im:chat:create 的授权缺口做单独归因",
    )

    scope_summary = []
    for scope in ALL_SCOPES:
        scope_cases = [c for c in cases if c["scope"] == scope]
        scope_summary.append(
            {
                "scope": scope,
                "status": aggregate_scope_status(cases, scope),
                "case_count": len(scope_cases),
            }
        )

    report = {
        "meta": {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "target_user_id": TARGET_USER_ID,
            "app_id_masked": mask_secret(app_id),
            "owner_open_id_masked": mask_secret(owner_open_id),
        },
        "runtime": {
            "temp_chat_id": temp_chat_id,
            "probe_chat_id": probe_chat_id,
            "token_obtained": True,
        },
        "cases": cases,
        "scope_summary": scope_summary,
    }

    report_json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(report, report_md_path)

    print(f"报告已生成: {report_json_path}")
    print(f"报告已生成: {report_md_path}")


if __name__ == "__main__":
    main()
PY

echo "Done. Reports in: $REPORT_DIR"
