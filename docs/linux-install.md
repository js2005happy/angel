# 在 Linux 上安装 Nyra（一键脚本）

`scripts/install.sh` 把 Nyra 装到你的 home 目录里，**不需要 root**，
也不往系统目录写东西。装完直接在终端跑 `nyra` 就行。

## 它会做什么

- 把 Nyra 复制到 `~/.local/share/nyra`（`--prefix` 可改）；
- 在 `~/.local/bin/nyra` 放一个启动器（其实就是 `python3 -m nyra`）；
- 建 `~/.nyra`（权限 0700，配置与数据目录）；
- 装完跑 `nyra --version` 自检，通不过就报错；
- 加 `--with-systemd` 时，再把调度器服务装成 systemd 用户服务并启动
  （见 [docs/linux-systemd.md](linux-systemd.md)）。

重复跑就是升级：旧安装整个被替换，`~/.nyra` 里的数据不动。

## 前置条件

- Python 3.10 或更高版本（`python3 --version` 看一下）；
- 从 GitHub 装时需要 `git`；从本地目录装时不需要；
- 可选：`systemctl --user`（只要 `--with-systemd` 时用到）。

Nyra 是零 pip 依赖，脚本不联网装任何东西（除了 `git clone` 那一步）。

## 安装

```bash
# 方式一：还没 clone 仓库，让脚本自己从 GitHub 拉
bash scripts/install.sh

# 方式二：已经 clone 好了，从当前检出安装（不用再下一遍）
git clone https://github.com/js2005happy/nyra.git
cd nyra
bash scripts/install.sh --source .

# 方式三：顺手把调度器装成 systemd 用户服务，开机自启、崩了自动重启
bash scripts/install.sh --source . --with-systemd
```

装完如果提示 `~/.local/bin 不在 PATH 里`，按提示加一行到你的
`~/.bashrc`（或 `~/.zshrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

然后新开一个终端，跑 `nyra --version`，看到 `Nyra 0.3.0` 就装好了。
第一次用先配 Key（以 DeepSeek 为例）：

```bash
export DEEPSEEK_API_KEY=你的key
nyra "解释一下这个项目的结构"
```

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--source DIR\|URL` | GitHub 仓库地址 | 本地目录直接复制；URL 则 `git clone --depth 1` |
| `--prefix DIR` | `~/.local/share/nyra` | 安装位置（不能是 `/`、不能就是 `$HOME`、不能含空格） |
| `--bin-dir DIR` | `~/.local/bin` | 启动器位置 |
| `--with-systemd` | 关 | 再装 systemd 用户服务并 `enable --now` |
| `--uninstall` | — | 卸载（见下） |
| `--help` | — | 显示帮助 |

## 升级

再跑一遍安装命令就行，例如：

```bash
bash scripts/install.sh --source .
```

## 卸载

```bash
bash scripts/install.sh --uninstall
```

这会停掉并删掉 systemd 服务、删掉安装目录与启动器。**`~/.nyra` 会保留**，
里面的会话、任务与配置都在；想连数据一起清掉，自己删 `~/.nyra`。

## 排错

- `python3 版本太低`：装 Python 3.10+ 再跑；`python3 --version` 确认。
- `找不到 python3`：系统没装 Python，或它叫 `python` 不叫 `python3`；
  装好后确认 `command -v python3` 有输出。
- `git clone 失败`：检查网络与仓库地址；已 clone 好仓库时改用
  `--source .`，不走网络。
- `--with-systemd` 后提示“enable 失败”：安装本身已成功，只是这台机器
  没有用户 systemd 总线（比如容器、WSL 默认配置）；按
  [docs/linux-systemd.md](linux-systemd.md) 手动跑 `daemon-reload` 与
  `enable --now`，或直接用 `nyra schedule daemon` 在终端里跑。
- 装完 `nyra: command not found`：`~/.local/bin` 不在 PATH 里，见上文
  “安装”一节的 PATH 说明；也可以用完整路径 `~/.local/bin/nyra`。

## 安全说明

脚本只写 `$HOME` 里的三个地方（安装目录、启动器目录、`~/.nyra`，
`--with-systemd` 时再加 `~/.config/systemd/user/`）；不读、不存任何
API Key（Key 仍由你自己用环境变量给，systemd 服务用 drop-in 补，
见 [docs/linux-systemd.md](linux-systemd.md) 的说明）。
