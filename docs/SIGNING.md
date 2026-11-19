# 签名与验证（SIGNING）

Nyra 有三层签名，分别解决不同问题。**第 1 层已经自动化，第 2 层是本地约定，第 3 层需要商业证书（当前未启用）。**

| 层 | 签什么 | 解决什么 | 状态 |
|---|---|---|---|
| 1 | Release 产物 | 用户能证明下载的二进制确实由本仓库构建、且没被篡改 | ✅ 已自动（`.github/workflows/release-sign.yml`） |
| 2 | Git 提交 | 提交确实来自维护者本人 | ⚙️ 本地 SSH 签名（见下） |
| 3 | Windows/macOS 二进制 | 消除 SmartScreen / Gatekeeper 首次运行警告 | ⏳ 需 Certum OSS 证书 / Apple Developer ID |

---

## 第 1 层：Release 产物签名（sigstore keyless）

### 为什么用 keyless 而不是 GPG 长期密钥

- 长期私钥要么进 CI secrets（可被窃取、无法轮换），要么人工签（发版必忘）。
- keyless 用 GitHub OIDC 换一张 **10 分钟有效**的证书，签名写入 [Rekor](https://rekor.sigstore.dev) 透明日志。
- 验证方不需要预先信任任何公钥，只需要信任"这个身份 = 这个仓库的这条 workflow"。

### 打标签发版后自动发生

```
git tag v0.5.0 && git push origin v0.5.0
→ Release 发布 → release-sign.yml 触发
→ 下载全部产物 → 生成 SHA256SUMS → cosign 签名 → SLSA 来源证明 → 回传 Release
```

Release 页面会多出这些文件：

| 文件 | 作用 |
|---|---|
| `SHA256SUMS` | 每个产物的 sha256 |
| `SHA256SUMS.sig` | 对清单的签名 |
| `SHA256SUMS.pem` | 签名时的短期证书（含 OIDC 身份） |
| `SHA256SUMS.bundle` | 签名 + 证书 + Rekor 凭证（推荐用这个验证） |
| `*.intoto.jsonl` | SLSA 来源证明 |

### 用户怎么验证

```bash
# 一键（自动下载 + 验签 + 校哈希 + 验来源）
bash scripts/verify-release.sh v0.5.0

# 手动两步
cosign verify-blob SHA256SUMS.bundle \
  --certificate-identity-regexp "^https://github\.com/js2005happy/nyra/\.github/workflows/release-sign\.yml@refs/" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum -c SHA256SUMS
```

Windows 用 PowerShell：

```powershell
cosign verify-blob SHA256SUMS.bundle `
  --certificate-identity-regexp "^https://github\.com/js2005happy/nyra/\.github/workflows/release-sign\.yml@refs/" `
  --certificate-oidc-issuer https://token.actions.githubusercontent.com `
  SHA256SUMS
Get-FileHash .\nyra-windows-x64.exe -Algorithm SHA256   # 与 SHA256SUMS 对照
```

再核来源证明：

```bash
gh attestation verify nyra-linux-x64 --repo js2005happy/nyra
```

---

## 第 2 层：Git 提交签名（SSH，无需 GPG）

比 GPG 简单：直接用已有的 SSH 密钥，GitHub 也支持。

```bash
# 一次性配置（仓库级）
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git config commit.gpgsign true
git config tag.gpgsign true

# 验证
git log --show-signature -1
```

然后在 GitHub → Settings → SSH and GPG keys → **New SSH key** → Key type 选 **Signing Key**，粘贴同一个 `id_ed25519.pub`。

之后每个提交在 GitHub 上会显示 **Verified**；改过的历史会显示 Unverified。

---

## 第 3 层：二进制代码签名（可选，需商业证书）

当前 `node-binaries.yml` 与 `desktop.yml` 的注释都写着"产物未签名、未公证"，所以 Windows SmartScreen / macOS Gatekeeper 会拦首次运行。补齐方式：

### Windows（Authenticode + Certum Open Source Code Signing）

Certum 的 OSS 证书**只发给开源项目**，正好符合本仓库（MIT）。流程：

1. 在 Certum 申请 **Open Source Code Signing**（需提供仓库地址与许可证证明）。
2. 拿到证书后，GitHub Actions 里注入两个 secret：
   - `WINDOWS_CERT_PFX_BASE64`（`certutil -encode` 后的 base64）
   - `WINDOWS_CERT_PASSWORD`
3. 在 `node-binaries.yml` 的 Windows 产物步骤后加：

```yaml
      - name: Sign Windows binary
        if: matrix.os == 'windows-latest'
        shell: pwsh
        env:
          PFX_B64: ${{ secrets.WINDOWS_CERT_PFX_BASE64 }}
          PFX_PWD: ${{ secrets.WINDOWS_CERT_PASSWORD }}
        run: |
          $pfx = Join-Path $env:RUNNER_TEMP 'cert.pfx'
          [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:PFX_B64))
          & "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" sign `
            /fd sha256 /td sha256 /tr http://time.certum.pl `
            /f $pfx /p $env:PFX_PWD `
            dist\nyra-windows-x64.exe
          & "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" verify /pa /all dist\nyra-windows-x64.exe
```

**注意**：`/tr` 时间戳必须带——否则证书到期后旧签名会一起失效。

### macOS（Developer ID + notarization）

需要 Apple Developer Program（$99/年）。Tauri 侧配 `APPLE_CERTIFICATE`、`APPLE_ID`、`APPLE_TEAM_ID` 等 secret，`desktop.yml` 现在用的是 `signingIdentity "-"`（ad-hoc），换成真实身份后 `codesign` + `notarytool submit --wait` 即可。

> 顺序建议：先把第 1、2 层跑顺（零成本、立刻生效），第 3 层等证书下来再补。**第 1 层比第 3 层更重要**——SmartScreen 只是"提示"，而产物签名解决的是"下载到的是不是官方构建"。

---

## 常见问题

**Q：keyless 签名会不会因为证书 10 分钟就过期而失效？**
不会。证书短命是设计：验证时校验的是「签名时刻」证书链 + Rekor 里的时间戳凭证，与现在有没有过期无关。

**Q：能不能不用 cosign，改用 GPG + SHA256SUMS？**
可以，但你得长期保管私钥并让用户预先导入公钥。keyless 的优势是零密钥分发。

**Q：仓库是 private 的话 keyless 还能用吗？**
能，OIDC 身份基于仓库，与可见性无关；但用户验证需要能访问 Release。

**Q：产物里有个文件签名失败怎么办？**
`release-sign.yml` 最后一步是「验证自己的签名」，失败会让整个 job 红掉——这是有意的 fail-closed，不允许静默产出未签名的发布。
