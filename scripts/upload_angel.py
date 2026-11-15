"""Upload the Angel project into a sandbox and run its test suite there.

Usage:
  python3 upload_angel.py --sandbox-id <id>

Skips .venv, __pycache__, .git and assets (large images, not needed for
tests). Authenticates with the stored E2B credential surrogate, so the
E2B key never appears here.
"""
import argparse
import os
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

from e2b import Sandbox

PROJECT = "/home/hatch/workspace/angel"
DEST = "/home/user/angel"
SKIP_DIRS = {".venv", "__pycache__", ".git", "assets"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sandbox-id", required=True)
    args = parser.parse_args()

    surrogate = dynamic_credential_entry("custom.e2b")["surrogate"]
    sbx = Sandbox.connect(args.sandbox_id, api_key=surrogate)
    print(f"Connected to sandbox {args.sandbox_id}")

    count = 0
    for root, dirs, files in os.walk(PROJECT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            src = os.path.join(root, name)
            rel = os.path.relpath(src, PROJECT)
            with open(src, "rb") as f:
                sbx.files.write(f"{DEST}/{rel}", f.read())
            count += 1
    print(f"Uploaded {count} files to {DEST}")

    r = sbx.commands.run(f"cd {DEST} && python3 -m angel --help 2>&1 | head -20", timeout=60)
    print("--- angel --help ---")
    print(r.stdout)
    print(r.stderr)

    r = sbx.commands.run(
        f"cd {DEST} && python3 -m unittest discover tests 2>&1 | tail -5", timeout=180
    )
    print("--- unittest discover tests ---")
    print(r.stdout)
    print(r.stderr)
    print("EXIT:", r.exit_code)


if __name__ == "__main__":
    main()
