"""The single self-contained page served by `python3 -m nyra ui`.

Inline HTML/CSS/JS only: no CDN or other external resource. Fonts (Inter,
JetBrains Mono, Latin subsets) ship in nyra/webui_fonts.py and are loaded
by the page through the FontFace API; Chinese falls back to system fonts.

Design (desktop v2, 2026-11-18): black-and-white minimal, after the
finalized desktop mockups — sidebar with sessions grouped by project, a
conversation column with collapsible tool activity and inline approval
cards, a composer with mode / model / plan-mode controls, and a review
pane (diff, plan, evidence, terminal, artifacts, usage). Light and dark
follow the system; the brand mark is docs/assets/nyra-mark.svg inlined.
Earlier palettes (ink/gold, then sage) are retired for this page.

Everything shown comes from the real API: nothing here is mock data.
"""


PAGE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<link rel="manifest" id="manifest-link" href="/manifest.json">
<link rel="apple-touch-icon" id="apple-touch-icon" href="/nyra-mark.svg">
<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0B0B0C" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>Nyra</title>
<style>
:root{--bg:#FFFFFF;--side:#F7F7F8;--panel:#FBFBFB;--line:#ECECEE;--line2:#E2E2E5;--fg:#0D0D0D;--fg2:#3A3A3E;--mu:#6B6B72;--mu2:#A1A1A6;--chip:#F2F2F3;--hover:#EDEDEF;--add:#1A7F37;--addbg:#E9F6EC;--rm:#CF222E;--rmbg:#FCEBEC;--warn:#9A6700;--btn:#0D0D0D;--btnfg:#FFFFFF;--focus:#0D0D0D;--shadow:0 8px 30px rgba(0,0,0,.06);
--sans:Inter,system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Microsoft YaHei",monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B0C;--side:#141415;--panel:#111112;--line:#232325;--line2:#2C2C2F;--fg:#EDEDED;--fg2:#C8C8CC;--mu:#8E8E93;--mu2:#5E5E63;--chip:#1C1C1E;--hover:#1F1F22;--add:#3FB950;--addbg:rgba(63,185,80,.12);--rm:#F85149;--rmbg:rgba(248,81,73,.12);--warn:#D29922;--btn:#EDEDED;--btnfg:#0B0B0C;--focus:#EDEDED;--shadow:0 8px 30px rgba(0,0,0,.35);color-scheme:dark}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
[hidden]{display:none!important}
body{background:var(--bg);color:var(--fg);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased;overflow:hidden}
button,select,textarea,input{font:inherit;color:inherit}
button{cursor:pointer}
code,pre,kbd,.mono{font-family:var(--mono)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.app{display:flex;height:100%;min-height:0}
/* sidebar */
.side{width:260px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.side-top{display:flex;align-items:center;gap:10px;padding:14px 16px 10px}
.mark{width:22px;height:22px;color:var(--fg);flex:none}
.brand{font-weight:600;font-size:15px;letter-spacing:-.01em}
.ver{font:11px var(--mono);color:var(--mu);margin-left:auto}
.side-scroll{flex:1;overflow:auto;padding:4px 8px 8px;min-height:0}
.si{width:100%;height:32px;display:flex;align-items:center;gap:10px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--fg);text-align:left;font-size:13.5px;text-decoration:none}
.si:hover{background:var(--hover)}.si.on{background:var(--hover)}
.si svg.i{color:var(--mu)}
.si kbd{margin-left:auto;font:11px var(--mono);color:var(--mu);background:none}
.search{display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:8px;color:var(--mu)}
.search:focus-within{background:var(--hover)}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:13.5px;color:var(--fg)}
.search input::placeholder{color:var(--mu)}
.search kbd{font:11px var(--mono);color:var(--mu)}
.sh{font-size:11.5px;color:var(--mu);margin:16px 10px 4px;display:flex;align-items:center;justify-content:space-between}
.proj{width:100%;height:30px;display:flex;align-items:center;gap:6px;padding:0 10px;border:0;background:none;color:var(--fg);font-weight:600;font-size:13.5px;border-radius:8px;text-align:left}
.proj:hover{background:var(--hover)}
.proj .chev{width:12px;height:12px;transition:transform .15s}
.proj[aria-expanded="false"] .chev{transform:rotate(-90deg)}
.proj .cur{margin-left:auto;font:500 10.5px var(--sans);color:var(--mu)}
.th{width:100%;min-height:30px;display:flex;align-items:center;gap:8px;padding:0 10px 0 26px;border:0;border-radius:8px;background:none;color:var(--mu);text-align:left;font-size:13.5px}
.th.flat{padding-left:10px}
.th:hover{background:var(--hover);color:var(--fg)}
.th.on{background:var(--hover);color:var(--fg)}
.th .tt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.th .t{font-size:11.5px;color:var(--mu);flex:none}
.spin{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--mu2);border-top-color:var(--fg);flex:none;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--mu)}
.dot.warn{background:var(--warn)}.dot.ok{background:var(--add)}.dot.bad{background:var(--rm)}
.empty{color:var(--mu);font-size:13px;padding:6px 10px}
.side-foot{border-top:1px solid var(--line);padding:8px}
/* main */
.main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.top{height:48px;flex:none;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;padding:0 14px 0 18px}
.crumb{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.crumb .p{color:var(--mu);white-space:nowrap}
.crumb .sep{color:var(--mu2)}
.crumb b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pill{height:26px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:999px;border:1px solid var(--line2);font-size:12px;color:var(--mu);white-space:nowrap}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.tbtn{height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:8px;border:1px solid var(--line2);background:none;color:var(--fg);font-size:12.5px;text-decoration:none;white-space:nowrap}
.tbtn:hover{background:var(--hover)}
.tbtn[aria-pressed="true"]{background:var(--hover)}
.tbtn.p{background:var(--btn);color:var(--btnfg);border-color:var(--btn);font-weight:600}
.tbtn.p:hover{opacity:.9}
.tbtn:disabled{opacity:.45;cursor:default}
.icon-btn{width:32px;padding:0;justify-content:center}
.menu{display:none}
.cols{flex:1;display:flex;min-height:0}
.conv{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.feed{flex:1;overflow:auto;padding:26px 20px 12px}
.col{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.u{align-self:flex-end;background:var(--chip);padding:10px 14px;border-radius:16px;max-width:min(560px,88%);white-space:pre-wrap;overflow-wrap:anywhere}
.u.planreq{border:1px dashed var(--line2);background:none}
.u .tag{display:block;font-size:11.5px;color:var(--mu);margin-bottom:2px}
.a{line-height:1.65;overflow-wrap:anywhere}
.a p{margin:0 0 8px}.a p:last-child{margin:0}
.a pre{background:var(--chip);padding:10px 12px;border-radius:10px;overflow:auto;font-size:12.5px;line-height:1.5}
.a code{font-size:12.5px;background:var(--chip);padding:1px 5px;border-radius:5px}
.a pre code{background:none;padding:0}
.a a{color:var(--fg);text-decoration:underline;text-underline-offset:2px}
.a ul,.a ol{margin:4px 0 8px;padding-left:22px}
.a h3,.a h4{margin:12px 0 6px;font-size:15px}
.welcome{margin:12vh auto 0;text-align:center;max-width:520px}
.welcome .mark{width:40px;height:40px;margin:0 auto 14px}
.welcome h1{font-size:22px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
.welcome p{color:var(--mu);margin:0 0 18px}
.sugs{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.sug{border:1px solid var(--line2);background:none;border-radius:999px;padding:6px 12px;font-size:12.5px;color:var(--fg)}
.sug:hover{background:var(--hover)}
/* activity log */
.log{color:var(--mu);font-size:13px}
.log>summary{list-style:none;display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--mu);border-radius:6px;padding:1px 2px}
.log>summary::-webkit-details-marker{display:none}
.log>summary .chev{width:12px;height:12px;transition:transform .15s}
.log:not([open])>summary .chev{transform:rotate(-90deg)}
.log>summary:hover{color:var(--fg)}
.rows{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.row>summary{list-style:none;display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:6px;cursor:pointer;min-width:0}
.row>summary::-webkit-details-marker{display:none}
.row>summary:hover{background:var(--hover)}
.row .vb{flex:none}
.row .tg{font:12px var(--mono);color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.row .st{margin-left:auto;flex:none;font-size:11.5px}
.row .st.bad{color:var(--rm)}
.row .detail{margin:4px 0 8px 28px;border:1px solid var(--line);border-radius:8px;background:var(--panel);overflow:hidden}
.row .detail h6{margin:0;padding:6px 10px 0;font:500 11px var(--sans);color:var(--mu)}
.row .detail pre{margin:0;padding:6px 10px 8px;font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;color:var(--fg)}
.note{font-size:12.5px;color:var(--mu);padding-left:4px}
.note.bad{color:var(--rm)}
/* files card */
.files{border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.files button{width:100%;display:flex;align-items:center;gap:10px;padding:9px 12px;border:0;border-top:1px solid var(--line);background:none;text-align:left;font:12.5px var(--mono);color:var(--fg)}
.files button:first-child{border-top:0}
.files button:hover{background:var(--hover)}
.files .fp{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.add{color:var(--add)}.del{color:var(--rm)}
/* approval card */
.appr{border:1px solid var(--line2);border-radius:12px;background:var(--panel);overflow:hidden}
.appr-h{display:flex;align-items:center;gap:12px;padding:12px 14px;flex-wrap:wrap}
.appr-h .ic{width:28px;height:28px;border-radius:8px;border:1px solid var(--line2);display:grid;place-items:center;flex:none}
.appr-h .tx{flex:1;min-width:200px}
.appr-h .tx b{display:block;font:500 13px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.appr-h .tx small{display:block;color:var(--mu);font-size:12px;margin-top:2px}
.appr-h .acts{display:flex;gap:6px;flex-wrap:wrap}
.appr pre{margin:0;border-top:1px solid var(--line);max-height:320px;overflow:auto;font-size:12px;line-height:20px;padding:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.appr.done .acts,.appr.done pre{display:none}
.appr .res{font-size:12px;color:var(--mu)}
.appr .res.ok{color:var(--add)}.appr .res.bad{color:var(--rm)}
/* plan card */
.plan-card{border:1px solid var(--line2);border-radius:12px;overflow:hidden}
.plan-card header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-weight:600;flex-wrap:wrap}
.plan-card header small{font:11.5px var(--mono);color:var(--mu);font-weight:400}
.plan-card .a{padding:12px 14px;max-height:420px;overflow:auto}
.plan-card footer{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--line);flex-wrap:wrap}
.plan-card footer span{font-size:12px;color:var(--mu);flex:1;min-width:180px}
/* diff lines */
.dl{display:flex;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/20px var(--mono)}
.dl .n{width:44px;text-align:right;padding-right:10px;color:var(--mu);flex:none;user-select:none}
.dl .m{width:16px;flex:none;color:var(--mu);user-select:none}
.dl .c{flex:1;min-width:0;padding-right:10px}
.dl.a{background:var(--addbg)}.dl.a .n,.dl.a .m{color:var(--add)}
.dl.d{background:var(--rmbg)}.dl.d .n,.dl.d .m{color:var(--rm)}
.dl.h{color:var(--mu);background:var(--chip)}
/* composer */
.comp-wrap{padding:0 20px 14px;flex:none}
.comp{max-width:740px;margin:0 auto;border:1px solid var(--line2);border-radius:18px;background:var(--panel);padding:10px 12px 8px;box-shadow:var(--shadow)}
.comp:focus-within{border-color:var(--mu)}
.comp textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;font-size:14px;min-height:24px;max-height:200px;padding:4px 4px 10px;color:var(--fg)}
.comp textarea::placeholder{color:var(--mu)}
.comp .rw{display:flex;align-items:center;gap:6px;min-width:0}
.pk{height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 4px 0 10px;border-radius:999px;background:var(--chip);font-size:12.5px;color:var(--fg);position:relative;max-width:240px;min-width:0;flex:none}
.pk select{appearance:none;-webkit-appearance:none;border:0;background:transparent;font-size:12.5px;padding:0 18px 0 0;height:30px;cursor:pointer;min-width:0;max-width:200px;text-overflow:ellipsis;color:var(--fg);field-sizing:content}
.pk select option{color:initial}
.pk:after{content:"";position:absolute;right:10px;top:13px;width:5px;height:5px;border-right:1.5px solid var(--mu);border-bottom:1.5px solid var(--mu);transform:rotate(45deg);pointer-events:none}
.pk:focus-within{outline:2px solid var(--focus);outline-offset:2px}
.pk select:focus-visible{outline:0}
.tg-plan{flex:none;height:30px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:999px;border:1px solid transparent;background:transparent;color:var(--mu);font-size:12.5px}
.tg-plan:hover{color:var(--fg)}
.tg-plan[aria-pressed="true"]{background:var(--btn);color:var(--btnfg)}
.comp .hint{font-size:12px;color:var(--mu);margin-left:4px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.send{margin-left:auto;width:34px;height:34px;border-radius:50%;border:0;background:var(--btn);color:var(--btnfg);display:grid;place-items:center;flex:none}
.send:disabled{opacity:.35;cursor:default}
.send svg.i{width:18px;height:18px}
/* status bar */
.status{height:28px;flex:none;border-top:1px solid var(--line);display:flex;align-items:center;gap:16px;padding:0 14px;color:var(--mu);font-size:11.5px;background:var(--side);overflow:hidden;white-space:nowrap}
.status span{display:inline-flex;align-items:center;gap:6px}
.status .r{margin-left:auto}
/* review pane */
.review{width:440px;flex:none;border-left:1px solid var(--line);display:flex;flex-direction:column;background:var(--panel);min-height:0}
.review[hidden]{display:none}
.rt{height:44px;flex:none;display:flex;align-items:center;gap:2px;padding:0 8px;border-bottom:1px solid var(--line);overflow-x:auto}
.tab{height:28px;padding:0 9px;border-radius:7px;display:inline-flex;align-items:center;gap:5px;color:var(--mu);font-size:12.5px;border:0;background:none;white-space:nowrap}
.tab:hover{color:var(--fg)}
.tab.active{background:var(--hover);color:var(--fg)}
.tab .ct{font:11px var(--mono);color:var(--mu)}
.rt .x{margin-left:auto}
.pane{flex:1;overflow:auto;min-height:0}
.pane[hidden]{display:none}
.pane-pad{padding:12px 14px}
.fh{display:flex;align-items:center;gap:8px;padding:12px 14px 6px;font:12px var(--mono);position:sticky;top:0;background:var(--panel);z-index:1}
.fh .fp{flex:1;min-width:0;overflow-wrap:anywhere}
.fh .stt{font:11px var(--sans);color:var(--mu);border:1px solid var(--line2);border-radius:999px;padding:0 7px}
.fblock{border-bottom:1px solid var(--line);padding-bottom:8px}
.fblock .src{font:11px var(--sans);color:var(--mu);padding:0 14px 6px}
.term{padding:10px 14px;border-bottom:1px solid var(--line);font:11.5px/18px var(--mono)}
.term .cmd{color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere}
.term pre{margin:6px 0 0;color:var(--mu);white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto}
.card{border:1px solid var(--line2);border-radius:10px;padding:12px;margin-bottom:12px;background:var(--bg)}
.card h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--mu)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px}
.kv span:nth-child(odd){color:var(--mu)}.kv span:nth-child(even){overflow-wrap:anywhere}
.plan-list ol{margin:0;padding-left:20px;font-size:13px}.plan-list li{margin:3px 0}
.ev{display:block;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.ev:last-child{border:0}.ev a{color:var(--fg)}.ev small{display:block;color:var(--mu);font:11px var(--mono)}
.hint2{font-size:12px;color:var(--mu);margin:6px 0 0}
/* artifacts */
.art-list{display:grid;gap:6px;margin-bottom:12px}
.art-item{display:flex;align-items:center;gap:8px;text-align:left;border:1px solid var(--line2);background:var(--bg);border-radius:8px;padding:8px 10px;font-size:13px;width:100%}
.art-item:hover{background:var(--hover)}
.art-item.active{border-color:var(--fg)}
.art-item .k{font:600 10.5px var(--mono);border-radius:999px;padding:1px 7px;background:var(--chip);color:var(--mu);flex:none}
.art-item b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.art-view{border:1px solid var(--line2);border-radius:10px;background:var(--bg);overflow:hidden;margin-bottom:12px}
.art-view h5{margin:0;padding:9px 12px;font-size:12.5px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.art-view .art-body{padding:10px 12px;max-height:420px;overflow:auto}
.art-view .art-body pre{background:var(--chip);padding:10px 12px;border-radius:8px;overflow:auto;font-size:12.5px;margin:0}
.art-view .art-body p{margin:0 0 8px}.art-view .art-body p:last-child{margin:0}
.art-view .art-body code{background:var(--chip);padding:1px 5px;border-radius:5px;font-size:12.5px}
.art-view .art-body pre code{background:none;padding:0}
.art-view .art-body h3,.art-view .art-body h4{margin:10px 0 6px;font-size:15px}
.art-view .art-body ul,.art-view .art-body ol{margin:4px 0 8px;padding-left:22px}
.art-view .art-body a{color:var(--fg)}
.art-view iframe{width:100%;height:340px;border:0;display:block;background:#fff}
.art-note{font-size:11.5px;color:var(--mu);padding:8px 12px;border-top:1px solid var(--line)}
/* pages (settings etc.) */
.pagev{flex:1;overflow:auto;padding:28px 24px 40px;min-height:0}
.pagev[hidden]{display:none}
.pagev .in{max-width:760px;margin:0 auto}
.pagev h2{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 4px}
.pagev .sub{color:var(--mu);font-size:13px;margin:0 0 20px}
.pagev h3{font-size:13px;font-weight:600;margin:24px 0 10px}
.pagev code{font-size:12px;background:var(--chip);padding:1px 5px;border-radius:5px}
.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.form-row label{font-size:13px;color:var(--mu)}
.form-row input,.form-row select{border:1px solid var(--line2);background:var(--bg);border-radius:8px;height:32px;padding:0 10px;font-size:13px;color:var(--fg)}
.form-row input{flex:1;min-width:160px}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:9px;overflow:hidden}
.seg button{border:0;background:none;padding:6px 14px;font-size:13px;color:var(--mu)}
.seg button+button{border-left:1px solid var(--line2)}
.seg button.active{background:var(--btn);color:var(--btnfg)}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
td,th{text-align:left;padding:7px 4px;border-bottom:1px solid var(--line)}th{color:var(--mu);font-weight:500}
td code{font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.toolcard,.skillcard{border:1px solid var(--line2);border-radius:10px;padding:12px}
.toolcard b{font:500 12.5px var(--mono)}
.toolcard p,.skillcard p{margin:6px 0 0;font-size:12.5px;color:var(--mu)}
.skillcard{margin-bottom:8px}.skillcard b{font-size:13.5px;font-weight:600}
.badge{font-size:11px;border:1px solid var(--line2);border-radius:999px;padding:0 7px;color:var(--mu);margin-left:6px}
.sched-row{display:flex;align-items:center;gap:12px;border:1px solid var(--line2);border-radius:10px;padding:12px;margin-bottom:8px}
.sched-row b{display:block;font-size:13.5px;font-weight:600}
.sched-row span{font-size:12.5px;color:var(--mu)}
.sched-row .grow{flex:1;min-width:0}
.switch{position:relative;width:36px;height:20px;flex:none}
.switch input{opacity:0;width:0;height:0;position:absolute}
.switch .tr{position:absolute;inset:0;background:var(--line2);border-radius:999px;cursor:pointer}
.switch .tr:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;background:var(--bg);border-radius:50%;transition:.15s}
.switch input:checked+.tr{background:var(--btn)}
.switch input:checked+.tr:before{transform:translateX(16px)}
.switch input:focus-visible+.tr{outline:2px solid var(--focus);outline-offset:2px}
.btn-danger{border:1px solid var(--line2);background:none;color:var(--rm);border-radius:8px;height:30px;padding:0 12px}
/* dialog */
dialog{border:1px solid var(--line2);border-radius:14px;background:var(--bg);color:var(--fg);max-width:700px;width:calc(100% - 32px);padding:20px}
dialog::backdrop{background:rgba(0,0,0,.45)}
dialog h2{margin:0 0 6px;font-size:17px;font-weight:600}
.memory-field{display:grid;gap:5px;margin:10px 0}
.memory-field label{font-size:12px;color:var(--mu)}
#memory-scope{width:100%;background:var(--bg);color:var(--fg);height:34px;padding:0 8px;border:1px solid var(--line2);border-radius:8px}
#memory-content{display:block;width:100%;min-height:240px;max-height:52vh;resize:vertical;background:var(--panel);color:var(--fg);border:1px solid var(--line2);border-radius:10px;padding:10px;font:12.5px/1.6 var(--mono);white-space:pre;overflow:auto}
.memory-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}
#memory-status{flex:1;min-width:150px;font-size:12px;color:var(--mu)}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--btn);color:var(--btnfg);padding:8px 14px;border-radius:10px;font-size:13px;z-index:50;max-width:calc(100% - 32px);box-shadow:var(--shadow)}
.toast[hidden]{display:none}
.scrim{display:none}
/* responsive */
@media (max-width:1180px){.review{position:fixed;right:0;top:0;bottom:0;width:min(440px,100%);z-index:20;box-shadow:-12px 0 40px rgba(0,0,0,.18)}}
@media (max-width:820px){
 .side{position:fixed;left:0;top:0;bottom:0;z-index:30;transform:translateX(-100%);transition:transform .2s,visibility .2s;width:min(300px,86vw);visibility:hidden}
 .app.side-open .side{transform:none;visibility:visible;box-shadow:12px 0 40px rgba(0,0,0,.2)}
 .app.side-open .scrim{display:block;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:25}
 .menu{display:inline-flex}
 .top{padding:0 10px;gap:8px}
 .crumb .p,.crumb .sep,.hide-sm{display:none}
 .feed{padding:18px 14px 10px}
 .comp-wrap{padding:0 10px 10px}
 .comp .hint{display:none}
 .si kbd,.search kbd{display:none}
 .comp .rw{flex-wrap:nowrap}
 .tg-plan .lbl{display:none}
 .tg-plan{padding:0 8px}
 .pk{max-width:38vw}
 .pk select{max-width:30vw}
 .status .hide-sm{display:none}
 .review{width:100%}
 .tbtn,.si,.th,.tab,.sug,.files button,.seg button{min-height:40px}
 .pagev{padding:20px 14px 32px}
}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
<symbol id="nyra-mark" viewBox="0 0 100 100"><mask id="nyra-mark-cut"><rect width="100" height="100" fill="#fff"/><path d="M40.00 31.00 L40.00 75.72 L50.75 65.83 L58.06 81.74 L65.37 78.47 L58.06 62.65 L72.25 62.65 Z" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="round" transform="rotate(-6 50 50)"/></mask><circle cx="50" cy="50" r="46" fill="currentColor" mask="url(#nyra-mark-cut)"/></symbol>
</svg>
<div class="app" id="app">
<aside class="side" id="side" aria-label="会话与导航">
  <div class="side-top"><svg class="mark" aria-hidden="true"><use href="#nyra-mark"/></svg><span class="brand">Nyra</span><span class="ver" id="ver"></span></div>
  <div class="side-scroll">
    <button class="si" id="new-session" type="button" title="新建会话（Ctrl/⌘ + Shift + O）"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>新建会话<kbd>⇧⌘O</kbd></button>
    <label class="search"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg><span class="sr">搜索会话</span><input id="search" type="search" placeholder="搜索会话" autocomplete="off"><kbd>⌘K</kbd></label>
    <nav id="nav" aria-label="页面">
      <button class="si" type="button" data-view="skills"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.8 4.7 4.7 1.8-4.7 1.8L8 14.5l-1.8-4.7L1.5 8l4.7-1.8z"/></svg>技能与工具</button>
      <button class="si" type="button" data-view="schedule"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>定时任务</button>
      <button class="si" type="button" data-view="group"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><path d="M1.5 13.5c.5-2.5 2.3-3.5 4.5-3.5s4 1 4.5 3.5"/><path d="M10.5 3.8a2.3 2.3 0 010 4.4M12 10.3c1.3.5 2.2 1.5 2.5 3.2"/></svg>机器人群聊</button>
      <button class="si" type="button" id="open-memory" aria-label="查看和管理长期记忆"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="M5.5 7h5M5.5 9.5h5"/></svg>长期记忆</button>
    </nav>
    <div class="sh"><span>项目</span></div>
    <div id="sessions"><div class="empty">加载中…</div></div>
  </div>
  <div class="side-foot"><button class="si" type="button" data-view="settings" id="open-settings"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>设置</button></div>
</aside>
<div class="scrim" id="scrim"></div>
<main class="main">
  <header class="top">
    <button class="tbtn icon-btn menu" id="toggle-left" type="button" aria-label="打开会话列表" aria-controls="side" aria-expanded="false"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg></button>
    <div class="crumb"><span class="p" id="crumb-project"></span><span class="sep" aria-hidden="true">/</span><b id="crumb-title">新会话</b></div>
    <span class="pill" id="run-status" role="status" aria-live="polite"><i class="dot"></i><span>空闲</span></span>
    <span class="pill hide-sm" id="worked" hidden></span>
    <span class="pill hide-sm" id="usage-pill" hidden title="本会话模型报告的 Token 用量"></span>
    <button class="tbtn" id="toggle-right" type="button" aria-controls="right" aria-pressed="false" title="审阅面板（Ctrl/⌘ + .）"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M9.5 2.5v11"/></svg><span class="hide-sm">审阅</span></button>
  </header>
  <div class="cols">
    <section class="conv" id="view-chat" aria-label="对话">
      <div class="feed" id="feed"><div class="col" id="log" aria-live="polite"></div></div>
      <div class="comp-wrap">
        <form class="comp" id="form">
          <label class="sr" for="input">给 Nyra 的消息</label>
          <textarea id="input" rows="1" placeholder="给 Nyra 一个任务…"></textarea>
          <div class="rw">
            <span class="pk" title="审批模式"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z"/></svg><select id="mode" aria-label="审批模式"></select></span>
            <span class="pk" title="模型（新会话生效）"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8"/></svg><select id="model-select" aria-label="模型（新会话生效）"></select></span>
            <button class="tg-plan" id="plan-toggle" type="button" aria-pressed="false" aria-label="计划模式" title="计划模式：先只读分析并写出 plan.md，审核后再执行"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg><span class="lbl">计划模式</span></button>
            <span class="hint" id="hint">Enter 发送 · Shift+Enter 换行</span>
            <button class="send" id="send" type="submit" aria-label="发送"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg></button>
          </div>
        </form>
      </div>
    </section>
    <section class="pagev" id="view-skills" hidden aria-label="技能与工具"><div class="in">
      <h2>技能与工具</h2>
      <p class="sub">技能是 Markdown 提示词文件（<code>skills/*.md</code>），按任务关键词自动加载；工具是模型可直接调用的能力。</p>
      <h3>技能</h3>
      <div id="skills-list"><div class="empty">加载中…</div></div>
      <h3>内置工具（<span id="tool-count">0</span> 个）</h3>
      <div class="grid" id="tools-grid"><div class="empty">加载中…</div></div>
    </div></section>
    <section class="pagev" id="view-schedule" hidden aria-label="定时任务"><div class="in">
      <h2>定时任务</h2>
      <p class="sub">任务存在 <code>~/.nyra/schedule.json</code>，由 <code>nyra schedule daemon</code> 守护进程执行；这里只做查看、开关与删除，执行仍需 daemon 在运行。</p>
      <div id="sched-list"><div class="empty">加载中…</div></div>
      <p class="hint2">网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；请用 <code>nyra schedule add</code> 命令添加。</p>
      <p class="hint2" id="sched-status" role="status"></p>
    </div></section>
    <section class="pagev" id="view-group" hidden aria-label="机器人群聊"><div class="in">
      <h2>机器人群聊</h2>
      <p class="sub">每个机器人有独立的身份、会话、记忆和工作目录；群聊在独立页面进行，这里只列出已有群。</p>
      <div id="group-list"><div class="empty">加载中…</div></div>
      <p><a class="tbtn p" id="group-open" href="/groups">打开群聊页面</a></p>
    </div></section>
    <section class="pagev" id="view-settings" hidden aria-label="设置"><div class="in">
      <h2>设置</h2>
      <p class="sub">这里只改本次界面的运行状态，不保存任何密钥、不改配置文件。</p>
      <h3>模型</h3>
      <div class="form-row">
        <label for="provider-select">Provider</label>
        <select id="provider-select" aria-label="当前 provider"></select>
        <label for="model-input">模型</label>
        <input id="model-input" list="model-list" maxlength="180" aria-label="模型 id（留空用该 provider 的默认模型）">
        <datalist id="model-list"></datalist>
        <button class="tbtn p" id="apply-provider" type="button">应用</button>
      </div>
      <p class="hint2" id="provider-status" role="status"></p>
      <p class="hint2">切换后立即生效：新会话使用新 provider，已有会话保持原 provider；重启界面后恢复配置文件中的设置。</p>
      <p class="hint2">模型自动兜底默认关闭。开启方式：<code>~/.nyra/config.json</code> 里设 <code>"fallback_enabled": true</code>，或启动时加 <code>--fallback</code>；只切换到 <code>fallback_providers</code> 允许列表里的服务商。发生切换时会在对话流里显示。</p>
      <h3>审批模式</h3>
      <div class="form-row">
        <div class="seg" id="mode-seg" role="group" aria-label="审批模式">
          <button type="button" data-mode="readonly">只读</button>
          <button type="button" data-mode="auto">逐项批准</button>
          <button type="button" data-mode="full">完整权限</button>
        </div>
      </div>
      <p class="hint2">只读：不写文件、不跑命令。逐项批准（auto）：写入与命令前在对话里出现审批卡片。完整权限（full）：自动批准工具调用，只在可信任务里用。</p>
      <h3>API Key</h3>
      <p class="hint2">Key 只从环境变量读取：在启动 <code>nyra ui</code> 的终端里设置对应环境变量（例如 <code>export DEEPSEEK_API_KEY=…</code>），然后重启界面。页面不会输入、显示或保存 Key，只显示是否已配置。</p>
      <table><thead><tr><th>Provider</th><th>环境变量</th><th>状态</th></tr></thead><tbody id="keys"></tbody></table>
      <h3>运行配置</h3>
      <div class="kv" id="cfg-kv"></div>
    </div></section>
    <aside class="review" id="right" hidden aria-label="审阅面板">
      <div class="rt" role="tablist" aria-label="审阅">
        <button class="tab active" role="tab" id="tab-diff" type="button" data-pane="diff" aria-selected="true">改动 <span class="ct" id="diff-count"></span></button>
        <button class="tab" role="tab" id="tab-plan" type="button" data-pane="plan" aria-selected="false">计划</button>
        <button class="tab" role="tab" id="tab-evidence" type="button" data-pane="evidence" aria-selected="false">证据 <span class="ct" id="ev-count"></span></button>
        <button class="tab" role="tab" id="tab-term" type="button" data-pane="term" aria-selected="false">终端</button>
        <button class="tab" role="tab" id="tab-artifacts" type="button" data-pane="artifacts" aria-selected="false">产物</button>
        <button class="tab" role="tab" id="tab-status" type="button" data-pane="status" aria-selected="false">用量</button>
        <button class="tbtn icon-btn x" id="close-right" type="button" aria-label="关闭审阅面板"><svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
      </div>
      <div class="pane" id="pane-diff" role="tabpanel" aria-labelledby="tab-diff"><div id="diff-list"></div></div>
      <div class="pane pane-pad" id="pane-plan" role="tabpanel" aria-labelledby="tab-plan" hidden><div class="card plan-list"><h4>计划</h4><div id="plan"></div></div></div>
      <div class="pane pane-pad" id="pane-evidence" role="tabpanel" aria-labelledby="tab-evidence" hidden><div id="evidence"></div></div>
      <div class="pane" id="pane-term" role="tabpanel" aria-labelledby="tab-term" hidden><div id="term-list"></div></div>
      <div class="pane pane-pad" id="pane-artifacts" role="tabpanel" aria-labelledby="tab-artifacts" hidden>
        <div class="art-list" id="artifact-list"></div>
        <div class="art-view" id="artifact-view" hidden>
          <h5 id="artifact-title"></h5>
          <div class="art-body" id="artifact-body"></div>
          <div class="art-note" id="artifact-note"></div>
        </div>
      </div>
      <div class="pane pane-pad" id="pane-status" role="tabpanel" aria-labelledby="tab-status" hidden>
        <div class="card"><h4>模型</h4><div class="kv" id="model-kv"></div></div>
        <div class="card"><h4>Token 用量</h4><div class="kv" id="usage-kv"></div><p class="hint2" id="usage-hint">仅统计当前进程中 API 返回的真实用量。</p></div>
      </div>
    </aside>
  </div>
  <footer class="status" id="statusbar">
    <span id="sb-dir" title="工作目录"></span>
    <span id="sb-mode"></span>
    <span id="sb-ctx" class="hide-sm" hidden></span>
    <span id="sb-tok" class="hide-sm" hidden></span>
    <span class="r hide-sm" id="sb-mcp"></span>
  </footer>
</main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<dialog id="memory-dialog" aria-labelledby="memory-title">
  <h2 id="memory-title">长期记忆</h2>
  <p class="hint2">这里编辑的是磁盘上的完整 MEMORY.md，不是聊天记录。模型通常只读取最后 40 行；压缩会话不会修改此文件。内容可能敏感，请勿公开分享。</p>
  <div class="memory-field">
    <label for="memory-scope">记忆所属机器人</label>
    <select id="memory-scope"></select>
  </div>
  <div class="memory-field">
    <label for="memory-content">Markdown 记忆内容（完整文本）</label>
    <textarea id="memory-content" spellcheck="false" aria-label="编辑长期记忆"></textarea>
  </div>
  <div class="memory-footer">
    <span id="memory-status" role="status" aria-live="polite">尚未载入</span>
    <button class="tbtn" id="memory-refresh" type="button">重新读取</button>
    <button class="tbtn p" id="memory-save" type="button">保存修改</button>
    <button class="tbtn" id="memory-close" type="button">关闭</button>
  </div>
</dialog>
<script>
(function(){
"use strict";
var params=new URLSearchParams(location.search);
var TOKEN=params.get("token")||"";
var $=function(id){return document.getElementById(id)};
$("group-open").href="/groups?token="+encodeURIComponent(TOKEN);
// Manifest 与图标是浏览器子资源请求，不带 X-Nyra-Token 请求头，
// 所以 token 走查询串（与页面本身一致）。
if(TOKEN){var ml=$("manifest-link");if(ml)ml.href="/manifest.json?token="+encodeURIComponent(TOKEN);var ai=$("apple-touch-icon");if(ai)ai.href="/nyra-mark.svg?token="+encodeURIComponent(TOKEN)}
// Same prefix as plan_mode.approved_execution_task(): the user turn that
// runs a reviewed plan.md is shown as a compact card, not the whole prompt.
var PLAN_EXEC_PREFIX="下面是用户提供 SHA-256 校验值确认过的 plan.md。";
var MODE_LABEL={readonly:"只读",auto:"逐项批准",full:"完整权限"};
var S={sid:null,next:0,status:"idle",timer:null,info:null,sessions:[],project:null,view:"chat",planMode:false,pending:null,
  group:null,turn:null,turns:[],diffs:[],diffIdx:{},terms:[],termIdx:{},lastTool:null,tools:{},approvals:{},usage:null,collapsed:{},tick:null};
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"X-Nyra-Token":TOKEN,"Content-Type":"application/json"},opts.headers||{});
  return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function svg(name){var P={chev:'<path d="M4 6l4 4 4-4"/>',play:'<path d="M5 3.5l7 4.5-7 4.5z"/>',file:'<path d="M4 1.5h5.5L12.5 4.5v10H4z"/><path d="M9.5 1.5v3h3"/>',shield:'<path d="M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z"/>',globe:'<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',check:'<path d="M3 8.5l3 3 7-7"/>',x:'<path d="M4 4l8 8M12 4l-8 8"/>'};
  return '<svg class="i" viewBox="0 0 16 16" aria-hidden="true">'+(P[name]||"")+'</svg>'}
function toast(msg){var t=$("toast");t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){t.hidden=true},3200)}
/* ---------- fonts: fetched with the token header, loaded via FontFace ---------- */
function loadFonts(){if(!window.FontFace||!document.fonts)return;
  [["Inter","inter-400.woff","400"],["Inter","inter-600.woff","500 700"],["JetBrains Mono","jbm-400.woff","400 700"]].forEach(function(f){
    fetch("/assets/fonts/"+f[1],{headers:{"X-Nyra-Token":TOKEN}}).then(function(r){if(!r.ok)throw 0;return r.arrayBuffer()})
      .then(function(buf){var ff=new FontFace(f[0],buf,{weight:f[2],style:"normal",display:"swap"});return ff.load()}).then(function(ff){document.fonts.add(ff)}).catch(function(){})})}
/* ---------- markdown (escape first) ---------- */
function md(src){
  var blocks=[];var s=String(src||"").replace(/```[^\n]*\n([\s\S]*?)```/g,function(_,code){blocks.push(code);return "\u0000"+(blocks.length-1)+"\u0000"});
  s=esc(s);
  s=s.replace(/`([^`\n]+)`/g,"<code>$1</code>")
     .replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>")
     .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
     .replace(/(^|[\s(（：:，,])(https?:\/\/[^\s<)），。]+)/g,'$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  var out=[],list=null;
  s.split("\n").forEach(function(line){var m;
    if((m=line.match(/^\s*[-*]\s+(.*)$/))){if(list!=="ul"){if(list)out.push("</"+list+">");out.push("<ul>");list="ul"}out.push("<li>"+m[1]+"</li>");return}
    if((m=line.match(/^\s*\d+[.)]\s+(.*)$/))){if(list!=="ol"){if(list)out.push("</"+list+">");out.push("<ol>");list="ol"}out.push("<li>"+m[1]+"</li>");return}
    if(list){out.push("</"+list+">");list=null}
    if((m=line.match(/^#{1,3}\s+(.*)$/))){out.push("<h3>"+m[1]+"</h3>");return}
    if((m=line.match(/^#{4,6}\s+(.*)$/))){out.push("<h4>"+m[1]+"</h4>");return}
    if(line.trim()==="")out.push("");else out.push("<p>"+line+"</p>")});
  if(list)out.push("</"+list+">");
  return out.join("\n").replace(/\u0000(\d+)\u0000/g,function(_,i){return "<pre><code>"+esc(blocks[+i])+"</code></pre>"})}
function parseArgs(a){if(typeof a==="string"){try{return JSON.parse(a)}catch(e){return a}}return a}
function pretty(a){a=parseArgs(a);if(typeof a==="string")return a;try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}
function failed(r){return /^(错误：|执行失败：)/.test(String(r||""))}
function short(s,n){s=String(s==null?"":s).replace(/\s+/g," ");return s.length>n?s.slice(0,n-1)+"…":s}
function fmtK(n){if(n==null)return "—";n=Number(n);return n>=1000?(n/1000).toFixed(n>=10000?0:1)+"k":String(n)}
function fmtDur(sec){sec=Math.max(0,Math.round(sec));if(sec<60)return sec+"s";var m=Math.floor(sec/60),s=sec%60;return m+"m"+(s?(" "+s+"s"):"")}
function relTime(iso){var d=new Date(iso);if(isNaN(d.getTime()))return "";var s=(Date.now()-d.getTime())/1000;
  if(s<60)return "刚刚";if(s<3600)return Math.floor(s/60)+" 分钟";if(s<86400)return Math.floor(s/3600)+" 小时";if(s<86400*30)return Math.floor(s/86400)+" 天";return d.toLocaleDateString()}
function fmtTime(iso){try{var d=new Date(iso);if(isNaN(d.getTime()))return iso;return d.toLocaleString()}catch(e){return iso}}
/* ---------- tool rows ---------- */
function describeTool(name,args){var a=parseArgs(args);if(!a||typeof a!=="object")a={};
  var map={read_file:["读取",a.path],write_file:["写入",a.path],edit_file:["编辑",a.path],apply_patch:["修改",a.path],list_dir:["列出",a.path||"."],
    shell:["运行",a.command],web_fetch:["抓取",a.url],web_search:["搜索",a.query?("“"+a.query+"”"):""],grep_search:["搜索",a.pattern?("“"+a.pattern+"”"+(a.path&&a.path!=="."?(" · "+a.path):"")):""],
    git_status:["查看 Git 状态",a.path||""],plan:["制定计划",a.title],delegate:["委派子任务",a.task],memory_append:["写入记忆",a.text],save_skill:["保存技能",a.name],
    http_post:["POST",a.url],browser_navigate:["浏览器打开",a.url],browser_click:["浏览器点击",a.selector],browser_screenshot:["浏览器截图",""],
    computer_screenshot:["电脑截屏",""],computer_click:["电脑点击",(a.x!=null?a.x+", "+a.y:"")],computer_type:["电脑输入",a.text],computer_key:["电脑按键",a.key],computer_windows:["列出窗口",""],
    multi_model_research:["多模型调研",a.prompt]};
  if(map[name])return {verb:map[name][0],target:short(map[name][1]||"",120)};
  if(/^mcp_/.test(name))return {verb:"MCP 工具",target:name};
  return {verb:name,target:""}}
function ensureGroup(){if(S.group)return S.group;
  var d=el("details","log");d.open=true;var sm=el("summary");sm.innerHTML=svg("chev")+'<span class="lbl"></span>';d.appendChild(sm);
  var rows=el("div","rows");d.appendChild(rows);$("log").appendChild(d);
  var g={el:d,rows:rows,count:0,lbl:sm.querySelector(".lbl")};S.group=g;if(S.turn)S.turn.groups.push(g);updateGroup(g);return g}
function updateGroup(g){var t=S.turn;var running=S.status==="running"&&t&&t.live&&!t.done;
  var txt=g.count+" 个步骤";if(t&&t.groups[0]===g){if(t.done&&t.dur!=null)txt="工作了 "+fmtDur(t.dur)+" · "+txt;else if(running&&t.start)txt="正在工作 · "+fmtDur(Date.now()/1000-t.start)+" · "+txt}
  g.lbl.textContent=txt}
function toolStart(id,name,args){var g=ensureGroup();g.count++;
  var info=describeTool(name,args);var row=el("details","row");row.dataset.id=id||"";
  var sm=el("summary");sm.appendChild(el("span","vb",info.verb));if(info.target)sm.appendChild(el("span","tg",info.target));
  var st=el("span","st");st.innerHTML='<span class="spin" aria-hidden="true"></span><span class="sr">运行中</span>';sm.appendChild(st);row.appendChild(sm);
  var det=el("div","detail");det.appendChild(el("h6",null,"参数"));det.appendChild(el("pre",null,pretty(args)));row.appendChild(det);
  g.rows.appendChild(row);updateGroup(g);
  S.tools[id||("_"+Object.keys(S.tools).length)]={row:row,name:name};S.lastTool=id;
  trackChange(id,name,args)}
function toolResult(id,name,result){var t=S.tools[id];if(!t){var keys=Object.keys(S.tools);t=S.tools[keys[keys.length-1]]}
  if(t){var st=t.row.querySelector(".st");var bad=failed(result);st.className="st"+(bad?" bad":"");st.innerHTML=bad?svg("x")+'<span class="sr">失败</span>':'<span class="sr">完成</span>';
    var det=t.row.querySelector(".detail");if(!det.querySelector(".rs")){det.appendChild(el("h6",null,"结果"));var pre=el("pre","rs");det.appendChild(pre)}det.querySelector(".rs").textContent=String(result||"");
    if(bad)t.row.open=false}
  resolveChange(id,result);resolveTerm(id,result)}
/* ---------- changes (diff pane) ---------- */
function parseUnified(text){var lines=[],o=0,n=0,started=false;
  String(text||"").split("\n").forEach(function(l){var m;
    if(/^(---|\+\+\+) /.test(l)&&!started)return;
    if((m=l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/))){o=+m[1];n=+m[2];started=true;lines.push({k:"h",t:l});return}
    if(!started){if(l.trim())lines.push({k:"h",t:l});return}
    if(l.charAt(0)==="+"){lines.push({k:"a",n:n++,t:l.slice(1)});return}
    if(l.charAt(0)==="-"){lines.push({k:"d",n:o++,t:l.slice(1)});return}
    if(l.charAt(0)==="\\"){lines.push({k:"h",t:l});return}
    lines.push({k:"c",n:n,t:l.slice(1)});o++;n++});
  return lines}
function splitLines(t){var l=String(t).split("\n");if(l.length>1&&l[l.length-1]==="")l.pop();return l}
function countLines(lines){var a=0,d=0;lines.forEach(function(l){if(l.k==="a")a++;else if(l.k==="d")d++});return [a,d]}
function trackChange(id,name,args){var a=parseArgs(args);if(!a||typeof a!=="object"||!a.path)return;var lines=null,src="";
  if(name==="apply_patch"&&typeof a.patch==="string"){lines=parseUnified(a.patch);src="补丁"}
  else if(name==="edit_file"&&typeof a.old_text==="string"&&typeof a.new_text==="string"){lines=[];splitLines(a.old_text).forEach(function(t){lines.push({k:"d",t:t})});splitLines(a.new_text).forEach(function(t){lines.push({k:"a",t:t})});src="按替换文本显示（无行号）"}
  else if(name==="write_file"&&typeof a.content==="string"){lines=[];var cl=splitLines(a.content);cl.slice(0,400).forEach(function(t,i){lines.push({k:"a",n:i+1,t:t})});if(cl.length>400)lines.push({k:"h",t:"…（其余 "+(cl.length-400)+" 行未显示）"});src="写入全文"}
  if(!lines)return;var e={id:id,path:String(a.path),lines:lines,src:src,state:"run",turn:S.turn};S.diffs.push(e);if(id)S.diffIdx[id]=e;if(S.turn)S.turn.files.push(e);renderDiffs()}
function changePreview(id,summary){var e=S.diffIdx[id];if(!e)return;var txt=String(summary||"");var i=txt.indexOf("\n");if(i<0)return;var body=txt.slice(i+1);
  if(/^(---|@@)/m.test(body)){e.lines=parseUnified(body);e.src="审批时的实际 diff";renderDiffs()}}
function resolveChange(id,result){var e=S.diffIdx[id];if(!e)return;var r=String(result||"");e.state=/用户拒绝执行/.test(r)?"denied":(failed(r)?"failed":"done");renderDiffs();updateFilesCards()}
var STATE_LABEL={run:"进行中",wait:"待批准",done:"已应用",denied:"已拒绝",failed:"失败"};
function diffLine(l){var d=el("div","dl "+(l.k==="a"?"a":l.k==="d"?"d":l.k==="h"?"h":""));
  d.appendChild(el("span","n",l.n!=null?String(l.n):""));d.appendChild(el("span","m",l.k==="a"?"+":l.k==="d"?"−":""));d.appendChild(el("span","c",l.t));return d}
function renderDiffs(){var box=$("diff-list");box.textContent="";var shown=S.diffs;
  $("diff-count").textContent=shown.length?String(shown.length):"";
  if(!shown.length){box.appendChild(el("div","empty pane-pad","这个会话还没有文件改动。写入、编辑或打补丁时，改动会出现在这里。"));return}
  shown.forEach(function(e,ix){var b=el("div","fblock");b.id="diff-"+ix;var h=el("div","fh");h.appendChild(el("span","fp",e.path));var c=countLines(e.lines);
    h.appendChild(el("span","add","+"+c[0]));h.appendChild(el("span","del","−"+c[1]));h.appendChild(el("span","stt",STATE_LABEL[e.state]||e.state));b.appendChild(h);
    if(e.src)b.appendChild(el("div","src",e.src));var code=el("div");e.lines.forEach(function(l){code.appendChild(diffLine(l))});b.appendChild(code);box.appendChild(b)})}
function finishFilesCard(t){if(!t||!t.files.length||t.card)return;var card=el("div","files");card.setAttribute("role","group");card.setAttribute("aria-label","本轮改动的文件");t.card=card;$("log").appendChild(card);fillFilesCard(t)}
function fillFilesCard(t){var card=t.card;card.textContent="";var seen={};
  t.files.forEach(function(e){var k=e.path;if(!seen[k]){seen[k]={path:k,a:0,d:0,states:[],first:e};}var c=countLines(e.lines);seen[k].a+=c[0];seen[k].d+=c[1];seen[k].states.push(e.state)});
  Object.keys(seen).forEach(function(k){var f=seen[k];var b=el("button");b.type="button";b.appendChild(el("span","fp",f.path));
    var denied=f.states.every(function(s){return s==="denied"||s==="failed"});
    if(denied)b.appendChild(el("span","del","未应用"));else{b.appendChild(el("span","add","+"+f.a));b.appendChild(el("span","del","−"+f.d))}
    b.onclick=function(){openReview("diff");var ix=S.diffs.indexOf(f.first);var n=$("diff-"+ix);if(n)n.scrollIntoView({block:"start"})};card.appendChild(b)})}
function updateFilesCards(){S.turns.forEach(function(t){if(t.card)fillFilesCard(t)})}
/* ---------- terminal pane (shell tool calls) ---------- */
function trackTerm(id,name,args){if(name!=="shell")return;var a=parseArgs(args)||{};var e={cmd:String(a.command||""),cwd:a.cwd||"",out:null};S.terms.push(e);if(id)S.termIdx[id]=e;renderTerms()}
function resolveTerm(id,result){var e=S.termIdx[id];if(!e)return;e.out=String(result||"");renderTerms()}
function renderTerms(){var box=$("term-list");box.textContent="";if(!S.terms.length){box.appendChild(el("div","empty pane-pad","这个会话还没有运行命令。"));return}
  S.terms.forEach(function(e){var t=el("div","term");t.appendChild(el("div","cmd","$ "+e.cmd));t.appendChild(el("pre",null,e.out==null?"等待执行…":(e.out||"（无输出）")));box.appendChild(t)})}
/* ---------- conversation ---------- */
function startTurn(ts,live){S.group=null;var t={start:ts||null,live:!!live,groups:[],files:[],done:false,dur:null,card:null};S.turn=t;S.turns.push(t);return t}
function finishTurn(ts){var t=S.turn;if(!t||t.done)return;t.done=true;if(t.start&&ts)t.dur=ts-t.start;t.groups.forEach(updateGroup);finishFilesCard(t);
  if(t.dur!=null){var w=$("worked");w.textContent="工作了 "+fmtDur(t.dur);w.hidden=false}}
function addUser(text,opts){opts=opts||{};var tx=String(text||"");var u=el("div","u");
  if(tx.indexOf(PLAN_EXEC_PREFIX)===0){u.appendChild(el("span","tag","执行已批准的计划"));var dd=el("details");var sm=el("summary",null,"查看计划全文");dd.appendChild(sm);var pre=el("div","a");pre.innerHTML=md(tx.slice(tx.indexOf("# Nyra 执行计划")>=0?tx.indexOf("# Nyra 执行计划"):0));dd.appendChild(pre);u.appendChild(dd)}
  else{if(opts.plan){u.classList.add("planreq");u.appendChild(el("span","tag","计划模式 · 只读分析"))}u.appendChild(document.createTextNode(tx))}
  $("log").appendChild(u)}
function addAssistant(text){if(!text)return;S.group=null;var d=el("div","a");d.innerHTML=md(text);$("log").appendChild(d)}
function addNote(text,bad){S.group=null;$("log").appendChild(el("div","note"+(bad?" bad":""),text))}
function approvalTitle(tool){return {shell:"命令需要你的批准",write_file:"写入文件需要你的批准",edit_file:"编辑文件需要你的批准",apply_patch:"补丁需要你的批准",plan:"写入计划文件需要你的批准",http_post:"网络请求需要你的批准",memory_append:"写入记忆需要你的批准",save_skill:"保存技能需要你的批准",mcp:"外部 MCP 工具需要你的批准"}[tool]||(tool+" 需要你的批准")}
function addApproval(d){S.group=null;var card=el("div","appr");card.dataset.aid=d.id;card.setAttribute("role","group");card.setAttribute("aria-label","需要批准："+d.tool);
  var sum=String(d.summary||"");var nl=sum.indexOf("\n");var head=nl<0?sum:sum.slice(0,nl);var body=nl<0?"":sum.slice(nl+1);
  var h=el("div","appr-h");var ic=el("span","ic");ic.innerHTML=svg(d.tool==="shell"?"play":/file|patch|plan/.test(d.tool)?"file":"shield");h.appendChild(ic);
  var tx=el("div","tx");tx.appendChild(el("b",null,head));tx.appendChild(el("small",null,approvalTitle(d.tool)+" · auto 模式"));h.appendChild(tx);
  var acts=el("div","acts");
  var no=el("button","tbtn","拒绝");no.type="button";no.onclick=function(){decide(d.id,false,false,card)};acts.appendChild(no);
  if(d.always){var al=el("button","tbtn","本会话始终允许");al.type="button";al.title=d.tool==="shell"?"本会话内相同命令、目录和超时不再询问":"本会话内对这个文件的同类操作不再询问";al.onclick=function(){decide(d.id,true,true,card)};acts.appendChild(al)}
  var ok=el("button","tbtn p","允许一次");ok.type="button";ok.onclick=function(){decide(d.id,true,false,card)};acts.appendChild(ok);
  h.appendChild(acts);var res=el("span","res");res.hidden=true;h.appendChild(res);card.appendChild(h);
  if(body.trim()){var pre=el("pre");pre.setAttribute("aria-label","改动预览");if(/^(---|@@)/m.test(body))parseUnified(body).forEach(function(l){pre.appendChild(diffLine(l))});else pre.appendChild(el("div","dl",null)).appendChild(el("span","c",body));card.appendChild(pre)}
  $("log").appendChild(card);S.approvals[d.id]=card;
  var e=S.diffIdx[S.lastTool];if(e){e.state="wait";changePreview(S.lastTool,sum)}}
function approvalDone(d){var card=S.approvals[d.id]||$("log").querySelector('.appr[data-aid="'+d.id+'"]');if(!card)return;card.classList.add("done");
  var res=card.querySelector(".res");res.hidden=false;res.className="res "+(d.approved?"ok":"bad");res.textContent=d.approved?(d.always?"已允许（本会话始终允许）":"已允许一次"):(d.timeout?"审批超时，已拒绝":"已拒绝");
  var pre=card.querySelector("pre");if(pre&&!d.approved)pre.hidden=true}
function decide(id,ok,always,card){card.querySelectorAll(".acts button").forEach(function(b){b.disabled=true});
  api("/api/approvals/"+id,{method:"POST",body:JSON.stringify({approve:ok,always:!!always})}).then(function(){S.pending=null;renderRunStatus();poll(150)})
    .catch(function(e){card.querySelectorAll(".acts button").forEach(function(b){b.disabled=false});toast("审批失败："+e.message)})}
function addPlanCard(d){S.group=null;var c=el("section","plan-card");c.setAttribute("aria-label","计划");var h=el("header");h.appendChild(document.createTextNode("计划已写入 "+(d.path||"plan.md")));h.appendChild(el("small",null,"SHA-256 "+String(d.sha256||"").slice(0,12)+"…"));c.appendChild(h);
  var body=el("div","a");body.innerHTML=md(d.plan||"");c.appendChild(body);var f=el("footer");
  var ro=S.info&&S.info.mode==="readonly";f.appendChild(el("span",null,ro?"只读模式不能执行计划：先把审批模式切到“逐项批准”。":"执行时仍按当前审批模式逐项确认写入与命令；计划文件被改动后需重新生成。"));
  var go=el("button","tbtn p","按计划执行");go.type="button";go.disabled=ro;go.onclick=function(){go.disabled=true;
    api("/api/sessions/"+encodeURIComponent(S.sid)+"/plan/execute",{method:"POST",body:JSON.stringify({sha256:d.sha256})}).then(function(r){if(r.status==="error"){addNote("错误："+r.error,true);return}S.next=0;setStatus("running");poll()})
      .catch(function(e){go.disabled=false;toast("执行失败："+e.message)})};f.appendChild(go);c.appendChild(f);$("log").appendChild(c)}
function welcome(){var log=$("log");log.textContent="";var w=el("div","welcome");w.innerHTML='<svg class="mark" aria-hidden="true"><use href="#nyra-mark"/></svg>';w.appendChild(el("h1",null,"今天想让 Nyra 做什么？"));
  w.appendChild(el("p",null,"Nyra 会调用工具完成任务：读写文件、执行命令、联网查证。每一步都会出现在这里，写入和命令先经你批准。"));
  var sg=el("div","sugs");[["核查调研","查一下上海博物馆周二开不开，人民广场馆和东馆都要确认，附官网来源"],["只读工具","看一下这个仓库的 git 状态"],["需要批准的操作","在工作目录里新建 notes.md，写一行今天的待办"]].forEach(function(p){var b=el("button","sug","试试"+p[0]);b.type="button";b.onclick=function(){$("input").value=p[1];autosize();$("input").focus()};sg.appendChild(b)});
  w.appendChild(sg);log.appendChild(w)}
function resetFeed(){$("log").textContent="";S.group=null;S.turn=null;S.turns=[];S.diffs=[];S.diffIdx={};S.terms=[];S.termIdx={};S.tools={};S.approvals={};S.lastTool=null;$("worked").hidden=true;renderDiffs();renderTerms()}
function renderTranscript(messages){resetFeed();
  messages.forEach(function(m){
    if(m.role==="user"){if(S.turn)finishTurn(null);startTurn(null,false);addUser(m.content||"")}
    else if(m.role==="assistant"){if(!S.turn)startTurn(null,false);if(m.content){addAssistant(m.content);scanArtifacts(m.content)}(m.tool_calls||[]).forEach(function(tc){var f=tc.function||{};toolStart(tc.id,f.name,f.arguments);trackTerm(tc.id,f.name,f.arguments)})}
    else if(m.role==="tool"){toolResult(m.tool_call_id,"",m.content||"")}});
  if(S.turn)finishTurn(null)}
function applyEvent(ev){var d=ev.data||{};
  if(ev.type==="user"){if(S.turn&&!S.turn.done)finishTurn(null);if(!$("log").querySelector(".u,.a,.log"))$("log").textContent="";startTurn(ev.ts,true);addUser(d.content,{plan:d.plan})}
  else if(ev.type==="assistant"){if(d.content){addAssistant(d.content);scanArtifacts(d.content)}}
  else if(ev.type==="final"){if(d.content){addAssistant(d.content);scanArtifacts(d.content)}finishTurn(ev.ts)}
  else if(ev.type==="tool_start"){toolStart(d.id,d.name,d.arguments);trackTerm(d.id,d.name,d.arguments)}
  else if(ev.type==="tool_result")toolResult(d.id,d.name,d.result);
  else if(ev.type==="approval"){addApproval(d)}
  else if(ev.type==="approval_result")approvalDone(d);
  else if(ev.type==="plan_ready"){addPlanCard(d);finishTurn(ev.ts)}
  else if(ev.type==="model_switch"){var why=(d.error||"").slice(0,60);addNote("模型已切换："+d.from+" → "+d.to+(why?"（"+why+"）":""));loadInfo().catch(function(){})}
  else if(ev.type==="max_turns"){addNote("已达到最大轮数（"+d.max_turns+"），任务未完成。",true);finishTurn(ev.ts)}
  else if(ev.type==="auto_compact"){addNote("已自动压缩较早的对话以节省上下文。")}
  S.lastTs=ev.ts||S.lastTs}
function scrollEnd(){var f=$("feed");f.scrollTop=f.scrollHeight}
function nearEnd(){var f=$("feed");return f.scrollHeight-f.scrollTop-f.clientHeight<120}
/* ---------- side panels ---------- */
function renderUsage(u,count){var box=$("usage-kv"),hint=$("usage-hint");box.textContent="";S.usage=u;renderUsagePill();
  if(!u){hint.textContent="本次进程尚无用量数据。";return}
  var show=function(n){return n==null?"未报告":Number(n).toLocaleString()};
  var rows=[["模型调用",u.calls+" 次（报告 "+u.reported_calls+" 次）"],["输入 Token",show(u.prompt_tokens)],["输出 Token",show(u.completion_tokens)],["Token 合计",show(u.total_tokens)],["最近输入",show(u.last_prompt_tokens)],["配置上下文",u.context_window_tokens==null?"未配置":show(u.context_window_tokens)],["参考剩余",u.context_remaining_tokens==null?"未知":show(u.context_remaining_tokens)]];
  rows.forEach(function(r){box.appendChild(el("span",null,r[0]));box.appendChild(el("span",null,r[1]))});
  hint.textContent=(u.missing_calls?u.missing_calls+" 次 API 响应未报告用量；累计值不完整。":"仅统计模型报告的 token。")+(u.context_remaining_tokens==null?" 无法确认上下文剩余。":" 余量按最近请求的输入 tokens 估算，不含输出和下一轮输入。")+" 自动压缩次数："+count+"（需要显式启用）。"}
function renderUsagePill(){var u=S.usage,p=$("usage-pill"),tok=$("sb-tok"),ctx=$("sb-ctx");
  if(!u||(u.prompt_tokens==null&&u.completion_tokens==null&&u.total_tokens==null)){p.hidden=true;tok.hidden=true;ctx.hidden=true;return}
  var txt=u.prompt_tokens!=null||u.completion_tokens!=null?(fmtK(u.prompt_tokens)+" 入 · "+fmtK(u.completion_tokens)+" 出"):(fmtK(u.total_tokens)+" Token");
  p.textContent="Token "+txt;p.hidden=false;tok.textContent=txt;tok.hidden=false;
  if(u.last_prompt_tokens!=null&&u.context_window_tokens){ctx.textContent="上下文 "+Math.min(100,Math.round(u.last_prompt_tokens*100/u.context_window_tokens))+"%";ctx.hidden=false}else ctx.hidden=true}
function renderSide(v){renderUsage(v.usage,v.auto_compact_count||0);var p=$("plan");p.textContent="";
  if(v.plan){var t=el("div");t.appendChild(el("b",null,v.plan.title||"计划"));t.appendChild(el("span","badge",v.plan.state==="running"?"进行中":"已结束"));p.appendChild(t);var ol=el("ol");v.plan.steps.forEach(function(s){ol.appendChild(el("li",null,s))});p.appendChild(ol)}
  else p.appendChild(el("div","empty","这个会话还没有调用 plan 工具。计划模式生成的 plan.md 会显示在对话里。"));
  var e=$("evidence");e.textContent="";$("ev-count").textContent=v.evidence&&v.evidence.length?String(v.evidence.length):"";
  if(!v.evidence||!v.evidence.length){e.appendChild(el("div","empty","联网抓取的页面原文会作为证据列在这里。"));return}
  v.evidence.forEach(function(x){var a=el("div","ev");var safe=/^https?:\/\//.test(x.source);var l=el(safe?"a":"span",null,x.query?("搜索："+x.query):x.source);if(safe){l.href=x.source;l.target="_blank";l.rel="noopener noreferrer"}a.appendChild(l);a.appendChild(el("small",null,[x.kind,x.time,x.file].filter(Boolean).join(" · ")));e.appendChild(a)})}
/* --- Artifacts panel ---
 * The server has no artifact endpoint and its routes are fixed, so this
 * panel derives artifacts from the messages already polled through
 * session_view — the client-side mirror of nyra/artifacts.py
 * detect_artifacts: fenced code blocks and HTML blocks. Artifact
 * content NEVER reaches innerHTML on this page: code goes through
 * textContent, Markdown is built with DOM APIs only, and HTML renders
 * only inside a sandboxed iframe via srcdoc. */
var artifacts=[];
var artifactSeen={};
var artifactSel=null;
var artifactSid=null;
function artifactHash(s){var h=5381,i;for(i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))|0}return (h>>>0).toString(36)}
function artifactKey(kind,title,content){return kind+"|"+title+"|"+artifactHash(content)}
function clearEl(node){while(node.firstChild)node.removeChild(node.firstChild)}
function addArtifact(kind,title,content,lang){var key=artifactKey(kind,title,content);if(artifactSeen[key])return;artifactSeen[key]=1;
  artifacts.push({id:"a"+artifacts.length+"-"+artifactHash(content),kind:kind,title:title,content:content,lang:lang||""});renderArtifactList()}
var HTML_START=/^\s*<(?:!DOCTYPE\s+html|html|body|div|section|article|main|table|ul|ol|form|svg|details|blockquote|pre|h[1-6]|p)\b/i;
var HTML_CLOSE=/<\/[A-Za-z][A-Za-z0-9]*\s*>/;
var FENCE_RE=/```([^\s`]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
function scanHtmlBlocks(text){var lines=text.split("\n");var i=0;
  while(i<lines.length){if(!HTML_START.test(lines[i])){i++;continue}
    var j=i,seen=false;
    while(j<lines.length){if(HTML_CLOSE.test(lines[j]))seen=true;
      if(seen){var nxt=j+1<lines.length?lines[j+1]:"";
        if(nxt.trim()===""||/^\s*</.test(nxt)){j++;continue}break}
      j++}
    if(seen){var block=lines.slice(i,j+1).join("\n").replace(/\n+$/,"");
      if(block)addArtifact("html","HTML 页面",block,"html");i=j+1}
    else i++}}
function scanArtifacts(text){if(!text)return;var m;
  FENCE_RE.lastIndex=0;
  while((m=FENCE_RE.exec(text))){var lang=(m[1]||"").trim();
    if(lang.toLowerCase()==="html")addArtifact("html","HTML 页面",m[2],"html");
    else addArtifact("code",lang?lang+" 代码":"代码片段",m[2],lang)}
  FENCE_RE.lastIndex=0;
  scanHtmlBlocks(text.replace(FENCE_RE,""))}
/* Markdown subset for artifacts, DOM-only (no innerHTML): headings,
 * bold/italic, inline code, fenced code blocks, lists, links. Mirrors
 * nyra/artifacts.py markdown_to_html. Source text enters only through
 * textContent, so HTML in the source can never execute. */
function mdText(parent,text){var re=/(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  var last=0,m;
  while((m=re.exec(text))){if(m.index>last)parent.appendChild(document.createTextNode(text.slice(last,m.index)));
    var tok=m[0];
    if(tok.charAt(0)==="`"){var c=document.createElement("code");c.textContent=tok.slice(1,-1);parent.appendChild(c)}
    else if(tok.indexOf("**")===0){var b=document.createElement("strong");b.textContent=tok.slice(2,-2);parent.appendChild(b)}
    else if(tok.charAt(0)==="*"){var em=document.createElement("em");em.textContent=tok.slice(1,-1);parent.appendChild(em)}
    else{var mm=tok.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);var a=document.createElement("a");a.textContent=mm[1];a.href=mm[2];a.target="_blank";a.rel="noopener noreferrer";parent.appendChild(a)}
    last=m.index+tok.length}
  if(last<text.length)parent.appendChild(document.createTextNode(text.slice(last)))}
function mdBlocks(frag,text){var lines=text.split("\n");var list=null;
  function closeList(){if(list){frag.appendChild(list);list=null}}
  lines.forEach(function(line){var m;
    if((m=line.match(/^\s*[-*]\s+(.+)$/))){if(!list||list.tagName!=="UL"){closeList();list=document.createElement("ul")}var li=document.createElement("li");mdText(li,m[1]);list.appendChild(li);return}
    if((m=line.match(/^\s*\d+[.)]\s+(.+)$/))){if(!list||list.tagName!=="OL"){closeList();list=document.createElement("ol")}var li=document.createElement("li");mdText(li,m[1]);list.appendChild(li);return}
    closeList();
    if((m=line.match(/^#{1,3}\s+(.+)$/))){var h=document.createElement("h3");mdText(h,m[1]);frag.appendChild(h);return}
    if((m=line.match(/^#{4,6}\s+(.+)$/))){var h4=document.createElement("h4");mdText(h4,m[1]);frag.appendChild(h4);return}
    if(line.trim()==="")return;
    var p=document.createElement("p");mdText(p,line);frag.appendChild(p)});
  closeList()}
function mdArtifact(src){var frag=document.createDocumentFragment();
  var parts=String(src||"").split(/```([^\s`]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm);
  for(var k=0;k<parts.length;k++){
    if(k%3===2){var pre=document.createElement("pre");var code=document.createElement("code");code.textContent=parts[k];pre.appendChild(code);frag.appendChild(pre);continue}
    if(k%3===1)continue;
    mdBlocks(frag,parts[k])}
  return frag}
function renderArtifactList(){var box=$("artifact-list");if(!box)return;clearEl(box);
  if(!artifacts.length){var e=el("div","empty");e.textContent="对话里出现的代码与 HTML 会自动出现在这里。";box.appendChild(e);return}
  artifacts.forEach(function(a){var b=el("button","art-item");b.type="button";if(artifactSel===a.id)b.classList.add("active");
    var k=el("span","k");k.textContent=a.kind;b.appendChild(k);
    var t=el("b");t.textContent=a.title;b.appendChild(t);
    b.onclick=function(){selectArtifact(a.id)};box.appendChild(b)})}
function selectArtifact(id){artifactSel=id;var a=null;
  artifacts.forEach(function(x){if(x.id===id)a=x});
  renderArtifactList();var view=$("artifact-view");if(!a){view.hidden=true;return}
  view.hidden=false;$("artifact-title").textContent=a.title+(a.lang?" · "+a.lang:"");
  var body=$("artifact-body");clearEl(body);
  var note=$("artifact-note");
  if(a.kind==="code"){var pre=document.createElement("pre");var code=document.createElement("code");code.textContent=a.content;pre.appendChild(code);body.appendChild(pre);note.textContent="代码以纯文本显示，不会执行。"}
  else if(a.kind==="html"){var f=document.createElement("iframe");f.setAttribute("sandbox","allow-scripts");f.setAttribute("srcdoc",a.content);f.setAttribute("title",a.title);body.appendChild(f);note.textContent="HTML 在沙盒 iframe 中渲染，与本页面隔离。"}
  else{body.appendChild(mdArtifact(a.content));note.textContent="Markdown 子集渲染（标题、粗斜体、代码、列表、链接）；原文中的 HTML 已转义，不会执行。"}}
function resetArtifacts(sid){if(artifactSid===sid)return;artifactSid=sid;artifacts=[];artifactSeen={};artifactSel=null;renderArtifactList()}
function setBusy(b){$("send").disabled=b;$("send").setAttribute("aria-label",b?"执行中":"发送");$("mode").disabled=b}
/* ---------- run status ---------- */
function setStatus(st){S.status=st;setBusy(st==="running");renderRunStatus();renderSessions();
  clearInterval(S.tick);if(st==="running")S.tick=setInterval(function(){if(S.turn&&S.turn.groups[0])updateGroup(S.turn.groups[0])},1000)}
function renderRunStatus(){var p=$("run-status");var dot=p.querySelector(".dot"),tx=p.querySelector("span");p.classList.remove("warn");
  if(S.pending){dot.className="dot warn";tx.textContent="等待批准";p.classList.add("warn")}
  else if(S.status==="running"){dot.className="dot";tx.textContent="运行中"}
  else if(S.status==="error"){dot.className="dot bad";tx.textContent="出错"}
  else{dot.className="dot "+(S.info&&S.info.credentials?"ok":"");tx.textContent=S.info&&!S.info.credentials?"未配置 Key":"空闲"}}
/* ---------- sessions ---------- */
function sessionTitle(s){var p=s.preview||"";if(p.indexOf(PLAN_EXEC_PREFIX.slice(0,20))===0)return "执行计划";return p||"（空会话）"}
function renderSessions(){var box=$("sessions");if(!box)return;box.textContent="";var q=($("search").value||"").trim().toLowerCase();
  var list=S.sessions.filter(function(s){return !q||sessionTitle(s).toLowerCase().indexOf(q)>=0||String(s.id).indexOf(q)>=0});
  var cur=S.project||{name:"当前项目",workdir:""};var groups={},order=[];
  function grp(key,name,isCur){if(!groups[key]){groups[key]={name:name,cur:isCur,items:[]};order.push(key)}return groups[key]}
  grp(cur.workdir,cur.name,true);
  list.forEach(function(s){if(s.workdir)grp(s.workdir,s.project||s.workdir,s.workdir===cur.workdir).items.push(s)});
  // A brand-new session has no file yet: keep it visible under the current project.
  if(S.sid&&!S.sessions.some(function(s){return s.id===S.sid})&&!q)groups[cur.workdir].items.unshift({id:S.sid,preview:"新会话",fresh:true,workdir:cur.workdir});
  var other=list.filter(function(s){return !s.workdir});
  order.forEach(function(key){var g=groups[key];var exp=S.collapsed[key]===undefined?true:!S.collapsed[key];
    var hb=el("button","proj");hb.type="button";hb.setAttribute("aria-expanded",String(exp));hb.title=key;hb.innerHTML=svg("chev").replace('class="i"','class="i chev"');hb.appendChild(el("span",null,g.name));if(g.cur)hb.appendChild(el("span","cur","当前"));
    hb.onclick=function(){S.collapsed[key]=exp;renderSessions()};box.appendChild(hb);
    if(!exp)return;
    if(!g.items.length)box.appendChild(el("div","empty",q?"无匹配会话":"还没有会话"));
    g.items.forEach(function(s){box.appendChild(sessionButton(s,false))})});
  if(other.length){box.appendChild(el("div","sh",null)).appendChild(el("span",null,"其他会话"));other.forEach(function(s){box.appendChild(sessionButton(s,true))})}}
function sessionButton(s,flat){var b=el("button","th"+(flat?" flat":""));b.type="button";b.dataset.id=s.id;if(s.id===S.sid){b.classList.add("on");b.setAttribute("aria-current","true")}
  if(s.id===S.sid&&S.status==="running"){var sp=el("span",S.pending?"dot warn":"spin");sp.setAttribute("aria-hidden","true");b.appendChild(sp)}
  b.appendChild(el("span","tt",s.fresh?"新会话":sessionTitle(s)));if(s.mtime)b.appendChild(el("span","t",relTime(s.mtime)));b.title=s.id;
  b.onclick=function(){showView("chat");loadSession(s.id);closeSide()};return b}
function loadSessions(){return api("/api/sessions").then(function(r){S.sessions=r.sessions||[];S.project=r.project||null;$("crumb-project").textContent=S.project?S.project.name:"";renderSessions();updateCrumb()})}
function updateCrumb(){var s=null;S.sessions.forEach(function(x){if(x.id===S.sid)s=x});$("crumb-title").textContent=s?sessionTitle(s):"新会话";document.title=(s?short(sessionTitle(s),40)+" · ":"")+"Nyra"}
function loadSession(sid){clearTimeout(S.timer);S.sid=sid;S.next=0;resetArtifacts(sid);S.pending=null;updateCrumb();renderSessions();
  return api("/api/sessions/"+encodeURIComponent(sid)).then(function(v){if(sid!==S.sid)return;
    S.pending=v.pending;var running=v.status==="running";
    var planRun=v.events.some(function(e){return e.type==="user"&&e.data&&e.data.plan});
    if(running||planRun){renderTranscript(v.messages);S.status=running?"running":v.status;v.events.forEach(applyEvent)}
    else{renderTranscript(v.messages);applyTiming(v.events)}
    if(!v.messages.length&&!v.events.length)welcome();
    S.next=v.next;renderSide(v);
    if(v.status==="error"&&v.error)addNote("错误："+v.error,true);
    setStatus(v.status);if(running)poll();scrollEnd()}).catch(function(e){toast("读取会话失败："+e.message)})}
// For a finished run only the timing comes from its events (the transcript has no timestamps).
function applyTiming(events){var first=null,last=null;events.forEach(function(e){if(e.type==="user"&&first==null)first=e.ts;last=e.ts});
  var t=S.turns[S.turns.length-1];if(t&&first!=null&&last!=null){t.start=first;t.dur=last-first;t.groups.forEach(updateGroup);var w=$("worked");w.textContent="工作了 "+fmtDur(t.dur);w.hidden=false}}
function poll(delay){clearTimeout(S.timer);S.timer=setTimeout(function(){if(!S.sid)return;var sid=S.sid;
  api("/api/sessions/"+encodeURIComponent(sid)+"?since="+S.next).then(function(v){if(sid!==S.sid)return;var stick=nearEnd();
    v.events.forEach(applyEvent);S.next=v.next;S.pending=v.pending;renderSide(v);if(v.events.length&&stick)scrollEnd();
    if(v.status==="running"){renderRunStatus();poll()}
    else{if(S.turn&&!S.turn.done)finishTurn(S.lastTs||null);if(v.status==="error"&&v.error)addNote("错误："+v.error,true);setStatus(v.status);if(stick)scrollEnd();loadSessions()}}).catch(function(){poll(1500)})},delay==null?600:delay)}
function newSession(){return api("/api/sessions",{method:"POST",body:"{}"}).then(function(r){clearTimeout(S.timer);S.sid=r.id;S.next=0;S.pending=null;resetArtifacts(r.id);resetFeed();welcome();
  renderSide({plan:null,evidence:[],usage:null});setStatus("idle");updateCrumb();showView("chat");$("input").focus()})}
function send(){var t=$("input").value.trim();if(!t||S.status==="running")return;var go=S.sid?Promise.resolve():newSession();var plan=S.planMode;
  go.then(function(){$("input").value="";autosize();
    return api("/api/sessions/"+encodeURIComponent(S.sid)+(plan?"/plan":"/messages"),{method:"POST",body:JSON.stringify({text:t})})})
  .then(function(r){if(r.status==="error"){addNote("错误："+r.error,true);return}S.next=0;setStatus("running");poll(200);loadSessions()})
  .catch(function(e){addNote("错误："+e.message,true)})}
function autosize(){var i=$("input");i.style.height="auto";i.style.height=Math.min(i.scrollHeight,200)+"px"}
/* ---------- memory dialog ---------- */
var memoryView={scope:null,revision:null,content:null,loading:false};
function memoryParams(){if(!memoryView.scope)return "";var s=memoryView.scope;return "?scope="+encodeURIComponent(s.scope)+(s.room?"&room="+encodeURIComponent(s.room):"")+(s.bot?"&bot="+encodeURIComponent(s.bot):"")}
function setMemoryStatus(msg){$("memory-status").textContent=msg}
function memoryDirty(){return memoryView.content!==null&&$("memory-content").value!==memoryView.content}
function readMemory(){if(!memoryView.scope)return Promise.resolve();memoryView.loading=true;$("memory-save").disabled=true;setMemoryStatus("正在读取…");
  return api("/api/memory"+memoryParams()).then(function(v){memoryView.revision=v.revision;memoryView.content=v.content;$("memory-content").value=v.content;
    setMemoryStatus((v.exists?"已载入":"暂无记忆文件")+" · "+v.bytes+" 字节 · 模型参考最后 "+v.summary_lines+" 行");
  }).catch(function(e){memoryView.revision=null;memoryView.content=null;setMemoryStatus("读取失败："+e.message)}).finally(function(){memoryView.loading=false;$("memory-save").disabled=false})}
function openMemory(){closeSide();return api("/api/memory/scopes").then(function(data){var sel=$("memory-scope");sel.textContent="";
    data.scopes.forEach(function(s,i){var opt=document.createElement("option");opt.value=String(i);opt.textContent=s.label;sel.appendChild(opt)});
    if(!data.scopes.length)throw new Error("没有可用记忆范围");
    var ix=data.scopes.findIndex(function(s){return memoryView.scope&&s.scope===memoryView.scope.scope&&s.room===memoryView.scope.room&&s.bot===memoryView.scope.bot});
    sel.value=String(ix<0?0:ix);memoryView.scope=data.scopes[Number(sel.value)];memoryView.scopes=data.scopes;
    $("memory-dialog").showModal();return readMemory();
  }).catch(function(e){setMemoryStatus("加载失败："+e.message);$("memory-dialog").showModal()})}
function saveMemory(){if(memoryView.loading||memoryView.revision===null||!memoryView.scope)return;
  var text=$("memory-content").value;
  if(!text&&memoryView.content&&!window.confirm("确定清空该机器人全部长期记忆吗？"))return;
  $("memory-save").disabled=true;setMemoryStatus("正在保存…");
  return api("/api/memory",{method:"POST",body:JSON.stringify({scope:memoryView.scope.scope,room:memoryView.scope.room,bot:memoryView.scope.bot,revision:memoryView.revision,content:text})})
    .then(function(v){memoryView.revision=v.revision;memoryView.content=v.content;setMemoryStatus("已保存 · "+v.bytes+" 字节。下次模型请求可使用更新后的记忆。")})
    .catch(function(e){setMemoryStatus("保存失败（本地编辑仍保留）："+e.message+"；请先复制本地修改，再重新读取合并。")})
    .finally(function(){$("memory-save").disabled=false})}
/* ---------- info, settings, model + mode pickers ---------- */
function loadInfo(){return api("/api/info").then(function(i){S.info=i;$("ver").textContent="v"+i.version;
  var sel=$("mode");sel.textContent="";i.modes.forEach(function(m){var o=el("option",null,MODE_LABEL[m]||m);o.value=m;if(m===i.mode)o.selected=true;sel.appendChild(o)});
  syncModeSeg(i.mode);fillModelSelect();
  $("sb-dir").textContent=i.workdir;$("sb-mode").textContent="模式："+(MODE_LABEL[i.mode]||i.mode);
  $("sb-mcp").textContent=(i.config&&i.config.mcp_enabled)?("MCP · "+i.mcp_tools+" 个工具"):"MCP 未启用";
  $("hint").textContent=S.planMode?"计划模式：只读分析，仅写入 plan.md":(i.mode==="auto"?"写入与命令前会请你批准 · Enter 发送":i.mode==="full"?"完整权限：工具调用自动批准 · Enter 发送":"只读：不写文件、不跑命令 · Enter 发送");
  var kv=$("model-kv");kv.textContent="";var rows=[["Provider",i.provider||"—"],["模型",i.model||"—"],["凭据",i.credentials?"已配置":"未配置"],["模式",MODE_LABEL[i.mode]||i.mode],["工作目录",i.workdir]];
  if(i.model_switches&&i.model_switches.length)rows.push(["切换记录",i.model_switches.map(function(s){return s.from+" → "+s.to+"（"+s.error+"）"}).join("；")]);
  if(i.fallback_chain&&i.fallback_chain.length)rows.push(["兜底链",i.fallback_chain.join(" → ")]);
  rows.forEach(function(r){kv.appendChild(el("span",null,r[0]));kv.appendChild(el("span",null,r[1]))});
  var c=$("cfg-kv");c.textContent="";var cfg=i.config||{};[["版本",i.version],["当前 provider",i.provider_desc||i.provider_error||"—"],["最大轮数",cfg.max_turns],["配置上下文窗口",cfg.context_window_tokens||"未知"],["自动压缩",cfg.auto_compact_enabled?("已启用 · "+cfg.auto_compact_threshold*100+"%"):"未启用"],["MCP",cfg.mcp_enabled?("已启用（"+i.mcp_tools+" 个工具）"):"未启用"],["沙盒（配置）",(cfg.sandbox||"local")+"（网页界面在本地执行）"],["档案",(cfg.profiles||[]).join(", ")||"—"]].forEach(function(r){c.appendChild(el("span",null,r[0]));c.appendChild(el("span",null,r[1]==null?"—":String(r[1])))});
  var k=$("keys");k.textContent="";i.keys.forEach(function(x){var tr=el("tr");var st=x.env?(x.configured?"已配置":(x.connector?"未设置（可用已保存连接器）":(x.needs_key?"未设置":"无需 Key"))):"无需 Key";
    tr.appendChild(el("td",null,x.provider));var td=el("td");if(x.env)td.appendChild(el("code",null,x.env));else td.textContent="—";tr.appendChild(td);tr.appendChild(el("td",null,st));k.appendChild(tr)});
  var ps=$("provider-select");ps.textContent="";(i.providers||[]).forEach(function(pr){var o=el("option",null,pr.name+(pr.default_model?" · "+pr.default_model:" · 自定义"));o.value=pr.name;if(pr.name===i.provider)o.selected=true;ps.appendChild(o)});
  fillModelList();renderRunStatus()})}
function fillModelSelect(){var i=S.info,sel=$("model-select");sel.textContent="";var cur=(i.provider||"")+"|"+(i.model||"");var seen={};
  (i.providers||[]).forEach(function(pr){var models=[pr.default_model].concat(pr.models||[]).filter(Boolean);if(pr.name===i.provider&&i.model)models.unshift(i.model);
    var og=document.createElement("optgroup");og.label=pr.name+(pr.env_key&&!pr.configured?"（未设 Key）":"");
    models.forEach(function(m){var v=pr.name+"|"+m;if(seen[v])return;seen[v]=1;var o=el("option",null,m);o.value=v;og.appendChild(o)});if(og.children.length)sel.appendChild(og)});
  if(!seen[cur]&&i.provider){var o=el("option",null,i.model||i.provider);o.value=cur;sel.insertBefore(o,sel.firstChild)}
  sel.value=cur}
function syncModeSeg(mode){document.querySelectorAll("#mode-seg button").forEach(function(b){b.classList.toggle("active",b.dataset.mode===mode);b.setAttribute("aria-pressed",String(b.dataset.mode===mode))})}
function fillModelList(){var ps=$("provider-select");if(!ps||!S.info)return;var name=ps.value;var pr=null;(S.info.providers||[]).forEach(function(p){if(p.name===name)pr=p});
  var dl=$("model-list");dl.textContent="";(pr&&pr.models||[]).forEach(function(m){var o=document.createElement("option");o.value=m;dl.appendChild(o)});
  var mi=$("model-input");if(mi&&!mi.dataset.touched)mi.value=(name===S.info.provider)?(S.info.model||(pr?pr.default_model||"":"")):(pr?pr.default_model||"":"")}
function setMode(m){return api("/api/mode",{method:"POST",body:JSON.stringify({mode:m})}).then(function(){toast("审批模式："+(MODE_LABEL[m]||m));return loadInfo()}).catch(function(e){toast("切换失败："+e.message);return loadInfo()})}
function setProvider(name,model){return api("/api/provider",{method:"POST",body:JSON.stringify({provider:name,model:model||null})}).then(function(r){toast("已切换到 "+r.provider+" / "+r.model+"，新会话生效");return loadInfo().then(function(){return r})})}
/* ---------- pages ---------- */
function loadSkills(){if(!S.info)return;var i=S.info;var sl=$("skills-list");sl.textContent="";
  if(!(i.skills||[]).length)sl.appendChild(el("div","empty","没有可用技能。"));
  (i.skills||[]).forEach(function(s){var d=el("div","skillcard");d.appendChild(el("b",null,s.name));d.appendChild(el("p",null,s.description||""));sl.appendChild(d)});
  var g=$("tools-grid");g.textContent="";$("tool-count").textContent=String((i.tools||[]).length);
  (i.tools||[]).forEach(function(t){var d=el("div","toolcard");d.appendChild(el("b",null,t.name));d.appendChild(el("span","badge",t.needs_approval?"需批准":"只读"));d.appendChild(el("p",null,t.description||""));g.appendChild(d)})}
function loadSchedule(){return api("/api/schedule").then(function(r){var box=$("sched-list");box.textContent="";
  if(!r.tasks.length){box.appendChild(el("div","empty","还没有定时任务。用 nyra schedule add 命令添加。"));return}
  r.tasks.forEach(function(t){var row=el("div","sched-row");var grow=el("div","grow");grow.appendChild(el("b",null,t.name));
    var parts=[t.at?("每天 "+t.at):(t.every_seconds?("每 "+Math.round(t.every_seconds/60)+" 分钟"):""),(MODE_LABEL[t.mode]||t.mode)+"模式"];
    if(t.provider)parts.push(t.provider+(t.model?(" / "+t.model):""));if(t.last_status)parts.push("上次："+t.last_status);if(t.last_run)parts.push("上次运行："+fmtTime(t.last_run));if(t.last_summary)parts.push("摘要："+String(t.last_summary).slice(0,80));
    grow.appendChild(el("span",null,parts.filter(Boolean).join(" · ")));var p=el("div",null,t.prompt);p.style.cssText="font-size:12.5px;color:var(--mu);overflow-wrap:anywhere";grow.appendChild(p);row.appendChild(grow);
    var lab=el("label","switch");var cb=document.createElement("input");cb.type="checkbox";cb.checked=!!t.enabled;cb.setAttribute("aria-label","启用 "+t.name);lab.appendChild(cb);lab.appendChild(el("span","tr"));
    cb.onchange=function(){api("/api/schedule",{method:"POST",body:JSON.stringify({action:"toggle",name:t.name})}).then(loadSchedule).catch(function(e){$("sched-status").textContent="切换失败："+e.message;cb.checked=!cb.checked})};row.appendChild(lab);
    var del=el("button","btn-danger","删除");del.type="button";del.onclick=function(){if(!window.confirm("确定删除定时任务「"+t.name+"」吗？"))return;api("/api/schedule",{method:"POST",body:JSON.stringify({action:"remove",name:t.name})}).then(loadSchedule).catch(function(e){$("sched-status").textContent="删除失败："+e.message})};
    row.appendChild(del);box.appendChild(row)})}).catch(function(e){var b=$("sched-list");b.textContent="";b.appendChild(el("div","empty","定时任务读取失败："+e.message))})}
function loadGroups(){return api("/api/groups").then(function(r){var box=$("group-list");box.textContent="";
  if(!r.groups.length){box.appendChild(el("div","empty","还没有机器人群。在群聊页面新建一个群。"));return}
  r.groups.forEach(function(g){var row=el("div","sched-row");var grow=el("div","grow");grow.appendChild(el("b",null,g.name));grow.appendChild(el("span",null,g.bots+" 位机器人"));row.appendChild(grow);
    var open=el("a","tbtn p","打开");open.href="/groups?token="+encodeURIComponent(TOKEN)+"&room="+encodeURIComponent(g.id);row.appendChild(open);box.appendChild(row)})}).catch(function(e){var b=$("group-list");b.textContent="";b.appendChild(el("div","empty","群列表读取失败："+e.message))})}
function showView(name){S.view=name;
  document.querySelectorAll("#nav [data-view], #open-settings").forEach(function(b){b.classList.toggle("on",b.dataset.view===name)});
  ["chat","skills","schedule","group","settings"].forEach(function(v){$("view-"+v).hidden=v!==name});
  var showR=name==="chat"&&S.reviewOpen;$("right").hidden=!showR;$("toggle-right").setAttribute("aria-pressed",String(showR));$("toggle-right").disabled=name!=="chat";
  if(name==="skills")loadSkills();if(name==="schedule")loadSchedule();if(name==="group")loadGroups();
  $("crumb-title").textContent=name==="chat"?$("crumb-title").textContent:{skills:"技能与工具",schedule:"定时任务",group:"机器人群聊",settings:"设置"}[name];if(name==="chat")updateCrumb();closeSide()}
/* ---------- review pane ---------- */
function openReview(pane){S.reviewOpen=true;if(S.view!=="chat")showView("chat");$("right").hidden=false;$("toggle-right").setAttribute("aria-pressed","true");if(pane)selectPane(pane)}
function closeReview(){S.reviewOpen=false;$("right").hidden=true;$("toggle-right").setAttribute("aria-pressed","false")}
function selectPane(name){document.querySelectorAll("#right .tab").forEach(function(t){var on=t.dataset.pane===name;t.classList.toggle("active",on);t.setAttribute("aria-selected",String(on));t.tabIndex=on?0:-1});
  ["diff","plan","evidence","term","artifacts","status"].forEach(function(p){$("pane-"+p).hidden=p!==name})}
function openSide(){$("app").classList.add("side-open");$("toggle-left").setAttribute("aria-expanded","true");var f=$("side").querySelector("button");if(f)f.focus()}
function closeSide(){if(!$("app").classList.contains("side-open"))return;$("app").classList.remove("side-open");$("toggle-left").setAttribute("aria-expanded","false")}
/* ---------- wiring ---------- */
$("form").addEventListener("submit",function(e){e.preventDefault();send()});
$("input").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
$("input").addEventListener("input",autosize);
$("new-session").onclick=function(){newSession();closeSide()};
$("search").addEventListener("input",renderSessions);
$("mode").onchange=function(){setMode(this.value)};
$("model-select").onchange=function(){var v=this.value.split("|");setProvider(v[0],v.slice(1).join("|")).catch(function(e){toast("切换失败："+e.message);loadInfo()})};
$("plan-toggle").onclick=function(){S.planMode=!S.planMode;this.setAttribute("aria-pressed",String(S.planMode));$("input").placeholder=S.planMode?"描述任务，Nyra 先只读分析并写出 plan.md…":"给 Nyra 一个任务…";if(S.info)$("hint").textContent=S.planMode?"计划模式：只读分析，仅写入 plan.md":"Enter 发送 · Shift+Enter 换行";$("input").focus()};
$("mode-seg").addEventListener("click",function(e){var b=e.target.closest("button[data-mode]");if(b)setMode(b.dataset.mode)});
$("model-input").addEventListener("input",function(){this.dataset.touched="1"});
$("provider-select").addEventListener("change",function(){$("model-input").dataset.touched="";fillModelList()});
$("apply-provider").onclick=function(){var st=$("provider-status");st.textContent="切换中…";
  setProvider($("provider-select").value,($("model-input").value||"").trim()).then(function(r){$("model-input").dataset.touched="";st.textContent="已切换到 "+r.provider+" / "+r.model+"，新会话生效。"}).catch(function(e){st.textContent="切换失败："+e.message})};
document.querySelectorAll("#nav [data-view], #open-settings").forEach(function(b){b.addEventListener("click",function(){showView(b.dataset.view)})});
$("open-memory").onclick=openMemory;
$("memory-refresh").onclick=function(){if(memoryDirty()&&!window.confirm("有未保存的编辑，确定丢弃并重新读取吗？"))return;readMemory()};
$("memory-save").onclick=saveMemory;
$("memory-close").onclick=function(){if(memoryDirty()&&!window.confirm("有未保存的编辑，确定关闭吗？"))return;$("memory-dialog").close()};
$("memory-scope").onchange=function(){
  if(memoryDirty()&&!window.confirm("切换机器人会丢弃未保存的编辑，是否继续？")){var ix=memoryView.scopes.findIndex(function(s){return s===memoryView.scope});this.value=String(ix);return}
  memoryView.scope=memoryView.scopes[Number(this.value)];readMemory()};
$("memory-dialog").addEventListener("cancel",function(e){if(memoryDirty()&&!window.confirm("有未保存的编辑，确定关闭吗？"))e.preventDefault()});
$("toggle-right").onclick=function(){if($("right").hidden)openReview();else closeReview()};
$("close-right").onclick=function(){closeReview();$("toggle-right").focus()};
$("toggle-left").onclick=function(){if($("app").classList.contains("side-open"))closeSide();else openSide()};
$("scrim").onclick=closeSide;
document.querySelector("#right .rt").addEventListener("click",function(e){var t=e.target.closest(".tab");if(t)selectPane(t.dataset.pane)});
document.querySelector("#right .rt").addEventListener("keydown",function(e){if(e.key!=="ArrowRight"&&e.key!=="ArrowLeft")return;var tabs=[].slice.call(document.querySelectorAll("#right .tab"));var i=tabs.indexOf(document.activeElement);if(i<0)return;e.preventDefault();var n=tabs[(i+(e.key==="ArrowRight"?1:tabs.length-1))%tabs.length];selectPane(n.dataset.pane);n.focus()});
document.addEventListener("keydown",function(e){var mod=e.metaKey||e.ctrlKey;
  if(mod&&!e.shiftKey&&(e.key==="k"||e.key==="K")){e.preventDefault();if(window.matchMedia("(max-width:820px)").matches)openSide();$("search").focus()}
  else if(mod&&e.shiftKey&&(e.key==="o"||e.key==="O")){e.preventDefault();newSession()}
  else if(mod&&e.key==="."){e.preventDefault();$("toggle-right").click()}
  else if(e.key==="Escape"){if($("app").classList.contains("side-open")){closeSide();$("toggle-left").focus()}else if(!$("right").hidden&&window.matchMedia("(max-width:1180px)").matches){closeReview();$("toggle-right").focus()}}});
loadFonts();
if(window.matchMedia("(min-width:1181px)").matches)openReview("diff");else selectPane("diff");
renderDiffs();renderTerms();renderArtifactList();
loadInfo().then(loadSessions).then(function(){welcome();renderSide({plan:null,evidence:[],usage:null})}).catch(function(e){$("log").textContent="";addNote("无法连接 Nyra："+e.message,true)});
})();
</script>
</body>
</html>
"""
