"""会话内证据链：把联网抓到的页面原文存为证据文件，供复核与引用。

借鉴 IllusionAgent“截图留档、证据留在会话里”的做法的轻量版：
Angel 没有真实浏览器，做不了截图，就把 web_fetch / web_search 抓到的
页面原文存下来（~/.angel/evidence/<会话 id>/），结论必须附来源链接，
任何人都能按证据复核。
"""

import re
from datetime import datetime
from pathlib import Path


MAX_EVIDENCE_CHARS = 20000


class EvidenceStore:
    """按会话保存证据文件，文件名带序号，不覆盖已有文件。"""

    def __init__(self, base_dir: Path, session_id: str):
        self.dir = Path(base_dir) / session_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self._index = 0
        for path in self.dir.glob("*.md"):
            match = re.match(r"(\d+)_", path.name)
            if match:
                self._index = max(self._index, int(match.group(1)))

    def save(
        self,
        kind: str,
        url: str,
        content: str,
        query: str | None = None,
    ) -> Path:
        """保存一条证据，返回文件路径。"""
        slug = re.sub(r"[^a-zA-Z0-9]+", "-", url.split("://", 1)[-1])[:60].strip("-")
        slug = slug or "page"
        safe_kind = re.sub(r"[^a-zA-Z0-9_-]+", "-", kind).strip("-") or "unknown"
        while True:
            self._index += 1
            name = f"{self._index:03d}_{safe_kind}_{slug}.md"
            path = self.dir / name
            try:
                handle = path.open("x", encoding="utf-8")
                break
            except FileExistsError:
                continue
        header = (
            f"# 证据 {self._index}\n\n"
            f"- 来源：{url}\n"
            f"- 抓取时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"- 类型：{kind}\n"
        )
        if query:
            header += f"- 搜索词：{query}\n"
        with handle:
            handle.write(header + "\n" + content[:MAX_EVIDENCE_CHARS])
        return path

    def list(self) -> list[Path]:
        """按序号返回已保存的证据文件。"""
        return sorted(self.dir.glob("*.md"))
