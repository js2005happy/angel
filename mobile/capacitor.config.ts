import type { CapacitorConfig } from "@capacitor/cli";

// 手机端 Capacitor 配置。
// 说明：这个 App 是个“启动器壳”，不是把 Nyra 搬进手机——Nyra 的 agent、
// 工具与数据仍在电脑上跑。壳里只装一张静态启动页（www/index.html），
// 用户填电脑的局域网地址与配对码后，WebView 跳到电脑上 `nyra ui` 的
// 手机页（/m）。所以不需要 server.url（电脑地址每次都可能不一样，
// 写死在配置里没有意义），也不需要任何 Capacitor 插件。
const config: CapacitorConfig = {
  appId: "dev.nyra.mobile",
  appName: "Nyra",
  webDir: "www",
  backgroundColor: "#0B0B0C",
};

export default config;
