# Linux 打包（tarball 与 .deb）

## Node 二进制版（0.5.0 唯一方式）

`scripts/build-package-node.sh` 把已编好的 Linux 二进制打成发布物，版本号只从 `package.json` 的 `version` 读。

```bash
bash scripts/build-binaries.sh --only linux-x64   # 先编出二进制
bash scripts/build-package-node.sh                # 产出到 ./dist/
bash scripts/build-package-node.sh --no-deb       # 只要 tarball
bash scripts/build-package-node.sh --arch arm64 --binary dist/nyra-linux-arm64
bash scripts/build-package-node.sh --out-dir /tmp/nyra-pkg
```

产出：

| 文件 | 内容 |
| --- | --- |
| `nyra-node-<版本>.tar.gz` | 解压即用的归档，顶层目录 `nyra-node-<版本>/`，含 `nyra` 二进制、README.md、GUIDE.md、CHANGELOG.md、LICENSE 与 `docs/linux-*.md` |
| `nyra-node_<版本>_amd64.deb` | Debian 包，装到 `/usr/share/nyra`，启动器 `/usr/bin/nyra`，只声明 `Depends: libc6`（不要求 Python、不要求 Node） |

白名单打包：`.git`、`.venv`、`__pycache__`、`dist/` 里的其他产物、`node_modules/` 绝不进包。没有 `dpkg-deb` 的机器上只产出 tarball 并警告，不报错。

> 0.4.0 注：旧 Python 打包脚本 `scripts/build_package.sh` 已随 Python 一起删除；`nyra-<版本>.tar.gz` / `nyra_<版本>_all.deb`（`Depends: python3`）不再产出。

## 核对

```bash
tar -tzf dist/nyra-node-0.5.0.tar.gz | head        # 看归档内容
dpkg-deb --info dist/nyra-node_0.5.0_amd64.deb     # 看版本、依赖
dpkg-deb --contents dist/nyra-node_0.5.0_amd64.deb # 看安装路径
```

## 安装

### .deb（Debian / Ubuntu，需要 root）

```bash
sudo dpkg -i nyra-node_0.5.0_amd64.deb
nyra --version            # 应输出 Nyra 0.5.0 (node runtime)
```

`.deb` 不装 maintainer 脚本：不碰用户 systemd、不动 `~/.nyra`。
装完按需启用调度器服务，见 [Linux systemd 服务](linux-systemd.md)
（把 unit 从 `/usr/share/nyra/systemd/nyra-scheduler.service` 复制到
`~/.config/systemd/user/`，并把 `WorkingDirectory` 改成 `/usr/share/nyra`）。

卸载：`sudo dpkg -r nyra-node`（`~/.nyra` 里的数据不受影响）。

### tarball（任意 Linux 发行版，不需要 root）

```bash
tar -xzf nyra-node-0.5.0.tar.gz
./nyra-node-0.5.0/nyra --version   # 直接跑解压出的二进制
```

想装进 `~/.local/bin`（并可选 systemd 服务），用 [Linux 安装](linux-install.md)
里的 `scripts/install-node.sh --from-file`，指向解压出的 `nyra` 二进制。

## 安全说明

- 打包脚本只读仓库文件、只写产出目录，不联网、不用 sudo；
- `.deb` 的启动器是单文件二进制本身，不含密钥、不写配置，密钥仍按各 provider 文档由用户自己配置。
