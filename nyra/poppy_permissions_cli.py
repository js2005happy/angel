"""CLI for explicitly managing *local* Poppy intent, never remote OAuth."""

import argparse
import json
import sys

from .poppy_permissions import PermissionConflict, PermissionError, PermissionLedger


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="nyra permissions",
        description=(
            "Poppy 站点权限意向账本；只存本地记录，不等于已登录、"
            "OAuth 授权或真实远端执行权限"
        ),
    )
    commands = parser.add_subparsers(dest="operation", required=True)
    listing = commands.add_parser("list", help="列出本地授权意向")
    listing.add_argument("--site")
    check = commands.add_parser("check", help="检查一个精确站点、身份和 scope")
    grant = commands.add_parser("grant", help="显式登记本地授权意向")
    revoke = commands.add_parser("revoke", help="撤销本地授权意向")
    audit = commands.add_parser("audit", help="查看本地历史变更日志")
    audit.add_argument("--site")
    audit.add_argument("--limit", type=int, default=30)
    for command in (check, grant, revoke):
        command.add_argument("--site", required=True)
        command.add_argument("--scope", required=True)
        command.add_argument(
            "--account", default=None, metavar="LOCAL_ALIAS",
            help="账户的本地别名（例如 personal），缺省为 visitor",
        )
    grant.add_argument(
        "--confirm", action="store_true",
        help="确认仅记录本地授权意向；仍不授予实际 OAuth/API 权限",
    )
    for command in (grant, revoke):
        command.add_argument(
            "--expect-revision", default=None,
            help="可选：只在账本 SHA-256 与给定版本相同时修改",
        )
    try:
        args = parser.parse_args(argv)
        ledger = PermissionLedger()
        if args.operation == "list":
            result = ledger.list(site=args.site)
        elif args.operation == "audit":
            result = {"events": ledger.audit(site=args.site, limit=args.limit)}
        elif args.operation == "check":
            result = ledger.check(args.site, args.scope, account=args.account)
        elif args.operation == "grant":
            result = ledger.grant(
                args.site, args.scope, account=args.account,
                confirmed=args.confirm, expected_revision=args.expect_revision,
            )
        else:
            result = ledger.revoke(
                args.site, args.scope, account=args.account,
                expected_revision=args.expect_revision,
            )
    except (PermissionError, OSError) as exc:
        print(f"权限账本拒绝操作：{exc}", file=sys.stderr)
        return 2 if isinstance(exc, PermissionConflict) else 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0
