"""Exercise real Hermes plugin / TCP / OMP with a loopback fixture provider.

Use --docker on the host to create a dedicated two-container Compose workspace.
Inside that workspace the provider is a local deterministic fixture, not an LLM.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import shlex
import sys
import tempfile
import uuid
import threading
import time


class FixtureProvider(BaseHTTPRequestHandler):
    requests = []
    hold = threading.Event()
    waiting = threading.Event()

    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "fixture", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(request)
        messages = request["messages"]
        user_index = max((i for i, message in enumerate(messages) if message["role"] == "user"), default=len(messages) - 1)
        user = messages[user_index]["content"]
        text = user if isinstance(user, str) else json.dumps(user)
        tool_done = any(message["role"] == "tool" for message in messages[user_index + 1:])
        if "SMOKE_HOLD" in text and not tool_done:
            self.waiting.set()
            self.hold.wait(20)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            calls = []
            if not tool_done:
                if "SMOKE_ASK" in text:
                    calls = [("ask", {"questions": [{"id": "smoke", "question": "Choose smoke action", "options": [{"label": "Proceed"}, {"label": "Cancel"}]}]})]
                elif "SMOKE_BACKGROUND" in text:
                    calls = [("bash", {"command": "sleep 2; printf BACKGROUND_FINISHED", "async": True, "timeout": 10})]
                elif "SMOKE_HOST_URI" in text:
                    calls = [("read", {"path": "smokefile://project/input.txt"}),
                             ("write", {"path": "smokefile://project/output.txt", "content": "HOST_URI_WRITTEN"})]
                elif "SMOKE_HOST_TOOL" in text:
                    names = {tool["function"]["name"] for tool in request.get("tools", [])}
                    calls = [("echo_host", {"message": "HOST_MESSAGE"})] if "echo_host" in names else [
                        ("write", {"path": "xd://echo_host", "content": json.dumps({"message": "HOST_MESSAGE"})})]
                elif "SMOKE_SKILL_READ" in text:
                    name = next(name for name in ("omp-video-pipeline", "omp-storybook-pipeline", "create-static-assets")
                                if f"SMOKE_SKILL_READ {name}" in text)
                    calls = [("read", {"path": f"skill://{name}"})]
            if calls:
                self.chunk({"tool_calls": [
                    {"index": index, "id": f"smoke_tool_{index}", "type": "function",
                     "function": {"name": name, "arguments": json.dumps(args)}}
                    for index, (name, args) in enumerate(calls)
                ]})
                self.chunk({}, "tool_calls")
            else:
                self.chunk({"role": "assistant", "content": "User choice received." if tool_done else "Executor response received."})
                self.chunk({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def chunk(self, delta, finish=None):
        frame = {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "fixture", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
        self.wfile.flush()


def eventually(read, accept, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if accept(value):
            return value
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for executor state: {value}")


def main():
    if os.environ.get("OMP_EXECUTOR_SMOKE") != "1":
        raise RuntimeError("Run with --docker; the fixture requires a dedicated test worker")
    from hermes_cli.plugins import get_plugin_manager
    from tools.registry import registry

    provider = ThreadingHTTPServer(("0.0.0.0", 9877), FixtureProvider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    manager = get_plugin_manager()
    manager.discover_and_load()
    for tool in ("omp_sessions", "omp_open", "omp_rpc", "omp_events", "omp_respond", "omp_close"):
        assert registry.get_entry(tool), manager.list_plugins()
    import tools.skills_tool
    listed = json.loads(registry.dispatch("skills_list", {}))
    assert listed.get("success") is True, f"skills_list dispatch failed: {listed}"
    discovered_names = {s["name"] for s in listed.get("skills", [])}
    for req_skill in ("omp-orchestrator", "omp-video"):
        assert req_skill in discovered_names, (
            f"Hermes skills_list missing {req_skill}. Discovered: {discovered_names}"
        )
    for req_skill in ("omp-orchestrator", "omp-video"):
        view = json.loads(registry.dispatch("skill_view", {"name": req_skill}))
        assert view.get("success") is True, f"skill_view failed for {req_skill}: {view}"
        assert view.get("name") == req_skill, view
        content = view.get("content", "")
        assert isinstance(content, str) and len(content) > 100 and req_skill in content, (
            f"skill_view content invalid for {req_skill}: {content[:100]}"
        )
    print("PASS Hermes runtime skills discovered and read via native skills_list and skill_view tools: omp-orchestrator, omp-video")
    cursors, history = {}, {}
    commands_seen = set()

    def call(tool, args=None, session="smoke-a", require_ok=True):
        response = registry.dispatch(tool, args or {}, session_id=session)
        result = json.loads(response) if isinstance(response, str) else response
        if require_ok:
            assert result.get("ok"), result
        return result

    def collect(session="smoke-a", executor="default"):
        key = session, executor
        result = call("omp_events", {"executor": executor, "after": cursors.get(key, 0), "limit": 1000}, session)
        assert not result.get("overflow"), result
        cursors[key] = result["next_cursor"]
        history.setdefault(key, []).extend(record["event"] for record in result["events"])
        return result

    def frame(request_id, frame_type="response", session="smoke-a", executor="default", timeout=30):
        def read():
            collect(session, executor)
            return next((event for event in history[session, executor]
                         if event.get("id") == request_id and event.get("type") == frame_type), None)
        return eventually(read, lambda event: event is not None, timeout)

    def submit(command, params=None, session="smoke-a", executor="default"):
        commands_seen.add(command)
        return call("omp_rpc", {"executor": executor, "command": command, "params": params or {}}, session)["request_id"]

    def rpc(command, params=None, session="smoke-a", executor="default", success=True):
        response = frame(submit(command, params, session, executor), session=session, executor=executor)
        assert response["success"] is success, response
        return (response.get("data") or {}) if success else response

    def state(session="smoke-a", executor="default"):
        return rpc("get_state", session=session, executor=executor)

    def settled(session="smoke-a", executor="default"):
        return eventually(lambda: state(session, executor), lambda value: value["isSettled"])

    def prompt(message, session="smoke-a", executor="default"):
        request_id = submit("prompt", {"message": message}, session, executor)
        assert frame(request_id, session=session, executor=executor)["success"]
        result = frame(request_id, "prompt_result", session, executor)
        assert result["status"] == "completed", result
        settled(session, executor)
        return request_id, result

    def open_session(mode, session="smoke-a", executor="default", **selector):
        result = call("omp_open", {"executor": executor, "mode": mode,
                                 "model": "smoke/fixture", "thinking": "off", **selector}, session)
        cursors.pop((session, executor), None)
        history.pop((session, executor), None)
        return result

    def pending(kind, session="smoke-a"):
        result = eventually(lambda: collect(session),
                            lambda value: any(request["type"] == kind for request in value["pending_requests"]))
        return next(request for request in result["pending_requests"] if request["type"] == kind)

    try:
        missing = registry.dispatch("omp_open", {"mode": "new"})
        missing = json.loads(missing) if isinstance(missing, str) else missing
        assert not missing.get("ok"), missing
        assert not call("omp_rpc", {"command": "get_state"}, require_ok=False).get("ok")
        open_session("new")
        prompt("SMOKE_SESSION_A")
        session_a = state()
        rpc("set_session_name", {"name": "Chosen session A"})
        assert state()["sessionName"] == "Chosen session A"
        rpc("set_model", {"provider": "smoke", "modelId": "fixture-alt"})
        rpc("set_thinking_level", {"level": "low"})
        manager.invoke_hook("on_session_end", session_id="smoke-a", completed=True, interrupted=False)
        assert state()["sessionId"] == session_a["sessionId"], "Ordinary turn end closed executor"
        assert not call("omp_events", session="smoke-b")["running"], "Live handle leaked across conversations"
        rpc("new_session")
        rpc("set_model", {"provider": "smoke", "modelId": "fixture"})
        rpc("set_thinking_level", {"level": "off"})
        prompt("SMOKE_SESSION_B")
        session_b = state()
        assert session_b["sessionId"] != session_a["sessionId"]
        native_dir = "/home/worker/.omp/agent/sessions/smoke-native"
        opened_native = rpc("open_session", {"sessionDir": native_dir})
        assert opened_native["resumed"] is False, opened_native
        prompt("SMOKE_NATIVE_ROOT")
        native_session = state()
        assert native_session["sessionFile"].startswith(native_dir + "/")
        catalog = call("omp_sessions")
        indexed = {session["session_id"]: session for session in catalog["sessions"]}
        assert {session_a["sessionId"], session_b["sessionId"], native_session["sessionId"]} <= indexed.keys(), catalog
        assert indexed[session_a["sessionId"]]["session_file"] == session_a["sessionFile"]
        assert indexed[session_a["sessionId"]]["name"] == "Chosen session A", indexed
        first_page = call("omp_sessions", {"limit": 1})
        second_page = call("omp_sessions", {"limit": 1, "offset": 1})
        assert first_page["sessions"][0]["session_id"] != second_page["sessions"][0]["session_id"]
        rpc("switch_session", {"sessionPath": session_a["sessionFile"]})
        assert state()["sessionId"] == session_a["sessionId"]
        messages = json.dumps(rpc("get_messages")["messages"])
        assert "SMOKE_SESSION_A" in messages and "SMOKE_SESSION_B" not in messages, messages
        rpc("switch_session", {"sessionPath": session_b["sessionFile"]})
        call("omp_close")
        eventually(lambda: call("omp_open", {"mode": "resume", "session_id": session_a["sessionId"]}, "smoke-b", False),
                   lambda value: value.get("ok"))
        assert state("smoke-b")["sessionId"] == session_a["sessionId"]
        restored = state("smoke-b")
        assert restored["model"]["id"] == "fixture-alt" and restored["thinkingLevel"] == "low", restored
        messages = json.dumps(rpc("get_messages", session="smoke-b")["messages"])
        assert "SMOKE_SESSION_A" in messages and "SMOKE_SESSION_B" not in messages
        locked = call("omp_open", {"mode": "resume", "session_file": session_a["sessionFile"],
                                  "model": "smoke/fixture"}, "smoke-c", False)
        assert not locked["ok"], "Concurrent process acquired the same project"
        assert not call("omp_open", {"executor": "invalid", "mode": "resume", "session_id": "missing",
                                   "model": "smoke/fixture"}, "smoke-c", False)["ok"], "Invalid resume fell back to fresh"
        open_session("new", "smoke-b", "fresh", cwd="/data/executor/artifacts")
        fresh = state("smoke-b", "fresh")
        assert fresh["sessionId"] not in {session_a["sessionId"], session_b["sessionId"]}
        assert not rpc("get_messages", session="smoke-b", executor="fresh")["messages"]
        cwd_result = rpc("bash", {"command": "pwd; test ! -e .executor.lock && test ! -e omp.stderr.log && printf CLEAN_PROJECT"}, "smoke-b", "fresh")
        assert "/data/executor/artifacts" in json.dumps(cwd_result) and "CLEAN_PROJECT" in json.dumps(cwd_result), cwd_result
        call("omp_close", {"executor": "fresh"}, "smoke-b")
        call("omp_close", session="smoke-b")
        eventually(lambda: call("omp_open", {"mode": "resume", "session_file": session_a["sessionFile"]}, require_ok=False),
                   lambda value: value.get("ok"))
        cursors.pop(("smoke-a", "default"), None)
        history.pop(("smoke-a", "default"), None)
        print("PASS native session catalog/pagination, new/switch, explicit non-latest ID/file resume across Hermes conversations, project lock")

        contract_test_script = (
            "import json, subprocess\n"
            "from pathlib import Path\n"
            "workdir = Path('/data/executor/workspaces/smoke-contract-test')\n"
            "workdir.mkdir(parents=True, exist_ok=True)\n"
            "brief_file = workdir / 'brief.json'\n"
            "brief = {\n"
            "    'pipeline': 'hyperframes-explainer',\n"
            "    'spec': {\n"
            "        'style': 'minimal-tech',\n"
            "        'format': 'landscape',\n"
            "        'voice': 'am_michael',\n"
            "        'audience': 'engineers',\n"
            "        'tone': 'clear',\n"
            "        'narrationMode': 'restructured',\n"
            "        'music': 'none'\n"
            "    },\n"
            "    'durationSec': 15,\n"
            "    'brief': 'Direct TCP OMP executor test without bridge.',\n"
            "    'permissions': {\n"
            "        'createAssets': False,\n"
            "        'generateAudio': False,\n"
            "        'renderVideo': False\n"
            "    }\n"
            "}\n"
            "brief_file.write_text(json.dumps(brief))\n"
            "helper = '/opt/omp-skills/omp-video-pipeline/scripts/production-contract.mjs'\n"
            "proc = subprocess.run(['node', helper, str(workdir), '--input', str(brief_file)], capture_output=True, text=True, timeout=30)\n"
            "assert proc.returncode == 0, f'Helper creation failed: {proc.stderr}'\n"
            "contract_file = workdir / 'production-contract.json'\n"
            "assert contract_file.is_file(), 'production-contract.json not written'\n"
            "contract = json.loads(contract_file.read_text())\n"
            "assert contract['pipeline'] == 'hyperframes-explainer'\n"
            "assert contract['durationSec'] == 15\n"
            "assert contract['permissions'] == {'createAssets': False, 'generateAudio': False, 'renderVideo': False}\n"
            "assert contract['permissions']['generateAudio'] is False\n"
            "assert contract['permissions']['renderVideo'] is False\n"
            "# Overwrite refusal\n"
            "proc_refuse = subprocess.run(['node', helper, str(workdir), '--input', str(brief_file)], capture_output=True, text=True, timeout=30)\n"
            "assert proc_refuse.returncode != 0, 'Helper must refuse overwrite without --update'\n"
            "assert 'already exists' in (proc_refuse.stderr + proc_refuse.stdout)\n"
            "# Resumed workflow update with --update\n"
            "brief_update = dict(brief)\n"
            "brief_update['revisionInstructions'] = 'Scene timing refinement'\n"
            "brief_update['approvalNotes'] = 'Approved storyboard baseline'\n"
            "brief_file.write_text(json.dumps(brief_update))\n"
            "proc_update = subprocess.run(['node', helper, str(workdir), '--input', str(brief_file), '--update'], capture_output=True, text=True, timeout=30)\n"
            "assert proc_update.returncode == 0, f'Helper update failed: {proc_update.stderr}'\n"
            "updated_contract = json.loads(contract_file.read_text())\n"
            "assert updated_contract['revisionInstructions'] == 'Scene timing refinement'\n"
            "assert updated_contract['approvalNotes'] == 'Approved storyboard baseline'\n"
            "assert updated_contract['permissions'] == {'createAssets': False, 'generateAudio': False, 'renderVideo': False}\n"
            "print(json.dumps({'status': 'CONTRACT_OK', 'contract': updated_contract}))\n"
        )
        res_contract = rpc("bash", {"command": f"python3.12 -c {shlex.quote(contract_test_script)}"})
        assert res_contract["exitCode"] == 0 and "CONTRACT_OK" in res_contract["output"], res_contract
        print("PASS Valid brief/helper contract, explicit no-render/audio permissions, overwrite refusal, resumed contract update")

        assert rpc("negotiate_protocol", {"protocolVersion": 2})["protocolVersion"] == 2
        commands = rpc("get_available_commands")["commands"]
        skill_commands = {c["name"] for c in commands if c.get("source") == "skill"}
        for req_skill in ("skill:omp-video-pipeline", "skill:omp-storybook-pipeline", "skill:create-static-assets"):
            assert req_skill in skill_commands, (
                f"Missing native skill command {req_skill} in get_available_commands. Found: {skill_commands}"
            )
        for name in ("omp-video-pipeline", "omp-storybook-pipeline", "create-static-assets"):
            start = len(history["smoke-a", "default"])
            prompt(f"SMOKE_SKILL_READ {name}")
            reads = [event for event in history["smoke-a", "default"][start:]
                     if event.get("type") == "tool_execution_end" and event.get("toolName") == "read"]
            assert len(reads) == 1 and reads[0].get("isError") is False, reads
            assert name in json.dumps(reads[0]["result"]), reads[0]
        print("PASS Worker runtime skills discovered in get_available_commands and read via native skill:// URIs")
        assert any(command["name"] == "model" for command in commands), commands
        available = rpc("get_available_models")["models"]
        assert any(model["id"] == "fixture-alt" for model in available), available
        rpc("set_model", {"provider": "smoke", "modelId": "fixture-alt"})
        assert state()["model"]["id"] == "fixture-alt"
        levels = rpc("get_available_thinking_levels")["levels"]
        assert "low" in levels, levels
        rpc("set_thinking_level", {"level": "low"})
        assert state()["thinkingLevel"] == "low"
        rpc("cycle_thinking_level")
        assert state()["thinkingLevel"] != "low"
        rpc("cycle_model")
        rpc("set_model", {"provider": "smoke", "modelId": "fixture"})
        rpc("set_thinking_level", {"level": "off"})
        rpc("set_fast_mode", {"enabled": True}, success=False)
        for command, params, field, expected in (
            ("set_fast_mode", {"enabled": False}, "fastModeEnabled", False),
            ("set_auto_compaction", {"enabled": False}, "autoCompactionEnabled", False),
            ("set_steering_mode", {"mode": "one-at-a-time"}, "steeringMode", "one-at-a-time"),
            ("set_follow_up_mode", {"mode": "one-at-a-time"}, "followUpMode", "one-at-a-time"),
            ("set_interrupt_mode", {"mode": "wait"}, "interruptMode", "wait"),
        ):
            rpc(command, params)
            assert state()[field] == expected, (command, state())
        rpc("set_auto_retry", {"enabled": False})
        rpc("abort_retry")
        rpc("set_todos", {"phases": [{"id": "smoke-phase", "name": "Smoke", "tasks": [{"id": "smoke-task", "content": "Check native control", "status": "completed"}]}]})
        assert state()["todoPhases"][0]["tasks"][0]["status"] == "completed"
        rpc("set_todos", {"phases": []})
        rpc("set_subagent_subscription", {"level": "events"})
        assert isinstance(rpc("get_subagents")["subagents"], list)
        rpc("get_subagent_messages", {"subagentId": "not-a-subagent"}, success=False)
        rpc("set_event_filter", {"events": ["session_settled"]})
        rpc("set_event_filter", {"events": None})
        bad = rpc("remove_queued_message", {"message": "x", "queue": "invalid"}, success=False)
        assert bad["command"] == "remove_queued_message"
        login_providers = rpc("get_login_providers")
        assert isinstance(login_providers["providers"], list)
        rpc("login", {"providerId": "not-a-provider"}, success=False)
        print("PASS live model/thinking/modes/todos/subagent/event-filter control, null payload, correlated native errors")

        branches = rpc("get_branch_messages")["messages"]
        branch = next(message for message in branches if "SMOKE_SESSION_A" in message["text"])
        rpc("branch", {"entryId": branch["entryId"]})
        assert state()["sessionId"] != session_a["sessionId"]
        rpc("switch_session", {"sessionPath": session_a["sessionFile"]})
        assert state()["sessionId"] == session_a["sessionId"]
        assert rpc("get_tree")["tree"]
        assert rpc("get_entries")["entries"]
        page = rpc("get_messages_page", {"limit": 1})
        assert page["totalMessages"] >= 2 and len(page["messages"]) == 1
        stats = rpc("get_session_stats")
        assert stats["userMessages"] >= 1 and stats["assistantMessages"] >= 1
        last_assistant = next(message for message in reversed(rpc("get_messages")["messages"])
                              if message["role"] == "assistant")
        last_text = "".join(part["text"] for part in last_assistant["content"] if part["type"] == "text")
        assert rpc("get_last_assistant_text")["text"] == last_text
        assert rpc("export_html")["path"].endswith(".html")
        local = submit("prompt", {"message": "/model"})
        local_result = frame(local)
        assert local_result["success"] and local_result["data"]["agentInvoked"] is False, local_result
        assert any(event.get("type") == "command_output" and event.get("text") for event in history["smoke-a", "default"])
        for index in range(3):
            prompt(f"SMOKE_BEFORE_COMPACT_{index} " + "historical fixture context " * 4000)
        rpc("compact", {"customInstructions": "Summarize this fixture conversation."})
        assert any(entry["type"] == "compaction" for entry in rpc("get_entries")["entries"])
        print("PASS native branch/tree/history/paging/stats/export, local slash-command output and real compaction")

        for method, value in (("confirm", False), ("input", "Typed fixture text"), ("editor", "Edited fixture text")):
            ui_id = submit("prompt", {"message": f"/smoke-ui {method}"})
            request = pending("extension_ui_request")
            assert request["method"] == method, request
            answer = {"type": "extension_ui_response", "id": request["id"]}
            if method == "confirm":
                assert not call("omp_respond", {"response": {**answer, "confirmed": "false"}}, require_ok=False)["ok"]
                assert any(item["id"] == request["id"] for item in collect()["pending_requests"])
                answer["confirmed"] = value
            else:
                answer["value"] = value
            call("omp_respond", {"response": answer})
            initial = frame(ui_id)
            if (initial.get("data") or {}).get("agentInvoked") is not False:
                assert frame(ui_id, "prompt_result")["status"] == "completed"
            collect()
            observed = [json.loads(event["message"][len("SMOKE_UI:"):]) for event in history["smoke-a", "default"]
                        if event.get("method") == "notify" and event.get("message", "").startswith("SMOKE_UI:")]
            assert {"method": method, "value": value} in observed, observed
        print("PASS real native confirm/input/editor, false-not-string approval and passive notifications")

        ask_id = submit("prompt", {"message": "SMOKE_ASK"})
        request = pending("extension_ui_request")
        assert request["method"] == "select", request
        stale = call("omp_respond", {"response": {"type": "extension_ui_response", "id": "not-owned", "value": "Proceed"}}, require_ok=False)
        assert not stale["ok"]
        assert any(item["id"] == request["id"] for item in collect()["pending_requests"])
        option = next(value for value in request["options"] if value.startswith("Proceed"))
        answer = {"type": "extension_ui_response", "id": request["id"], "value": option}
        call("omp_respond", {"response": answer})
        assert frame(ask_id, "prompt_result")["status"] == "completed"
        settled()
        assert rpc("get_last_assistant_text")["text"] == "User choice received."
        assert not call("omp_respond", {"response": answer}, require_ok=False)["ok"]
        print("PASS actual OMP ask UI, explicit answer and stale-ID rejection")

        rpc("set_host_tools", {"tools": [{"name": "echo_host", "loadMode": "essential", "description": "Return a host-owned smoke message",
                                        "parameters": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}}]})
        host_id = submit("prompt", {"message": "SMOKE_HOST_TOOL"})
        request = pending("host_tool_call")
        assert request["toolName"] == "echo_host" and request["arguments"]["message"] == "HOST_MESSAGE", request
        call("omp_respond", {"response": {"type": "host_tool_update", "id": request["id"],
                                        "partialResult": {"content": [{"type": "text", "text": "Host processing"}]}}})
        assert any(item["id"] == request["id"] for item in collect()["pending_requests"])
        host_answer = {"type": "host_tool_result", "id": request["id"],
                       "result": {"content": [{"type": "text", "text": "HOST_RESULT"}]}}
        call("omp_respond", {"response": host_answer})
        assert frame(host_id, "prompt_result")["status"] == "completed"
        settled()
        assert "HOST_RESULT" in json.dumps(rpc("get_messages")["messages"])
        assert not call("omp_respond", {"response": host_answer}, require_ok=False)["ok"]
        rpc("set_host_uri_schemes", {"schemes": [{"scheme": "smokefile", "writable": True}]})
        uri_id = submit("prompt", {"message": "SMOKE_HOST_URI"})
        seen_operations = set()
        for _ in range(2):
            request = pending("host_uri_request")
            seen_operations.add(request["operation"])
            response = {"type": "host_uri_result", "id": request["id"]}
            if request["operation"] == "read":
                assert request["url"] == "smokefile://project/input.txt", request
                response["content"] = "HOST_URI_READ"
                response.update(contentType="text/plain", notes=["Fixture host metadata"], immutable=False)
            else:
                assert request["content"] == "HOST_URI_WRITTEN", request
            call("omp_respond", {"response": response})
        assert seen_operations == {"read", "write"}
        assert frame(uri_id, "prompt_result")["status"] == "completed"
        settled()
        assert "HOST_URI_READ" in json.dumps(rpc("get_messages")["messages"])
        rpc("set_host_tools", {"tools": []})
        rpc("set_host_uri_schemes", {"schemes": []})
        print("PASS actual native host tool handoff/progress/result and host URI read/write; no automatic host execution")

        FixtureProvider.waiting.clear()
        FixtureProvider.hold.clear()
        held = submit("prompt", {"message": "SMOKE_HOLD"})
        assert FixtureProvider.waiting.wait(15), "OMP did not reach fixture provider"
        rpc("steer", {"message": "SMOKE_STEER"})
        rpc("follow_up", {"message": "SMOKE_REMOVED"})
        queued = state()["queuedMessages"]
        assert "SMOKE_STEER" in queued["steering"] and "SMOKE_REMOVED" in queued["followUp"], queued
        assert rpc("remove_queued_message", {"message": "SMOKE_REMOVED", "queue": "followUp"})["removed"]
        rpc("follow_up", {"message": "SMOKE_FOLLOWUP"})
        FixtureProvider.hold.set()
        assert frame(held, "prompt_result")["status"] == "completed"
        settled()
        observed = json.dumps(FixtureProvider.requests)
        assert "SMOKE_STEER" in observed and "SMOKE_FOLLOWUP" in observed
        assert "SMOKE_REMOVED" not in observed
        print("PASS native live steering/follow-up, queue inspection/removal and delivery")

        background_id = submit("prompt", {"message": "SMOKE_BACKGROUND"})
        yielded = frame(background_id, "prompt_result")
        assert yielded["status"] == "completed"
        assert yielded.get("sessionSettled", yielded.get("session_settled")) is False, yielded
        assert state()["isSettled"] is False
        settled()
        assert "BACKGROUND_FINISHED" in json.dumps(rpc("get_messages")["messages"])
        bash_start = time.monotonic()
        bash_id = submit("bash", {"command": "printf BASH_BEGIN; sleep 20; printf BASH_END"})
        assert state()["sessionId"] == session_a["sessionId"]
        time.sleep(0.5)
        rpc("abort_bash")
        bash_result = frame(bash_id)
        assert time.monotonic() - bash_start < 10, bash_result
        assert bash_result["success"] and "BASH_END" not in json.dumps(bash_result), bash_result
        print("PASS real background yield versus settlement and concurrent RPC bash/abort_bash")

        FixtureProvider.waiting.clear()
        FixtureProvider.hold.clear()
        aborted = submit("prompt", {"message": "SMOKE_HOLD_ABORT"})
        assert FixtureProvider.waiting.wait(15), "OMP did not start abort scenario"
        rpc("abort")
        assert frame(aborted, "prompt_result")["status"] == "aborted"
        FixtureProvider.hold.set()
        replacement = submit("abort_and_prompt", {"message": "SMOKE_REPLACEMENT"})
        assert frame(replacement)["success"]
        assert frame(replacement, "prompt_result")["status"] == "completed"
        settled()
        for index in range(3):
            prompt(f"SMOKE_BEFORE_HANDOFF_{index} " + "historical handoff context " * 4000)
        rpc("handoff", {"customInstructions": "Summarize the fixture conversation for a handoff."})
        assert state()["sessionId"] == session_a["sessionId"]
        entries = rpc("get_entries")["entries"]
        assert any(entry["type"] == "compaction" and entry.get("method") == "handoff"
                   and "Executor response received." in entry["summary"] for entry in entries), entries
        print("PASS real native handoff summary committed as current-session compaction")
        manager.invoke_hook("on_session_finalize", session_id="smoke-a", platform="cli")
        assert not call("omp_events")["running"], "Finalize left executor alive"
        print("PASS native abort/abort_and_prompt and Hermes finalization cleanup")
        print(f"Native command kinds exercised: {len(commands_seen)}; {', '.join(sorted(commands_seen))}")
        print("PASS Hermes → TCP → OMP full native control; fixture provider only, no paid model, Telegram or media")
    finally:
        FixtureProvider.hold.set()
        for session in ("smoke-a", "smoke-b", "smoke-c"):
            for executor in ("default", "fresh", "invalid"):
                call("omp_close", {"executor": executor}, session, False)
        provider.shutdown()
        provider.server_close()


def docker_smoke(keep, no_build=False):
    repo = Path(__file__).resolve().parents[1]

    # Validate coupled locks and load authoritative metadata FIRST, before allocating temp resources
    deploy_dir = repo / "deploy"
    sys_path = sys.path[:]
    try:
        if str(deploy_dir) not in sys.path:
            sys.path.insert(0, str(deploy_dir))
        import importlib
        runtime_pins = importlib.import_module("runtime-pins")
        runtime_pins.validate_locks(repo=repo)
        pins = runtime_pins.get_pins(repo=repo)
    finally:
        sys.path = sys_path

    worker_runtime_image = os.environ.get("WORKER_RUNTIME_IMAGE") or pins.get("WORKER_RUNTIME_IMAGE", "")
    hermes_base_image = os.environ.get("HERMES_BASE_IMAGE") or pins.get("HERMES_BASE_IMAGE", "")
    worker_image = os.environ.get("OMP_EXECUTOR_IMAGE", "omp-direct-executor:smoke")
    hermes_image = os.environ.get("HERMES_EXECUTOR_IMAGE", "omp-hermes-executor:smoke")
    if no_build and ("OMP_EXECUTOR_IMAGE" not in os.environ or "HERMES_EXECUTOR_IMAGE" not in os.environ):
        raise RuntimeError("--no-build requires explicit OMP_EXECUTOR_IMAGE and HERMES_EXECUTOR_IMAGE environment variables")

    root = Path(tempfile.mkdtemp(prefix="omp-rpc-smoke-"))
    project = "omp-rpc-smoke-" + uuid.uuid4().hex[:12]
    environment = {
        **os.environ,
        "OMP_DIRECT_STATE_DIR": str(root),
        "OMP_EXECUTOR_IMAGE": worker_image,
        "HERMES_EXECUTOR_IMAGE": hermes_image,
        "WORKER_RUNTIME_IMAGE": worker_runtime_image,
        "HERMES_BASE_IMAGE": hermes_base_image,
    }
    compose = ["docker", "compose", "--env-file", "/dev/null", "-p", project,
               "-f", str(repo / "deploy/compose.yaml")]

    def run(command, timeout=180):
        subprocess.run(command, env=environment, cwd=repo, check=True, timeout=timeout)

    try:
        if not no_build:
            worker_build = ["docker", "build", "-f", "deploy/Dockerfile.worker", "-t", worker_image]
            if worker_runtime_image:
                worker_build.extend(["--build-arg", f"WORKER_RUNTIME_IMAGE={worker_runtime_image}"])
            worker_build.append(".")
            run(worker_build)

            hermes_build = ["docker", "build", "-f", "deploy/hermes/Dockerfile", "-t", hermes_image]
            if hermes_base_image:
                hermes_build.extend(["--build-arg", f"HERMES_BASE_IMAGE={hermes_base_image}"])
            hermes_build.append(".")
            run(hermes_build)
        # Bootstrap refusal test: unmarked non-empty state directory
        unmarked = root / "unmarked-test"
        unmarked.mkdir(mode=0o700, exist_ok=True)
        rogue_file = unmarked / "rogue.txt"
        rogue_file.write_text("not direct executor")
        refused = subprocess.run(
            ["docker", "run", "--rm", "--network", "none",
             "--mount", f"type=bind,src={unmarked},dst=/state",
             "--entrypoint", "python3.12", worker_image, "/opt/direct-executor/init-executor.py"],
            capture_output=True, text=True, timeout=30
        )
        assert refused.returncode != 0, f"Expected non-zero exit on unmarked state, got {refused.returncode}"
        assert rogue_file.is_file() and rogue_file.read_text() == "not direct executor"
        assert not (unmarked / ".omp-direct-executor").exists(), "Marker should not be created in refused state"
        assert not (unmarked / "secrets").exists(), "Secrets should not be created in refused state"
        shutil.rmtree(unmarked)

        # Initial bootstrap
        run(compose + ["--profile", "bootstrap", "run", "--rm", "init-state"])
        token_path = root / "secrets/executor-token"
        assert token_path.is_file(), "Token file was not generated by bootstrap"
        initial_token = token_path.read_text()
        assert len(initial_token.strip()) == 64, f"Unexpected token length: {len(initial_token.strip())}"

        # Bootstrap preservation test: rerun bootstrap, token and configs must be preserved
        run(compose + ["--profile", "bootstrap", "run", "--rm", "init-state"])
        assert token_path.read_text() == initial_token, "Bootstrap did not preserve existing token"
        run(compose + ["run", "--rm", "--no-deps", "hermes",
                       "plugins", "doctor", "/opt/data/plugins/omp-executor", "--ci"])
        models = {"providers": {"smoke": {
            "api": "openai-completions", "baseUrl": "http://hermes-probe:9877/v1", "auth": "none",
            "models": [{"id": model_id, "name": f"Isolated smoke {model_id}", "reasoning": reasoning,
                        "input": ["text"], "contextWindow": 128000, "maxTokens": 2048,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}
                       for model_id, reasoning in (("fixture", False), ("fixture-alt", True))],
        }}}
        model_path = root / "smoke-models.yml"
        model_path.write_text(json.dumps(models))
        ui_extension = """export default function(pi) {
  pi.registerCommand("smoke-ui", {
    description: "Isolated fixture dialogs",
    handler: async (args, ctx) => {
      let value;
      if (args === "confirm") value = await ctx.ui.confirm("Fixture approval", "No external effects");
      else if (args === "input") value = await ctx.ui.input("Fixture input", "Type text");
      else if (args === "editor") value = await ctx.ui.editor("Fixture editor", "Initial text");
      ctx.ui.notify("SMOKE_UI:" + JSON.stringify({method: args, value}), "info");
    }
  });
}"""
        run(["docker", "run", "--rm", "--network", "none",
             "--mount", f"type=bind,src={root / 'omp-state'},dst=/home/worker/.omp",
             "--mount", f"type=bind,src={model_path},dst=/fixtures/models.yml,readonly",
             "--entrypoint", "python3.12", worker_image, "-c",
             "import sys; from pathlib import Path; p=Path('/home/worker/.omp/agent'); p.mkdir(mode=0o700,exist_ok=True); "
             "(p/'models.yml').write_bytes(Path('/fixtures/models.yml').read_bytes()); "
             "e=p/'extensions'; e.mkdir(exist_ok=True); (e/'smoke-ui.js').write_text(sys.argv[1])", ui_extension])
        override = root / "compose.smoke.yaml"
        override.write_text(json.dumps({"services": {
            "omp-executor": {"environment": {"OMP_EXECUTOR_MODEL": "smoke/fixture", "OMP_EXECUTOR_THINKING": "off"}},
            "hermes": {
                "entrypoint": ["/opt/hermes/.venv/bin/python"],
                "command": ["-u", "/checks/smoke-executor.py"], "restart": "no",
                "environment": {"OMP_EXECUTOR_SMOKE": "1"},
                "networks": {"default": {"aliases": ["hermes-probe"]}},
                "volumes": [{"type": "bind", "source": str(Path(__file__).resolve()),
                             "target": "/checks/smoke-executor.py", "read_only": True}],
            },
        }}))
        compose += ["-f", str(override)]
        run(compose + ["up", "--abort-on-container-exit", "--exit-code-from", "hermes", "hermes"])
    finally:
        subprocess.run(compose + ["down", "--timeout", "5"], env=environment, cwd=repo, timeout=30)
        if keep:
            print(f"Retained smoke state: {root}; Compose project: {project}")
        else:
            # Only the freshly generated workspace is mounted here; never deployment state.
            cleanup = subprocess.run([
                "docker", "run", "--rm", "--network", "none", "--user", "0:0",
                "--mount", f"type=bind,src={root},dst=/state", "--entrypoint", "python3.12",
                worker_image, "-c",
                "from pathlib import Path; import shutil; "
                "[(shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()) "
                "for p in Path('/state').iterdir()]",
            ], timeout=30)
            if cleanup.returncode == 0:
                shutil.rmtree(root)
            else:
                print(f"Cleanup failed; retained smoke state: {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker", action="store_true", help="Build and smoke in fresh Docker/Compose state")
    parser.add_argument("--no-build", action="store_true", help="Skip docker build; use explicit OMP_EXECUTOR_IMAGE and HERMES_EXECUTOR_IMAGE")
    parser.add_argument("--keep", action="store_true", help="Retain only the smoke state after stopping its containers")
    options = parser.parse_args()
    docker_smoke(options.keep, options.no_build) if options.docker else main()
