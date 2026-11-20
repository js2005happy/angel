// src/webuiDesktop.ts — 桌面端界面（`nyra ui` 的 /，Tauri 桌面外壳加载的也是它）。
//
// 视觉按设计稿 docs/design/source（nyra-design v2：desktop.py 的 SIDE / mac() / win()，kit.py 的 LIGHT / DARK 令牌）：
// 侧栏 + 对话 + 右侧审阅面板（Diff / 计划 / 证据 / 终端）+ 状态栏；新对话空状态带四张起步卡片与自动化列表。
// 浅色默认，prefers-color-scheme: dark 跟随系统。窗口用系统原生标题栏，页面里不画假窗口按钮。
// 样式与脚本分别在 src/assets/desktop-app.css.txt / desktop-app.js.txt；入场动画复用 src/assets/mobile-splash.js.txt，
// 只在桌面外壳里（/api/info 的 shell === "desktop"）每次冷启动播一次。界面文案在 src/i18n.ts 的 d.* 键（复用部分 m.* 键）。
// 旧网页界面（PAGE_HTML，src/webuiPage.ts）保留导出，不再挂在 / 上。
import { MESSAGES, type Lang } from "./i18n.ts";
import APP_CSS from "./assets/desktop-app.css.txt" with { type: "text" };
import APP_JS from "./assets/desktop-app.js.txt" with { type: "text" };
import SPLASH_JS from "./assets/mobile-splash.js.txt" with { type: "text" };

/** 设计稿令牌（nyra-design v2 kit.py）。测试核对 CSS 里用的就是这几组值。 */
export const DESKTOP_COLORS = {
  light: { bg: "#FFFFFF", side: "#F7F7F8", panel: "#FBFBFB", line: "#ECECEE", fg: "#0D0D0D", mu: "#6E6E73", add: "#1A7F37", rm: "#CF222E" },
  dark: { bg: "#0B0B0C", side: "#141415", panel: "#111112", line: "#232325", fg: "#EDEDED", mu: "#8E8E93", add: "#3FB950", rm: "#F85149" },
};

/** 桌面页嵌入的文案：d.* 全部 + 复用的 m.*（步骤动词、规则名、回退、自动化、技能空状态等），中英两份。 */
export function desktopMessages(): Record<Lang, Record<string, string>> {
  const pick = (lang: Lang): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(MESSAGES[lang])) if (k.startsWith("d.") || k.startsWith("m.")) out[k] = v;
    return out;
  };
  return { zh: pick("zh"), en: pick("en") };
}
const I18N_JSON = JSON.stringify(desktopMessages()).replace(/</g, "\\u003c");

const SVG = (body: string, cls = "", vb = "0 0 24 24") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const STAR = '<path d="M8 0C9 5 11 7 16 8C11 9 9 11 8 16C7 11 5 9 0 8C5 7 7 5 8 0Z"/>';
const ICONS: Record<string, string> = {
  pencil: SVG('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
  search: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>'),
  clock: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  skills: SVG('<path d="M8 .6l2.7 2.7L8 6 5.3 3.3z M3.3 5.3 6 8 3.3 10.7.6 8z M12.7 5.3 15.4 8l-2.7 2.7L10 8z M8 10l2.7 2.7L8 15.4l-2.7-2.7z"/>', "f", "-1 -1 18 18"),
  plug: SVG('<path d="M9 7V3M15 7V3"/><path d="M6 7h12v4a6 6 0 0 1-12 0V7z"/><path d="M12 17v4"/>'),
  gear: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  up: SVG('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
  target: SVG('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
  shield: SVG('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/>'),
  box: SVG('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  list: SVG('<path d="M5 7h14M5 12h14M5 17h14"/>'),
  play: SVG('<path d="M7 5l11 7-11 7V5z"/>'),
  diamond: SVG('<path d="M12 4l8 8-8 8-8-8 8-8z"/>'),
  dot: SVG('<circle cx="12" cy="12" r="2.5"/>', "f"),
  panel: SVG('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M13 5v14"/>'),
  pie: SVG('<circle cx="12" cy="12" r="8"/><path d="M12 4v8h8"/>'),
  undo: SVG('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
};
const TEMPLATES = Object.entries(ICONS).map(([k, v]) => `<template id="ic-${k}">${v}</template>`).join("");
const NAV = ([["new", "pencil", "d.newThread", true], ["search", "search", "d.search", true], ["automations", "clock", "d.automations", false], ["skills", "skills", "d.skills", false], ["mcp", "plug", "d.mcp", false]] as const)
  .map(([id, ic, label, kbd]) => `<button class="si" id="nav-${id}"><i>${ICONS[ic]}</i><span data-i="${label}"></span>${kbd ? `<span class="k" id="kbd-${id}"></span>` : ""}</button>`).join("");

export const DESKTOP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Nyra</title>
<link rel="icon" href="/m/favicon.svg" type="image/svg+xml">
<style>${APP_CSS}</style>
</head><body>
${TEMPLATES}
<div id="splash" class="splash hidden" aria-hidden="true"></div>
<div class="app">
<aside class="side" aria-label="Nyra">
${NAV}
<div class="sh"><span data-i="d.projects"></span></div>
<nav class="tree" id="threads"></nav>
<button class="si" id="nav-settings"><i>${ICONS.gear}</i><span data-i="d.settings"></span></button>
</aside>
<main class="main">
<header class="top" id="top"></header>
<div class="cols">
<section class="view" id="v-home"><div class="home">
<div class="hero"><div class="mk">${SVG(STAR, "", "0 0 16 16").replace("<svg", '<svg fill="currentColor"')}</div>
<h1><span data-i="d.home.before"></span> <span class="proj" id="home-proj"></span><span id="home-after" data-i="d.home.after"></span></h1></div>
<div class="comp"><textarea id="home-input" rows="1" data-ip="d.home.placeholder"></textarea><div class="rw" id="home-pills"></div></div>
<div class="cards" id="cards"></div>
<div class="autos"><div class="lbl" data-i="d.automations"></div><div id="home-autos"></div></div>
</div></section>
<section class="view hidden" id="v-thread">
<div class="feed" id="feed"><div class="col" id="col"></div></div>
<div class="comp"><textarea id="input" rows="1" data-ip="d.followUp"></textarea><div class="rw" id="thread-pills"></div></div>
</section>
<section class="view page hidden" id="v-automations"><div class="pagein"><h2 data-i="d.automations"></h2><p class="desc" data-i="d.auto.desc"></p><div id="auto-list"></div></div></section>
<section class="view page hidden" id="v-skills"><div class="pagein"><h2 data-i="d.skills"></h2><p class="desc" data-i="d.skills.desc"></p><div id="skill-list"></div></div></section>
<section class="view page hidden" id="v-mcp"><div class="pagein"><h2 data-i="d.mcp"></h2><p class="desc" data-i="d.set.mcp.desc"></p><div id="mcp-list"></div></div></section>
<section class="view settings hidden" id="v-settings"><nav class="setnav" id="set-nav"></nav><div class="setbody" id="set-body"></div></section>
<aside class="review hidden" id="review"><div class="rt" id="rtabs"></div><div class="rbody" id="rbody"></div><div class="term hidden" id="term"></div></aside>
</div>
<footer class="status" id="status"></footer>
</main>
</div>
<div class="overlay hidden" id="search-dlg"><div class="dlg"><input class="srch" id="search-q" data-ip="d.searchPh" autocomplete="off"><div class="res" id="search-res"></div></div></div>
<div class="overlay setup hidden" id="setup" role="dialog" aria-modal="true"><div class="box">
<div class="mk">${SVG(STAR, "", "0 0 16 16").replace("<svg", '<svg fill="currentColor"')}</div>
<h1 data-i="d.setup.title"></h1><p class="lead" data-i="d.setup.lead"></p>
<div class="step"><b>1</b><span data-i="d.setup.step1"></span></div>
<div class="provs" id="setup-provs"></div>
<div id="setup-step2"><div class="step"><b>2</b><span data-i="d.setup.step2"></span></div>
<div class="keyline"><input class="fld" id="setup-key" type="password" autocomplete="off" spellcheck="false"></div>
<p class="hint2" id="setup-store"></p></div>
<div class="result" id="setup-result" role="status"></div>
<div class="foot"><button class="linkbtn" id="setup-skip" data-i="d.setup.skip"></button><span class="sp"></span>
<button class="tbtn" id="setup-test" data-i="d.key.test"></button><button class="tbtn p" id="setup-save" data-i="d.setup.save"></button></div>
</div></div>
<script>window.NYRA_I18N=${I18N_JSON};</script>
<script>${SPLASH_JS}</script>
<script>${APP_JS}</script>
</body></html>`;
