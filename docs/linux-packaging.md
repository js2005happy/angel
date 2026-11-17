# Linux 打包（tarball 与 .deb）

Nyra 是零 pip 依赖的纯 Python 程序，打包不需要编译：`scripts/build_package.sh`
从当前检出产出两件发布物，版本号只从 `nyra/__init__.py` 的 `__version__` 读。

## 构建

```bash
./scripts/build_package.sh            # 产出到 ./dist/
./scripts/build_package.sh --out-dir /tmp/nyra-pkg
./scripts/build_package.sh --no-deb   # 只要 tarball
```

产出：

| 文件 | 内容 |
| --- | --- |
| `nyra-<版本>.tar.gz` | 解压即用的归档，顶层目录 `nyra-<版本>/`，含 `nyra/` 程序、`scripts/install.sh`、`systemd/nyra-scheduler.service`、`README.md`、`GUIDE.md`、`CHANGELOG.md`、`LICENSE` 与 `docs/linux-*.md` |
| `nyra_<版本>_all.deb` | Debian 包，装到 `/usr/share/nyra`，启动器 `/usr/bin/nyra`，只声明 `Depends: python3 (>= 3.10)` |

白名单打包：`.git`、`.venv`、`__pycache__`、`dist/` 绝不进包。没有 `dpkg-deb`
的机器上只产出 tarball 并警告，不报错。

## 核对

```bash
tar -tzf dist/nyra-0.3.0.tar.gz | head        # 看归档内容
dpkg-deb --info dist/nyra_0.3.0_all.deb       # 看版本、依赖
dpkg-deb --contents dist/nyra_0.3.0_all.deb   # 看安装路径
```

## 安装

### .deb（Debian / Ubuntu，需要 root）

```bash
sudo dpkg -i nyra_0.3.0_all.deb
nyra --version            # 应输出 Nyra 0.3.0
```

`.deb` 不装 maintainer 脚本：不碰用户 systemd、不动 `~/.nyra`。
装完按需启用调度器服务，见 [Linux systemd 服务](linux-systemd.md)
（把 unit 从 `/usr/share/nyra/systemd/nyra-scheduler.service` 复制到
`~/.config/systemd/user/`，并把 `WorkingDirectory` 改成 `/usr/share/nyra`）。

卸载：`sudo dpkg -r nyra`（`~/.nyra` 里的数据不受影响）。

### tarball（任意 Linux 发行版，不需要 root）

```bash
tar -xzf nyra-0.3.0.tar.gz
./nyra-0.3.0/scripts/install.sh --source ./nyra-0.3.0
```

`install.sh` 的完整用法见 [Linux 安装](linux-install.md)。
直接解压使用亦可：在解压出的目录里跑 `python3 -m nyra --version`。

## 安全说明

- 打包脚本只读仓库文件、只写产出目录，不联网、不装 pip 依赖、不用 sudo；
- `.deb` 的启动器是两行 shell：`PYTHONPATH=/usr/share/nyra exec /usr/bin/python3 -m nyra`，
  不含密钥、不写配置，密钥仍按各 provider 文档由用户自己配置。
