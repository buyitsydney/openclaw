#!/usr/bin/env python3
"""WebSocket Proxy Server for Gemini Live API with Static File Serving
Handles authentication, proxies WebSocket connections, and serves HTML/JS files

This server acts as a bridge between the browser client and Gemini API,
handling Google Cloud authentication automatically using default credentials.
"""

import asyncio
import json
import mimetypes
import os
import ssl
import time
from pathlib import Path

import certifi

# Google auth imports
import google.auth
import websockets
from aiohttp import web
from google.auth.transport.requests import Request
from websockets.exceptions import ConnectionClosed
from websockets.legacy.protocol import WebSocketCommonProtocol
from websockets.legacy.server import WebSocketServerProtocol

DEBUG = False  # Set to True for verbose logging
HTTP_PORT = 8000  # Port for HTTP server
WS_PORT = 8080  # Port for WebSocket server

# Set LIVE_GEMINI_LOG=0 to disable markdown logging (improves realtime audio smoothness).
ENABLE_MARKDOWN_LOGS = os.environ.get("LIVE_GEMINI_LOG", "1").strip() not in ("0", "false", "False", "no", "NO")


def _resolve_repo_root() -> Path:
    """Resolve repo root by walking up for .git directory."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / ".git").exists():
            return parent
    # Expected layout: <repo>/extensions/realtime/live-frontend/server.py
    return here.parents[4]


def _sanitize_for_logging(obj):
    """Return a JSON-serializable object safe for local logs."""
    if isinstance(obj, dict):
        # Common pattern for blobs in both directions.
        # Keep mime type but omit potentially huge base64 payloads.
        if (
            ("data" in obj)
            and (("mime_type" in obj) or ("mimeType" in obj))
            and isinstance(obj.get("data"), str)
        ):
            mime = obj.get("mime_type") or obj.get("mimeType")
            data = obj.get("data")
            return {
                **{k: v for k, v in obj.items() if k not in ("data",)},
                "data": f"<{len(data)} chars base64 omitted>",
                "mime_type": mime if "mime_type" in obj else None,
                "mimeType": mime if "mimeType" in obj else None,
            }

        out = {}
        for k, v in obj.items():
            # Never log tokens.
            if k in ("bearer_token", "Authorization", "authorization"):
                out[k] = "<redacted>"
                continue

            # Audio chunks can be huge; replace with a small summary.
            if k == "realtime_input" and isinstance(v, dict):
                media_chunks = v.get("media_chunks")
                if isinstance(media_chunks, list):
                    summarized = []
                    for chunk in media_chunks:
                        if not isinstance(chunk, dict):
                            summarized.append("<non-dict chunk>")
                            continue
                        data = chunk.get("data")
                        summarized.append(
                            {
                                "mime_type": chunk.get("mime_type"),
                                "data": f"<{len(data)} chars base64 omitted>"
                                if isinstance(data, str)
                                else "<non-string>",
                            }
                        )
                    out[k] = {"media_chunks": summarized}
                    continue

            out[k] = _sanitize_for_logging(v)
        return out

    if isinstance(obj, list):
        return [_sanitize_for_logging(v) for v in obj]

    return obj


def _classify_message(data: dict) -> str:
    if "setup" in data:
        return "setup"
    if "client_content" in data:
        return "client_content"
    if "tool_response" in data:
        return "tool_response"
    if "realtime_input" in data:
        return "realtime_input"
    if "service_url" in data:
        return "service_setup"
    return "unknown"


def _extract_human_summary(data: dict) -> str:
    kind = _classify_message(data)

    if kind == "setup":
        setup = data.get("setup", {}) if isinstance(data.get("setup"), dict) else {}
        sys_inst = setup.get("system_instruction", {})
        parts = sys_inst.get("parts") if isinstance(sys_inst, dict) else None
        sys_text = ""
        if isinstance(parts, list) and parts and isinstance(parts[0], dict):
            sys_text = parts[0].get("text") or ""

        tools = setup.get("tools", {})
        decls = tools.get("function_declarations") if isinstance(tools, dict) else None
        decl_count = len(decls) if isinstance(decls, list) else 0
        model = setup.get("model") or ""

        return "\n".join(
            [
                f"- model: {model}",
                f"- function_declarations: {decl_count}",
                "",
                "## system_instruction (text)",
                sys_text,
            ]
        ).strip()

    if kind == "client_content":
        cc = (
            data.get("client_content", {})
            if isinstance(data.get("client_content"), dict)
            else {}
        )
        turns = cc.get("turns") if isinstance(cc.get("turns"), list) else []
        texts = []
        for t in turns:
            if not isinstance(t, dict):
                continue
            parts = t.get("parts") if isinstance(t.get("parts"), list) else []
            for p in parts:
                if isinstance(p, dict) and isinstance(p.get("text"), str):
                    texts.append(p["text"])
        return "\n".join(["## client_content (texts)", *texts]).strip()

    if kind == "tool_response":
        tr = (
            data.get("tool_response", {})
            if isinstance(data.get("tool_response"), dict)
            else {}
        )
        fr = tr.get("functionResponses") if isinstance(tr.get("functionResponses"), list) else []
        lines = ["## tool_response (functionResponses)"]
        for r in fr:
            if not isinstance(r, dict):
                continue
            rid = r.get("id")
            name = r.get("name")
            response = r.get("response")
            lines.append(f"- id={rid} name={name}")
            if isinstance(response, dict) and "result" in response:
                lines.append("")
                lines.append("### result")
                lines.append(str(response.get("result")))
        return "\n".join(lines).strip()

    if kind == "service_setup":
        url = data.get("service_url")
        return "\n".join(["## service_setup", f"- service_url: {url}"]).strip()

    if kind == "realtime_input":
        return "## realtime_input\n(audio omitted)"

    return "## unknown"


def _append_markdown_log(conn_id: str, data: dict, meta=None) -> None:
    if not ENABLE_MARKDOWN_LOGS:
        return
    repo_root = _resolve_repo_root()
    log_dir = repo_root / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "live-gemini-input.md"
    # Also write to unified log
    unified_log_path = log_dir / "live-gemini.md"

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())
    kind = _classify_message(data)

    sanitized = _sanitize_for_logging(data)
    raw_json = json.dumps(sanitized, ensure_ascii=False, indent=2)
    summary = _extract_human_summary(data)

    meta = meta or {}
    meta_lines = []
    if "proxy_handle_ms" in meta:
        meta_lines.append(f"- proxy_handle_ms: {meta.get('proxy_handle_ms')}")
    if "payload" in meta:
        meta_lines.append(f"- payload: {meta.get('payload')}")

    entry = "\n".join(
        [
            "",
            "---",
            "# live_gemini_input",
            "",
            f"- ts: {now_iso}",
            f"- conn: {conn_id}",
            f"- dir: LIVE→GEMINI",
            f"- kind: {kind}",
            *meta_lines,
            "",
            "## extracted",
            summary,
            "",
            "## raw_json (sanitized)",
            "```json",
            raw_json,
            "```",
            "",
        ]
    )

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(entry)
    # Write to unified log as well
    with open(unified_log_path, "a", encoding="utf-8") as f:
        f.write(entry)


def _classify_server_message(data: dict) -> str:
    if "setupComplete" in data:
        return "setupComplete"
    if "serverContent" in data:
        return "serverContent"
    if "toolCall" in data:
        return "toolCall"
    if "toolCallCancellation" in data:
        return "toolCallCancellation"
    if "goAway" in data:
        return "goAway"
    if "sessionResumptionUpdate" in data:
        return "sessionResumptionUpdate"
    if "usageMetadata" in data:
        return "usageMetadata"
    return "unknown"


def _extract_server_human_summary(data: dict) -> str:
    kind = _classify_server_message(data)

    if kind == "setupComplete":
        return "## setupComplete"

    if kind == "goAway":
        go = data.get("goAway", {}) if isinstance(data.get("goAway"), dict) else {}
        return "\n".join(["## goAway", f"- timeLeft: {go.get('timeLeft')}"]).strip()

    if kind == "toolCall":
        tc = data.get("toolCall", {}) if isinstance(data.get("toolCall"), dict) else {}
        calls = tc.get("functionCalls") if isinstance(tc.get("functionCalls"), list) else []
        lines = ["## toolCall (functionCalls)"]
        for c in calls:
            if not isinstance(c, dict):
                continue
            lines.append(f"- id={c.get('id')} name={c.get('name')}")
            args = c.get("args")
            if args is not None:
                try:
                    lines.append("```json")
                    lines.append(json.dumps(_sanitize_for_logging(args), ensure_ascii=False, indent=2))
                    lines.append("```")
                except Exception:
                    lines.append(str(args))
        return "\n".join(lines).strip()

    if kind == "serverContent":
        sc = data.get("serverContent", {}) if isinstance(data.get("serverContent"), dict) else {}
        lines = ["## serverContent"]

        for flag in ("interrupted", "generationComplete", "turnComplete"):
            if flag in sc:
                lines.append(f"- {flag}: {sc.get(flag)}")

        it = sc.get("inputTranscription")
        if isinstance(it, dict) and isinstance(it.get("text"), str):
            lines.append("")
            lines.append("### inputTranscription")
            lines.append(it.get("text") or "")
            if "finished" in it:
                lines.append(f"- finished: {it.get('finished')}")

        ot = sc.get("outputTranscription")
        if isinstance(ot, dict) and isinstance(ot.get("text"), str):
            lines.append("")
            lines.append("### outputTranscription")
            lines.append(ot.get("text") or "")
            if "finished" in ot:
                lines.append(f"- finished: {ot.get('finished')}")

        mt = sc.get("modelTurn")
        if isinstance(mt, dict):
            parts = mt.get("parts") if isinstance(mt.get("parts"), list) else []
            texts = []
            for p in parts:
                if isinstance(p, dict) and isinstance(p.get("text"), str) and p.get("text"):
                    texts.append(p["text"])
            if texts:
                lines.append("")
                lines.append("### modelTurn.text")
                lines.extend(texts)

        return "\n".join(lines).strip()

    return f"## {kind}"


def _append_markdown_log_output(conn_id: str, data: dict, meta=None) -> None:
    if not ENABLE_MARKDOWN_LOGS:
        return
    repo_root = _resolve_repo_root()
    log_dir = repo_root / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "live-gemini-output.md"
    # Also write to unified log
    unified_log_path = log_dir / "live-gemini.md"

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())
    kind = _classify_server_message(data)

    sanitized = _sanitize_for_logging(data)
    raw_json = json.dumps(sanitized, ensure_ascii=False, indent=2)
    summary = _extract_server_human_summary(data)

    meta = meta or {}
    meta_lines = []
    if "proxy_handle_ms" in meta:
        meta_lines.append(f"- proxy_handle_ms: {meta.get('proxy_handle_ms')}")
    if "payload" in meta:
        meta_lines.append(f"- payload: {meta.get('payload')}")

    # Check for RESPONSE_REJECTED
    sc = data.get("serverContent", {}) if isinstance(data.get("serverContent"), dict) else {}
    reject_reason = sc.get("turnCompleteReason")
    if reject_reason:
        meta_lines.append(f"- turnCompleteReason: {reject_reason}")

    entry = "\n".join(
        [
            "",
            "---",
            "# live_gemini_output",
            "",
            f"- ts: {now_iso}",
            f"- conn: {conn_id}",
            f"- dir: GEMINI→LIVE",
            f"- kind: {kind}",
            *meta_lines,
            "",
            "## extracted",
            summary,
            "",
            "## raw_json (sanitized)",
            "```json",
            raw_json,
            "```",
            "",
        ]
    )

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(entry)
    # Write to unified log as well
    with open(unified_log_path, "a", encoding="utf-8") as f:
        f.write(entry)


def generate_access_token():
    """Retrieves an access token using Google Cloud default credentials."""
    try:
        creds, _ = google.auth.default()
        if not creds.valid:
            creds.refresh(Request())
        return creds.token
    except Exception as e:
        print(f"Error generating access token: {e}")
        print("Make sure you're logged in with: gcloud auth application-default login")
        return None


async def proxy_task(
    source_websocket: WebSocketCommonProtocol,
    destination_websocket: WebSocketCommonProtocol,
    is_server: bool,
    conn_id: str,
) -> None:
    """Forwards messages from source_websocket to destination_websocket.

    Args:
        source_websocket: The WebSocket connection to receive messages from.
        destination_websocket: The WebSocket connection to send messages to.
        is_server: True if source is server side, False otherwise.
    """
    try:
        async for message in source_websocket:
            try:
                # Gemini may send either:
                # - JSON text frames (str)
                # - JSON binary frames (bytes) (some servers deliver JSON as binary)
                # - true binary media frames (bytes) (audio/video)
                #
                # Our browser demo expects JSON as text (string) and will JSON.parse(evt.data).
                # Therefore, if we receive bytes, we first try to decode+parse as JSON. Only if
                # that fails do we treat it as a binary media frame.
                if isinstance(message, (bytes, bytearray)):
                    recv_perf = time.perf_counter()
                    try:
                        text = message.decode("utf-8")
                        data = json.loads(text)
                        # Parsed JSON from bytes: handle like text frame below.
                        if isinstance(data, dict):
                            # IMPORTANT:
                            # Even when logging is "disabled", scheduling a thread per message
                            # can introduce jitter in the realtime audio path.
                            # Therefore, we must NOT call asyncio.to_thread unless logging is enabled.
                            if ENABLE_MARKDOWN_LOGS:
                                pre_send_perf = time.perf_counter()
                                meta = {
                                    "proxy_handle_ms": round(
                                        (pre_send_perf - recv_perf) * 1000, 3
                                    ),
                                    "payload": "bytes(json)",
                                }
                                if is_server:
                                    await asyncio.to_thread(
                                        _append_markdown_log_output, conn_id, data, meta
                                    )
                                else:
                                    kind = _classify_message(data)
                                    if kind != "realtime_input":
                                        await asyncio.to_thread(
                                            _append_markdown_log, conn_id, data, meta
                                        )
                        await destination_websocket.send(text)
                        continue
                    except Exception:
                        # True binary media frame: forward as-is.
                        await destination_websocket.send(message)
                        continue

                # Text frames should be JSON.
                recv_perf = time.perf_counter()
                data = json.loads(message)

                if DEBUG:
                    print(
                        f"Proxying from {'server' if is_server else 'client'}: {data}"
                    )

                if isinstance(data, dict):
                    if ENABLE_MARKDOWN_LOGS:
                        pre_send_perf = time.perf_counter()
                        meta = {
                            "proxy_handle_ms": round(
                                (pre_send_perf - recv_perf) * 1000, 3
                            ),
                            "payload": "text(json)",
                        }
                        if is_server:
                            # Log GEMINI->LIVE messages that contain transcripts / tool calls / turn flags.
                            await asyncio.to_thread(
                                _append_markdown_log_output, conn_id, data, meta
                            )
                        else:
                            # Log ONLY client->server messages (Live->Gemini inputs).
                            # Skip realtime_input audio chunks to keep logs human-readable and small.
                            kind = _classify_message(data)
                            if kind != "realtime_input":
                                await asyncio.to_thread(_append_markdown_log, conn_id, data, meta)

                # Forward original payload (preserve exact JSON casing/ordering).
                await destination_websocket.send(message)
            except Exception as e:
                print(f"Error processing message: {e}")
    except ConnectionClosed as e:
        print(
            f"{'Server' if is_server else 'Client'} connection closed: {e.code} - {e.reason}"
        )
    except Exception as e:
        print(f"Unexpected error in proxy_task: {e}")
    finally:
        await destination_websocket.close()


async def create_proxy(
    client_websocket: WebSocketCommonProtocol,
    bearer_token: str,
    service_url: str,
    conn_id: str,
) -> None:
    """Establishes a WebSocket connection to the Gemini server and creates bidirectional proxy.

    Args:
        client_websocket: The WebSocket connection of the client.
        bearer_token: The bearer token for authentication with the server.
        service_url: The url of the service to connect to.
    """
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {bearer_token}",
    }

    # Create SSL context with certifi certificates
    ssl_context = ssl.create_default_context(cafile=certifi.where())

    print("Connecting to Gemini API...")
    if DEBUG:
        print(f"Service URL: {service_url}")

    try:
        async with websockets.connect(
            service_url, additional_headers=headers, ssl=ssl_context
        ) as server_websocket:
            print("✅ Connected to Gemini API")

            # Create bidirectional proxy tasks
            client_to_server_task = asyncio.create_task(
                proxy_task(
                    client_websocket, server_websocket, is_server=False, conn_id=conn_id
                )
            )
            server_to_client_task = asyncio.create_task(
                proxy_task(
                    server_websocket, client_websocket, is_server=True, conn_id=conn_id
                )
            )

            # Wait for either task to complete
            done, pending = await asyncio.wait(
                [client_to_server_task, server_to_client_task],
                return_when=asyncio.FIRST_COMPLETED,
            )

            # Cancel the remaining task
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            # Close connections
            try:
                await server_websocket.close()
            except:
                pass

            try:
                await client_websocket.close()
            except:
                pass

    except ConnectionClosed as e:
        print(f"Server connection closed unexpectedly: {e.code} - {e.reason}")
        if not client_websocket.closed:
            await client_websocket.close(code=e.code, reason=e.reason)
    except Exception as e:
        print(f"Failed to connect to Gemini API: {e}")
        if not client_websocket.closed:
            await client_websocket.close(code=1008, reason="Upstream connection failed")


async def handle_websocket_client(client_websocket: WebSocketServerProtocol) -> None:
    """Handles a new WebSocket client connection.

    Expects first message with optional bearer_token and service_url.
    If no bearer_token provided, generates one using Google default credentials.

    Args:
        client_websocket: The WebSocket connection of the client.
    """
    print("🔌 New WebSocket client connection...")
    conn_id = f"conn-{int(time.time() * 1000)}"
    try:
        # Wait for the first message from the client
        service_setup_message = await asyncio.wait_for(
            client_websocket.recv(), timeout=10.0
        )
        service_setup_message_data = json.loads(service_setup_message)

        bearer_token = service_setup_message_data.get("bearer_token")
        service_url = service_setup_message_data.get("service_url")

        # Log initial service setup (token redacted).
        if isinstance(service_setup_message_data, dict):
            await asyncio.to_thread(
                _append_markdown_log, conn_id, service_setup_message_data
            )

        # If no bearer token provided, generate one using default credentials
        if not bearer_token:
            print("🔑 Generating access token using default credentials...")
            bearer_token = generate_access_token()
            if not bearer_token:
                print("❌ Failed to generate access token")
                await client_websocket.close(code=1008, reason="Authentication failed")
                return
            print("✅ Access token generated")

        if not service_url:
            print("❌ Error: Service URL is missing")
            await client_websocket.close(code=1008, reason="Service URL is required")
            return

        await create_proxy(client_websocket, bearer_token, service_url, conn_id=conn_id)

    except asyncio.TimeoutError:
        print("⏱️ Timeout waiting for the first message from the client")
        await client_websocket.close(code=1008, reason="Timeout")
    except json.JSONDecodeError as e:
        print(f"❌ Invalid JSON in first message: {e}")
        await client_websocket.close(code=1008, reason="Invalid JSON")
    except Exception as e:
        print(f"❌ Error handling client: {e}")
        if not client_websocket.closed:
            await client_websocket.close(code=1011, reason="Internal error")


# HTTP server for static files
async def serve_static_file(request):
    """Serve static files from the frontend directory."""
    path = request.match_info.get("path", "index.html")

    # Security: prevent directory traversal
    path = path.lstrip("/")
    if ".." in path:
        return web.Response(text="Invalid path", status=400)

    # Default to index.html
    if not path or path == "/":
        path = "index.html"

    # Get the full file path - serve from frontend folder
    frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
    file_path = os.path.join(frontend_dir, path)

    # Check if file exists
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        return web.Response(text="File not found", status=404)

    # Determine content type
    content_type, _ = mimetypes.guess_type(file_path)
    if content_type is None:
        content_type = "application/octet-stream"

    # Read and serve the file
    try:
        with open(file_path, "rb") as f:
            content = f.read()
        # Deterministic dev behavior: always fetch the latest frontend assets.
        # This avoids stale JS after refresh due to aggressive browser caching.
        headers = {
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        }
        return web.Response(body=content, content_type=content_type, headers=headers)
    except Exception as e:
        print(f"Error serving file {path}: {e}")
        return web.Response(text="Internal server error", status=500)


async def start_http_server():
    """Start the HTTP server for serving static files."""
    app = web.Application()
    app.router.add_get("/", serve_static_file)
    app.router.add_get("/{path:.*}", serve_static_file)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    print(f"🌐 HTTP server running on http://localhost:{HTTP_PORT}")


async def start_websocket_server():
    """Start the WebSocket proxy server."""
    async with websockets.serve(handle_websocket_client, "0.0.0.0", WS_PORT):
        print(f"🔌 WebSocket proxy running on ws://localhost:{WS_PORT}")
        # Run forever
        await asyncio.Future()


async def main():
    """Starts both HTTP and WebSocket servers."""
    print(f"""
╔════════════════════════════════════════════════════════════╗
║     Gemini Live API Proxy Server with Web Interface       ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  📱 Web Interface:   http://localhost:{HTTP_PORT:<5}                  ║
║  🔌 WebSocket Proxy: ws://localhost:{WS_PORT:<5}                   ║
║                                                            ║
║  Authentication:                                           ║
║  • Uses Google Cloud default credentials                  ║
║  • Run: gcloud auth application-default login             ║
║                                                            ║
║  Instructions:                                             ║
║  1. Open http://localhost:{HTTP_PORT} in your browser              ║
║  2. The proxy URL is pre-configured                       ║
║  3. Just click Connect to start!                          ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
""")

    # Start both servers concurrently
    await asyncio.gather(start_http_server(), start_websocket_server())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Servers stopped")
