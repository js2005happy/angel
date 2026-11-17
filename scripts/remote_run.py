"""Remote agent runner: brain on this machine, hands in an E2B sandbox.

The model is called through the stored DeepSeek connector, so the model
key never leaves the vault. Tools run inside the sandbox through the
official E2B SDK, authenticated with the stored E2B credential surrogate,
so the E2B key never appears here either.

Usage:
  python3 remote_run.py --sandbox-id <id> --task "task text" [--max-turns 6]

This is the step 1 prototype of the Nyra service architecture: the agent
loop plus model live outside the sandbox, the sandbox only runs commands
and holds files. The durable version of this backend belongs in Nyra
itself (tools.py), not in this script.
"""
import argparse
import json
import subprocess
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

from e2b import Sandbox

DEEPSEEK_HELPER = "/home/hatch/workspace/custom-connectors/custom.deepseek/bin/deepseek.py"
MODEL = "deepseek-flash"
WORKDIR = "/home/user"

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write text content to a file in the sandbox, creating parent directories as needed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path in the sandbox"},
                    "content": {"type": "string", "description": "File content"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file in the sandbox and return its content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path in the sandbox"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a shell command in the sandbox and return its output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to run"},
                },
                "required": ["command"],
            },
        },
    },
]

DENIED = ["rm -rf /", "rm -rf ~", "mkfs", "dd if=", ":(){:|:&};:", "shutdown", "reboot"]

SYSTEM_PROMPT = (
    "You are Nyra, an AI agent. Your tools run inside an isolated Linux "
    "sandbox. Work in /home/user. Use the tools to complete the task. "
    "Do not install packages. When the task is done, reply with a short "
    "summary of what you did and the result."
)


def call_model(messages):
    request = {"messages": messages, "tools": TOOLS, "tool_choice": "auto"}
    proc = subprocess.run(
        ["python3", DEEPSEEK_HELPER, "chat-tools", "--model", MODEL],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"model call failed: {proc.stderr.strip()[:1000]}")
    return json.loads(proc.stdout)


def run_tool(sbx, name, args):
    if name == "write_file":
        sbx.files.write(args["path"], args["content"])
        return f"Wrote {args['path']} ({len(args['content'])} chars)"
    if name == "read_file":
        content = sbx.files.read(args["path"])
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        return content
    if name == "run_command":
        cmd = args["command"]
        for bad in DENIED:
            if bad in cmd:
                return f"Refused dangerous command: {bad}"
        result = sbx.commands.run(cmd, timeout=60)
        out = result.stdout or ""
        if result.stderr:
            out += "\nSTDERR:\n" + result.stderr
        return f"exit={result.exit_code}\n{out}"
    return f"Unknown tool: {name}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sandbox-id", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--max-turns", type=int, default=6)
    args = parser.parse_args()

    surrogate = dynamic_credential_entry("custom.e2b")["surrogate"]
    sbx = Sandbox.connect(args.sandbox_id, api_key=surrogate)
    print(f"Connected to sandbox {args.sandbox_id}")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": args.task},
    ]

    for turn in range(1, args.max_turns + 1):
        print(f"\n--- turn {turn} ---")
        response = call_model(messages)
        message = response["choices"][0]["message"]
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            print("FINAL:", message.get("content") or "")
            return
        messages.append(message)
        for call in tool_calls:
            name = call["function"]["name"]
            call_args = json.loads(call["function"]["arguments"] or "{}")
            print(f"TOOL {name} {json.dumps(call_args, ensure_ascii=False)[:300]}")
            result = run_tool(sbx, name, call_args)
            print(f"RESULT: {result[:500]}")
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": result,
                }
            )

    print("Stopped: max turns reached without a final answer.")


if __name__ == "__main__":
    main()
