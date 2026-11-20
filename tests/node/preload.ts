// tests/node/preload.ts — 全局测试前置（经 bunfig.toml 的 [test] preload 加载）。
//
// 为什么需要：`src/i18n.ts` 的语言是**模块级全局**（`current`）。bun 在同一进程里跑
// 多个测试文件，于是「A 文件切到 en → B 文件断言中文文案」就会随执行顺序/并发而红。
//
// CI 已经真实发生过一次：`test-i18n-tooling` 切到 en 后，`test-redlines` 的
// 「上线红线自检」断言挂掉。当时只给那一条加了 setLang("zh")，是**治症状**。
//
// 这里在每个用例开始前把语言复位，所有文件都从同一起点出发。要测英文的用例
// 自己在用例内 setLang("en") 即可，不受影响。
import { beforeEach } from "bun:test";
import { setLang } from "../../src/i18n.ts";

beforeEach(() => {
  setLang("zh");
});
