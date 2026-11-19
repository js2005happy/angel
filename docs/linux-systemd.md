# 用 systemd 让调度器一直跑着（Linux）

默认情况下，`nyra schedule daemon` 只在你开着的终端里跑，关掉终端它就停了。
这个 systemd 用户服务（`systemd/nyra-scheduler.service`）让它在后台一直跑、
崩了自动重启。**不需要 root**，也不写系统目录。

> 只覆盖调度器 daemon。网页界面（`nyra ui`）不在本轮范围，仍需你自己在
> 终端里启动。

## 前置条件

- 已装好 Nyra 命令行版（`~/.local/bin/nyra` 能跑，见
  [docs/linux-install.md](linux-install.md)；不需要 `git clone` 仓库，
  服务跑的是装好的二进制，不是源码）；
- `systemctl --user` 可用（带 systemd 的桌面版 / 服务器版 Linux 均可）；
- 懒得手动装：`scripts/install-node.sh --from-file dist/nyra-linux-x64 --with-systemd` 会把 unit
  装好，见 [docs/linux-install.md](linux-install.md)。

## 安装与启动

```bash
# 1. 把 unit 文件放到用户服务目录
mkdir -p ~/.config/systemd/user
cp systemd/nyra-scheduler.service ~/.config/systemd/user/

# 2. 让 systemd 读到它，并立即启动 + 设为开机自启
systemctl --user daemon-reload
systemctl --user enable --now nyra-scheduler.service
```

## 查看状态与日志

```bash
systemctl --user status nyra-scheduler.service
journalctl --user -u nyra-scheduler.service -f   # 实时日志，Ctrl+C 退出
journalctl --user -u nyra-scheduler.service --since today
```

## 开机自启（没有登录时也跑）

用户服务默认只在你登录后运行。想让它在开机后、你还没登录时就跑：

```bash
loginctl enable-linger $USER
```

## API Key 怎么给服务

systemd 服务读不到你 shell 里的 `export`。Nyra 的 Key 只从环境变量读，
所以用 drop-in 给服务补环境变量：

```bash
systemctl --user edit nyra-scheduler.service
```

在打开的编辑器里写（按你用的 provider 改）：

```ini
[Service]
Environment=DEEPSEEK_API_KEY=你的key
```

保存后重载并重启服务：

```bash
systemctl --user daemon-reload
systemctl --user restart nyra-scheduler.service
```

## 改检查间隔

默认每 60 秒检查一次到期任务。改成每 30 秒：

```bash
systemctl --user edit nyra-scheduler.service
```

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/nyra schedule daemon --interval 30
```

（第一行空的 `ExecStart=` 是清空原值，systemd 要求必须先清空再重设。）
然后 `systemctl --user daemon-reload && systemctl --user restart nyra-scheduler.service`。

## 卸载

```bash
systemctl --user disable --now nyra-scheduler.service
rm ~/.config/systemd/user/nyra-scheduler.service
systemctl --user daemon-reload
loginctl disable-linger $USER   # 之前开过 linger 才需要
```

## 排错

- `status` 显示 `exit code` 且反复重启：先看 `journalctl --user -u nyra-scheduler.service` 的报错；
  常见原因是 `ExecStart` 指的二进制不在了（比如 `~/.local/bin/nyra` 被删
  或换了安装位置），重装一次或改 unit 里的 `ExecStart` 指向实际路径。
- 任务没按时跑：`nyra schedule list` 看任务是否在、是否启用；
  注意调度器用的是本机 naive 本地时间，不处理时区（见 VERIFICATION.md 的已知限制）。
- 定时任务跑起来会按任务自己的配置调模型、产生费用；跑之前先用
  `nyra schedule run` 手动跑一次确认无误。

## 安全说明

这是 `--user` 服务，以你自己的身份运行，不用 root；unit 里还加了
`NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=true`
（系统目录只读，不影响 `~/.nyra` 与工作目录的写入）。服务本身不联网
取任何东西，只跑本机已有的 Nyra 代码与你配好的定时任务。
