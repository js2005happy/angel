"""CLI entry points for opt-in local semantic document search."""

import argparse
import sys

from .knowledge import (
    DEFAULT_EMBED_MODEL,
    KnowledgeError,
    KnowledgeStore,
    format_search_results,
    index_workdir,
)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="angel knowledge",
        description="建立并查询仅保存在本机的项目文档语义索引",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    index = commands.add_parser("index", help="显式扫描当前项目文本并建立/更新索引")
    index.add_argument("--workdir", default=".", help="要索引的项目目录，默认当前目录")
    index.add_argument(
        "--model", default=DEFAULT_EMBED_MODEL,
        help=f"本机 Ollama embedding 模型，默认 {DEFAULT_EMBED_MODEL}",
    )

    search = commands.add_parser("search", help="在当前项目的本地索引中检索")
    search.add_argument("query", help="要查找的概念或问题")
    search.add_argument("--workdir", default=".", help="索引所属项目目录，默认当前目录")
    search.add_argument("--top-k", type=int, default=5, help="返回结果数，范围 1–10")

    status = commands.add_parser("status", help="查看当前项目索引状态")
    status.add_argument("--workdir", default=".", help="索引所属项目目录，默认当前目录")

    args = parser.parse_args(argv)
    try:
        if args.operation == "index":
            result = index_workdir(args.workdir, args.model)
            print(
                "索引完成："
                f"{result['indexed_files']} 个文本文件，{result['chunks']} 个片段；"
                f"本次更新 {result['changed_files']} 个，移除 {result['removed_files']} 个。"
            )
            print(f"工作目录：{result['workdir']}")
            print(f"本地 embedding 模型：{result['model']}")
            return 0
        store = KnowledgeStore.open_for_workdir(args.workdir)
        if store is None:
            raise KnowledgeError("当前工作目录还没有知识索引；先运行 `angel knowledge index`")
        if args.operation == "status":
            result = store.status()
            print(
                f"本地索引：{result['files']} 个文件，{result['chunks']} 个片段，"
                f"模型 {result['model']}，维度 {result['dimensions']}"
            )
            print(f"工作目录：{result['workdir']}")
            return 0
        if not 1 <= args.top_k <= 10:
            raise KnowledgeError("--top-k 必须在 1 到 10 之间")
        print(format_search_results(store.search(args.query, top_k=args.top_k)))
        return 0
    except KnowledgeError as exc:
        print(f"知识检索错误：{exc}", file=sys.stderr)
        return 1
