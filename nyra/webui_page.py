"""The single self-contained page served by `python3 -m nyra ui`.

Inline HTML/CSS/JS only: no CDN, fonts or other external resources.
No avatar image: the assistant is identified by the letter "N" in the
message avatar square.

Brand palette (UI v2, 2026-11-17; the old ink #111A42 / gold #EAC45F are
retired): background #F3F5F4, primary sage #5F7D5C, accent mist #6B8CAE,
warm peach-coral #E07856.
"""


PAGE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Nyra</title>
<style>
:root{--bg:#F3F5F4;--panel:#E9EDEA;--surface:#FFFFFF;--text:#2A2D34;--muted:#6E7278;--line:#DEE3DE;--primary:#5F7D5C;--primary-dark:#4E6A4B;--accent:#6B8CAE;--warm:#E07856;--ok:#4C9A6C;--bad:#C24B42;--code:#2A2D34;--codet:#E9EBF0;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#1F2420;--panel:#262B26;--surface:#2E342E;--text:#E9EDEA;--muted:#9AA39B;--line:#3A4038;--primary:#7FA07B;--primary-dark:#6B8A67;--accent:#8FA8C4;--warm:#E07856;--ok:#6BB98A;--bad:#E0786B;--code:#141814;--codet:#E9EBF0}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 var(--sans);display:grid;grid-template-rows:52px 1fr;overflow:hidden}
button,select,textarea{font:inherit;color:inherit}
code,pre{font-family:var(--mono)}
.top{display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
.brand small{font:500 11px var(--mono);color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted);background:var(--bg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}
.dot{width:8px;height:8px;min-width:8px;min-height:8px;border-radius:50%;background:var(--muted);flex:none}.dot.on{background:var(--ok)}.dot.off{background:var(--bad)}.dot.run{background:var(--accent);box-shadow:0 0 0 3px rgba(107,140,174,.35)}
.spacer{flex:1}
.ibtn{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:13px}
.ibtn:hover{border-color:var(--accent)}
select.ibtn{padding:4px 8px}
.shell{display:grid;grid-template-columns:268px 1fr 324px;min-height:0}
aside{background:var(--panel);min-height:0;overflow:auto}
.left{border-right:1px solid var(--line);padding:12px}
.right{border-left:1px solid var(--line);padding:14px}
.brandcard{display:flex;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:12px}
.brandcard b{display:block;font-size:14px}
.brandcard span{font-size:11.5px;color:var(--muted)}
.nav{display:grid;gap:2px;margin-bottom:12px}
.nav button{display:flex;align-items:center;gap:8px;text-align:left;border:1px solid transparent;background:none;border-radius:10px;padding:8px 10px;cursor:pointer;font-size:13.5px}
.nav button:hover{background:var(--surface)}
.nav button.active{background:var(--surface);border-color:var(--line);box-shadow:inset 3px 0 0 var(--primary)}
.new{width:100%;padding:9px;border-radius:10px;border:1px solid var(--primary);background:var(--primary);color:#fff;font-weight:600;cursor:pointer;margin-bottom:12px}
.label{font:700 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:14px 2px 8px}
.sess{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:10px;padding:8px 10px;cursor:pointer;margin-bottom:2px}
.sess:hover{background:var(--surface)}.sess.active{background:var(--surface);border-color:var(--line);box-shadow:inset 3px 0 0 var(--primary)}
.sess b{display:block;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess span{font:11px var(--mono);color:var(--muted)}
.sidefoot{margin-top:16px;padding:10px 4px 0;border-top:1px solid var(--line);font-size:11.5px;color:var(--muted)}
.empty{color:var(--muted);font-size:13px;padding:6px 4px}
main{min-height:0;min-width:0}
.view{display:none;height:100%;min-height:0}
.view.active{display:block}
#view-chat.active{display:grid;grid-template-rows:1fr auto}
.log{overflow:auto;padding:22px clamp(14px,4vw,48px) 12px}
.page{overflow:auto;padding:22px clamp(14px,4vw,48px) 32px}
.page h2{font-size:18px;margin:0 0 4px}
.page .sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.page h3{font-size:14px;margin:20px 0 8px}
.welcome{max-width:560px;margin:8vh auto;text-align:center;color:var(--muted)}
.welcome h1{color:var(--text);font-size:22px;margin:12px 0 6px}
.msg{max-width:760px;margin:0 auto 14px;display:flex;gap:10px}
.msg .who{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font:700 12px var(--mono);margin-top:2px;overflow:hidden}
.msg.user .who{background:var(--line);color:var(--text)}
.msg.assistant .who{background:var(--primary);color:#fff}
.bubble{min-width:0;flex:1}
.msg.user .bubble{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.md p{margin:0 0 8px}.md p:last-child{margin:0}
.md pre{background:var(--code);color:var(--codet);padding:10px 12px;border-radius:10px;overflow:auto;font-size:12.5px}
.md code{background:rgba(107,140,174,.18);padding:1px 5px;border-radius:5px;font-size:12.5px}
.md pre code{background:none;padding:0}
.md a{color:var(--accent)}
.md ul,.md ol{margin:4px 0 8px;padding-left:22px}
.md h3,.md h4{margin:10px 0 6px;font-size:15px}
.tool{max-width:760px;margin:0 auto 10px 36px;border:1px solid var(--line);border-radius:10px;background:var(--surface);overflow:hidden}
@media (min-width:900px){.tool{margin-left:calc(50% - 344px)}}
.tool summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:7px 12px;font-size:13px}
.tool summary::-webkit-details-marker{display:none}
.tool summary .nm{font:600 12.5px var(--mono)}
.tool summary .ar{color:var(--muted);font:12px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.st{font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;flex:none}
.st.ok{color:var(--ok);background:rgba(76,154,108,.12)}.st.err{color:var(--bad);background:rgba(194,65,58,.12)}.st.wait{color:var(--accent);background:rgba(107,140,174,.18)}
.tool .body{border-top:1px solid var(--line);padding:8px 12px;font-size:12px}
.tool pre{margin:4px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;background:var(--panel);padding:8px;border-radius:8px}
.approve{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--line);background:rgba(224,120,86,.12)}
.approve p{margin:0;flex:1;min-width:200px;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);max-height:360px;overflow:auto}
.yes,.no{border-radius:8px;padding:6px 14px;font-weight:600;cursor:pointer;border:1px solid}
.yes{background:var(--ok);border-color:var(--ok);color:#fff}.no{background:var(--surface);border-color:var(--bad);color:var(--bad)}
.err-line{max-width:760px;margin:0 auto 12px;color:var(--bad);font-size:13px;padding-left:36px}
.switch-line{max-width:760px;margin:0 auto 12px;color:var(--accent);font-size:13px;padding-left:36px}
.composer{border-top:1px solid var(--line);padding:12px clamp(14px,4vw,48px) 14px;background:var(--bg)}
.box{max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:8px}
.box:focus-within{border-color:var(--accent)}
textarea{flex:1;border:0;outline:0;resize:none;background:transparent;min-height:24px;max-height:180px;padding:4px 6px}
.send{border:0;background:var(--primary);color:#fff;border-radius:10px;padding:7px 16px;font-weight:600;cursor:pointer}
.send:disabled{opacity:.45;cursor:default}
.hint{max-width:760px;margin:6px auto 0;font-size:11.5px;color:var(--muted)}
.chips{max-width:760px;margin:8px auto 0;display:flex;gap:8px;flex-wrap:wrap}
.chip{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:4px 12px;font-size:12.5px;cursor:pointer}
.chip:hover{border-color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}
.card h4{margin:0 0 8px;font-size:12px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12.5px}
.kv span:nth-child(odd){color:var(--muted)}.kv span:nth-child(even){overflow-wrap:anywhere}
.plan ol{margin:0;padding-left:20px;font-size:13px}.plan li{margin:3px 0}
.ev{display:block;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line);overflow-wrap:anywhere}
.ev:last-child{border:0}.ev a{color:var(--accent)}.ev small{display:block;color:var(--muted);font:11px var(--mono)}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:12px}
.tabs button{border:0;background:none;padding:7px 10px;cursor:pointer;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button.active{color:var(--text);border-bottom-color:var(--primary);font-weight:600}
dialog{border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--text);max-width:560px;width:calc(100% - 32px);padding:20px}
dialog::backdrop{background:rgba(42,45,52,.45)}
dialog h2{margin:0 0 4px;font-size:18px}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
#memory-dialog{max-width:700px}
#memory-dialog h2{margin-bottom:6px}
.memory-field{display:grid;gap:5px;margin:10px 0}
.memory-field label{font-size:12px;color:var(--muted)}
#memory-scope{width:100%;background:var(--surface);color:var(--text);padding:8px;border:1px solid var(--line);border-radius:8px}
#memory-content{display:block;width:100%;min-height:240px;max-height:52vh;resize:vertical;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;font:12.5px/1.6 var(--mono);white-space:pre;overflow:auto}
.memory-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}
#memory-status{flex:1;min-width:150px;font-size:12px;color:var(--muted)}
.menu{display:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.toolcard{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px}
.toolcard b{font:600 13px var(--mono)}
.toolcard p{margin:6px 0 0;font-size:12.5px;color:var(--muted)}
.skillcard{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
.skillcard b{font-size:14px}
.skillcard p{margin:6px 0 0;font-size:13px;color:var(--muted)}
.swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.swatch{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}
.swatch .chip{height:56px;border:0;border-radius:0;padding:0}
.swatch div{padding:8px 10px;font-size:12px}
.swatch b{display:block;font-size:12.5px}
.swatch span{color:var(--muted);font-family:var(--mono);font-size:11.5px}
.sched-row{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px}
.sched-row b{display:block;font-size:13.5px}
.sched-row span{font-size:12.5px;color:var(--muted)}
.sched-row .grow{flex:1;min-width:0}
.switch{position:relative;width:38px;height:22px;flex:none}
.switch input{opacity:0;width:0;height:0}
.switch .tr{position:absolute;inset:0;background:var(--line);border-radius:999px;cursor:pointer}
.switch .tr:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;background:var(--surface);border-radius:50%;transition:.15s}
.switch input:checked + .tr{background:var(--primary)}
.switch input:checked + .tr:before{transform:translateX(16px)}
.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.form-row input,.form-row select{border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:7px 10px;font-size:13px}
.form-row input{flex:1;min-width:140px}
.btn-primary{border:1px solid var(--primary);background:var(--primary);color:#fff;border-radius:8px;padding:7px 14px;font-weight:600;cursor:pointer}
.btn-danger{border:1px solid var(--bad);background:var(--surface);color:var(--bad);border-radius:8px;padding:6px 12px;cursor:pointer}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.seg button{border:0;background:var(--surface);padding:7px 14px;cursor:pointer;font-size:13px}
.seg button.active{background:var(--primary);color:#fff}
@media (max-width:1240px){.shell{grid-template-columns:268px 1fr}.right{display:none}.shell.show-right .right{display:block;position:fixed;right:0;top:52px;bottom:0;width:324px;z-index:5;box-shadow:-10px 0 30px rgba(0,0,0,.15)}}
@media (max-width:760px){.shell{grid-template-columns:1fr}.left{display:none}.shell.show-left .left{display:block;position:fixed;left:0;top:52px;bottom:0;width:268px;z-index:5;box-shadow:10px 0 30px rgba(0,0,0,.15)}.menu{display:inline-block}.pill.prov{display:none}.pill.modechip{display:none}}
</style>
</head>
<body>
<header class="top">
  <button class="ibtn menu" id="toggle-left" aria-label="会话列表">☰</button>
  <div class="brand"><span>Nyra</span> <small id="ver"></small></div>
  <span class="pill prov" id="prov"><i class="dot"></i><span>…</span></span>
  <span class="spacer"></span>
  <a class="ibtn" id="groupLink" href="/groups" style="text-decoration:none">机器人群聊</a>
  <button class="ibtn" id="open-memory" aria-label="查看和管理长期记忆">长期记忆</button>
  <label class="pill modechip" title="审批模式">模式
    <select class="ibtn" id="mode" aria-label="审批模式"></select></label>
  <button class="ibtn" id="toggle-right" aria-label="检查器">检查器</button>
  <button class="ibtn" id="open-settings" aria-label="设置">⚙ 设置</button>
</header>
<div class="shell" id="shell">
  <aside class="left">
    <div class="brandcard"><div><b>Nyra</b><span>个人智能体 · 本地运行</span></div></div>
    <nav class="nav" id="nav">
      <button data-view="chat" class="active">💬 对话</button>
      <button data-view="skills">🧩 技能与工具</button>
      <button data-view="schedule">⏰ 定时任务</button>
      <button data-view="group">👥 群聊</button>
      <button data-view="brand">🎨 品牌与外观</button>
      <button data-view="settings">⚙️ 设置</button>
    </nav>
    <button class="new" id="new-session">＋ 新会话</button>
    <div class="label">会话</div>
    <div id="sessions"><div class="empty">加载中…</div></div>
    <div class="sidefoot">界面本地运行 · 模型与搜索走云端</div>
  </aside>
  <main>
    <div class="view active" id="view-chat">
      <div class="log" id="log" aria-live="polite"></div>
      <div class="composer">
        <form class="box" id="form">
          <textarea id="input" rows="1" placeholder="给 Nyra 一个任务…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button class="send" id="send" type="submit">发送</button>
        </form>
        <div class="chips" id="chips">
          <button class="chip" type="button" data-prompt="查一下上海博物馆周二开不开，人民广场馆和东馆都要确认，附官网来源">试试核查调研</button>
          <button class="chip" type="button" data-prompt="看一下这个仓库的 git 状态">试试只读工具</button>
          <button class="chip" type="button" data-prompt="删除 ~/Downloads 里 90 天前的 .tmp 文件">试试需要批准的操作</button>
        </div>
        <div class="hint" id="hint">auto 模式下，写文件、执行命令前会在对话里出现审批卡片。</div>
      </div>
    </div>
    <div class="view" id="view-skills">
      <div class="page" style="max-width:820px;margin:0 auto">
        <h2>技能与工具</h2>
        <p class="sub">技能是 Markdown 提示词文件（<code>skills/*.md</code>），按任务关键词自动加载；工具是模型可直接调用的能力。</p>
        <h3>技能</h3>
        <div id="skills-list"><div class="empty">加载中…</div></div>
        <h3>内置工具（<span id="tool-count">15</span> 个）</h3>
        <div class="grid" id="tools-grid"><div class="empty">加载中…</div></div>
      </div>
    </div>
    <div class="view" id="view-schedule">
      <div class="page" style="max-width:820px;margin:0 auto">
        <h2>定时任务</h2>
        <p class="sub">任务存在 <code>~/.nyra/schedule.json</code>，由 <code>nyra schedule daemon</code> 守护进程执行；这里只做查看、开关与删除，执行仍需 daemon 在运行。</p>
        <div id="sched-list"><div class="empty">加载中…</div></div>
        <p class="hint">网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；请用 <code>nyra schedule add</code> 命令添加。</p>
        <p class="hint" id="sched-status" role="status"></p>
      </div>
    </div>
    <div class="view" id="view-group">
      <div class="page" style="max-width:920px;margin:0 auto">
        <h2>群聊</h2>
        <p class="sub">每个机器人有独立的身份、会话、记忆和工作目录；群聊在独立页面进行，这里只列出已有群。</p>
        <div id="group-list"><div class="empty">加载中…</div></div>
        <p><a class="btn-primary" id="group-open" href="/groups" style="text-decoration:none;display:inline-block">打开群聊页面 →</a></p>
      </div>
    </div>
    <div class="view" id="view-brand">
      <div class="page" style="max-width:820px;margin:0 auto">
        <h2>品牌与外观</h2>
        <p class="sub">Nyra 的 UI 由我们自己设计：界面、布局、审美。配色（2026-11-17 定稿）如下；旧墨色 / 金色已退役。</p>
        <h3>配色</h3>
        <div class="swatches" id="swatches"></div>
        <h3>字体</h3>
        <p style="font-size:13px;color:var(--muted)">系统无衬线优先，数字与代码用等宽；中文按系统字体回落。示例：<b>Nyra 今天想让你做什么？</b> <code>deepseek-flash · 14 个 provider 预设 · 15 个工具</code></p>
        <h3>使用规则</h3>
        <ul style="font-size:13px;color:var(--muted);line-height:1.8">
          <li>审批是一等公民：危险操作以卡片形式出现在对话流里（允许一次 / 拒绝），不用弹窗挡路；完整模式才会自动批准，且必须明确切换。</li>
          <li>处处可核查：结论附来源链接，搜索结果只作线索、不直接采信；证据链在检查器里单独列出。</li>
          <li>金色与深墨蓝已退役：不要再把 #111A42 / #EAC45F 用作品牌色；蜜桃珊瑚只作小面积点缀，不做大面积填充。</li>
        </ul>
      </div>
    </div>
    <div class="view" id="view-settings">
      <div class="page" style="max-width:820px;margin:0 auto">
        <h2>设置</h2>
        <p class="sub">模型与审批模式可在这里切换。Key 只显示是否已配置，从不显示其值。这里只改界面运行状态，不保存任何密钥、不改配置文件。</p>
        <h3>模型</h3>
        <div class="form-row" style="margin-bottom:8px">
          <label for="provider-select" style="font-size:13px">Provider</label>
          <select id="provider-select" aria-label="当前 provider"></select>
          <label for="model-input" style="font-size:13px">模型</label>
          <input id="model-input" list="model-list" maxlength="180" style="flex:1;min-width:140px" aria-label="模型 id（留空用该 provider 的默认模型）">
          <datalist id="model-list"></datalist>
          <button class="btn-primary" id="apply-provider" type="button">应用</button>
          <span class="hint" id="provider-status" style="margin:0" role="status"></span>
        </div>
        <p class="hint" style="margin:0 0 8px">切换后立即生效：新会话使用新 provider，已有会话保持原 provider；重启界面后恢复配置文件中的设置。</p>
        <p class="hint" style="margin:0 0 8px">模型自动兜底默认关闭：主模型失败时不会自动换备用模型。开启方式：<code>~/.nyra/config.json</code> 里设 <code>"fallback_enabled": true</code>，或启动时加 <code>--fallback</code>；只切换到 <code>fallback_providers</code> 允许列表里的服务商，队列与定时任务里不切换。发生切换时会在对话流里显示。</p>
        <div class="form-row" style="margin-bottom:8px">
          <label style="font-size:13px">审批模式</label>
          <div class="seg" id="mode-seg">
            <button type="button" data-mode="readonly">只读</button>
            <button type="button" data-mode="auto">审批模式</button>
            <button type="button" data-mode="full">完整模式</button>
          </div>
          <span class="hint" style="margin:0">完整模式会自动批准工具调用，只在可信任务里用。</span>
        </div>
        <div class="kv" id="cfg-kv"></div>
        <table><thead><tr><th>Provider</th><th>环境变量</th><th>状态</th></tr></thead><tbody id="keys"></tbody></table>
      </div>
    </div>
  </main>
  <aside class="right" id="right">
    <div class="tabs">
      <button id="tab-evidence" class="active" type="button">证据链</button>
      <button id="tab-status" type="button">运行状态</button>
    </div>
    <div id="pane-evidence">
      <div class="card plan"><h4>计划</h4><div id="plan"><div class="empty">这个会话还没有调用 plan。</div></div></div>
      <div class="card"><h4>证据</h4><div id="evidence"><div class="empty">联网抓取的页面原文会作为证据列在这里。</div></div></div>
    </div>
    <div id="pane-status" hidden>
      <div class="card"><h4>模型</h4><div class="kv" id="model-kv"></div></div>
      <div class="card"><h4>Token 用量</h4><div class="kv" id="usage-kv"></div><div class="hint" id="usage-hint">仅统计当前进程中 API 返回的真实用量。</div></div>
    </div>
  </aside>
</div>
<dialog id="memory-dialog">
  <h2>长期记忆</h2>
  <p class="hint">这里编辑的是磁盘上的完整 MEMORY.md，不是聊天记录。模型通常只读取最后 40 行；压缩会话不会修改此文件。内容可能敏感，请勿公开分享。</p>
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
    <button class="ibtn" id="memory-refresh" type="button">重新读取</button>
    <button class="ibtn" id="memory-save" type="button">保存修改</button>
    <button class="ibtn" id="memory-close" type="button">关闭</button>
  </div>
</dialog>
<script>
(function(){
"use strict";
var params=new URLSearchParams(location.search);
var TOKEN=params.get("token")||"";
document.getElementById("groupLink").href="/groups?token="+encodeURIComponent(TOKEN);
document.getElementById("group-open").href="/groups?token="+encodeURIComponent(TOKEN);
var state={sid:null,next:0,live:[],status:"idle",timer:null,info:null,pending:null,view:"chat"};
var $=function(id){return document.getElementById(id)};
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"X-Nyra-Token":TOKEN,"Content-Type":"application/json"},opts.headers||{});
  return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e}
function showView(name){state.view=name;
  document.querySelectorAll("#nav button").forEach(function(b){b.classList.toggle("active",b.dataset.view===name)});
  document.querySelectorAll(".view").forEach(function(v){v.classList.toggle("active",v.id==="view-"+name)});
  if(name==="skills")loadSkills();
  if(name==="schedule")loadSchedule();
  if(name==="group")loadGroups();
  $("shell").classList.remove("show-left")}
// Minimal, safe Markdown: escape first, then add a few constructs.
function md(src){
  var blocks=[];var s=String(src||"").replace(/```[^\n]*\n([\s\S]*?)```/g,function(_,code){blocks.push(code);return "\u0000"+(blocks.length-1)+"\u0000"});
  s=esc(s);
  s=s.replace(/`([^`\n]+)`/g,"<code>$1</code>")
     .replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>")
     .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
     .replace(/(^|[\s(（：:，,])(https?:\/\/[^\s<)），。]+)/g,'$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  var out=[],list=null;
  s.split("\n").forEach(function(line){
    var m;
    if((m=line.match(/^\s*[-*]\s+(.*)$/))){if(list!=="ul"){if(list)out.push("</"+list+">");out.push("<ul>");list="ul"}out.push("<li>"+m[1]+"</li>");return}
    if((m=line.match(/^\s*\d+[.)]\s+(.*)$/))){if(list!=="ol"){if(list)out.push("</"+list+">");out.push("<ol>");list="ol"}out.push("<li>"+m[1]+"</li>");return}
    if(list){out.push("</"+list+">");list=null}
    if((m=line.match(/^#{1,3}\s+(.*)$/))){out.push("<h3>"+m[1]+"</h3>");return}
    if((m=line.match(/^#{4,6}\s+(.*)$/))){out.push("<h4>"+m[1]+"</h4>");return}
    if(line.trim()==="")out.push("");else out.push("<p>"+line+"</p>");
  });
  if(list)out.push("</"+list+">");
  return out.join("\n").replace(/\u0000(\d+)\u0000/g,function(_,i){return "<pre><code>"+esc(blocks[+i])+"</code></pre>"});
}
function argsLine(a){if(a==null)return "";if(typeof a==="string"){try{a=JSON.parse(a)}catch(e){return a}}
  if(typeof a!=="object")return String(a);return Object.keys(a).map(function(k){var v=a[k];if(typeof v==="object")v=JSON.stringify(v);v=String(v);return k+"="+(v.length>60?v.slice(0,59)+"…":v)}).join("  ")}
function pretty(a){if(typeof a==="string"){try{a=JSON.parse(a)}catch(e){return a}}try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}
function fmtTime(iso){try{var d=new Date(iso);if(isNaN(d.getTime()))return iso;return d.toLocaleString()}catch(e){return iso}}
function failed(r){return /^(错误：|执行失败：)/.test(String(r||""))}
function addMsg(role,text){var m=el("div","msg "+role);
  if(role==="assistant")m.appendChild(el("div","who","N"));
  else m.appendChild(el("div","who","你"));
  var b=el("div","bubble"+(role==="assistant"?" md":""));
  if(role==="assistant")b.innerHTML=md(text);else b.textContent=text;m.appendChild(b);$("log").appendChild(m)}
function toolCard(id,name,args){var d=el("details","tool");d.dataset.id=id||"";
  d.innerHTML='<summary><span class="nm"></span><span class="ar"></span><span class="st wait">运行中</span></summary><div class="body"><div>参数</div><pre class="pa"></pre><div class="rl" hidden>结果</div><pre class="re" hidden></pre></div>';
  d.querySelector(".nm").textContent=name;d.querySelector(".ar").textContent=argsLine(args);d.querySelector(".pa").textContent=pretty(args);$("log").appendChild(d);return d}
function setResult(card,result){if(!card)return;var st=card.querySelector(".st");var bad=failed(result);st.className="st "+(bad?"err":"ok");st.textContent=bad?"失败":"完成";
  card.querySelector(".rl").hidden=false;var re=card.querySelector(".re");re.hidden=false;re.textContent=result;if(bad)card.open=true}
function findCard(id){var all=$("log").querySelectorAll(".tool");for(var i=all.length-1;i>=0;i--){if(all[i].dataset.id===id)return all[i]}return all[all.length-1]}
function approvalBox(card,ev){var box=el("div","approve");box.innerHTML='<p></p><button class="yes">批准</button><button class="no">拒绝</button>';box.querySelector("p").textContent="需要审批："+ev.summary;
  var host=card||$("log");host.appendChild(box);if(card)card.open=true;
  box.querySelector(".yes").onclick=function(){decide(ev.id,true,box)};box.querySelector(".no").onclick=function(){decide(ev.id,false,box)};box.dataset.aid=ev.id}
function decide(id,ok,box){box.querySelectorAll("button").forEach(function(b){b.disabled=true});
  api("/api/approvals/"+id,{method:"POST",body:JSON.stringify({approve:ok})}).catch(function(e){box.querySelector("p").textContent="审批失败："+e.message});}
function renderTranscript(messages){var log=$("log");log.innerHTML="";
  if(!messages.length&&!state.live.length){log.innerHTML='<div class="welcome"><h1>今天想让 Nyra 做什么？</h1><p>Nyra 会通过调用工具完成任务：读写文件、执行命令、联网查证。每一步都会出现在这里。</p></div>';return}
  messages.forEach(function(m){
    if(m.role==="user")addMsg("user",m.content||"");
    else if(m.role==="assistant"){if(m.content)addMsg("assistant",m.content);(m.tool_calls||[]).forEach(function(tc){var f=tc.function||{};toolCard(tc.id,f.name,f.arguments)})}
    else if(m.role==="tool"){setResult(findCard(m.tool_call_id),m.content||"")}
  });}
function applyEvent(ev){var d=ev.data||{};
  if(ev.type==="user")addMsg("user",d.content);
  else if(ev.type==="assistant"||ev.type==="final"){if(d.content)addMsg("assistant",d.content)}
  else if(ev.type==="tool_start")toolCard(d.id,d.name,d.arguments);
  else if(ev.type==="tool_result")setResult(findCard(d.id),d.result);
  else if(ev.type==="approval")approvalBox($("log").querySelector(".tool:last-of-type"),d);
  else if(ev.type==="model_switch"){var n=el("div","switch-line");var why=(d.error||"").slice(0,60);n.textContent="模型已切换："+d.from+" → "+d.to+(why?"（"+why+"）":"");$("log").appendChild(n);loadInfo().catch(function(){})}
  else if(ev.type==="approval_result"){var b=$("log").querySelector('.approve[data-aid="'+d.id+'"]');if(b){b.querySelector("p").textContent=d.approved?"已批准":(d.timeout?"审批超时，已拒绝":"已拒绝");b.querySelectorAll("button").forEach(function(x){x.remove()})}}
}
function scrollEnd(){var l=$("log");l.scrollTop=l.scrollHeight}
function renderUsage(u,count){var box=$("usage-kv"),hint=$("usage-hint");box.innerHTML="";
  if(!u){hint.textContent="本次进程尚无用量数据。";return}
  var show=function(n){return n==null?"未报告":Number(n).toLocaleString()};
  var rows=[["模型调用",u.calls+" 次（报告 "+u.reported_calls+" 次）"],["输入 Token",show(u.prompt_tokens)],["输出 Token",show(u.completion_tokens)],["Token 合计",show(u.total_tokens)],["最近输入",show(u.last_prompt_tokens)],["配置上下文",u.context_window_tokens==null?"未配置":show(u.context_window_tokens)],["参考剩余",u.context_remaining_tokens==null?"未知":show(u.context_remaining_tokens)]];
  rows.forEach(function(r){box.appendChild(el("span")).textContent=r[0];box.appendChild(el("span")).textContent=r[1]});
  hint.textContent=(u.missing_calls?u.missing_calls+" 次 API 响应未报告用量；累计值不完整。":"仅统计模型报告的 token。")+(u.context_remaining_tokens==null?" 无法确认上下文剩余。":" 余量按最近请求的输入 tokens 估算，不含输出和下一轮输入。")+" 自动压缩次数："+count+"（需要显式启用）。"}
function renderSide(v){renderUsage(v.usage,v.auto_compact_count||0);var p=$("plan");
  if(v.plan){p.innerHTML="";var t=el("div",null);t.innerHTML="<b></b> <span class='st "+(v.plan.state==="running"?"wait":"ok")+"'>"+(v.plan.state==="running"?"进行中":"已结束")+"</span>";t.querySelector("b").textContent=v.plan.title;p.appendChild(t);var ol=el("ol");v.plan.steps.forEach(function(s){var li=el("li");li.textContent=s;ol.appendChild(li)});p.appendChild(ol)}
  else p.innerHTML='<div class="empty">这个会话还没有调用 plan。</div>';
  var e=$("evidence");if(!v.evidence.length){e.innerHTML='<div class="empty">联网抓取的页面原文会作为证据列在这里。</div>';return}
  e.innerHTML="";v.evidence.forEach(function(x){var a=el("div","ev");var safe=/^https?:\/\//.test(x.source);a.innerHTML=(safe?'<a target="_blank" rel="noopener noreferrer"></a>':'<span></span>')+"<small></small>";var l=a.firstChild;l.textContent=x.query?("搜索："+x.query):x.source;if(safe)l.href=x.source;a.querySelector("small").textContent=[x.kind,x.time,x.file].filter(Boolean).join(" · ");e.appendChild(a)})}
function setBusy(b){$("send").disabled=b;$("send").textContent=b?"执行中…":"发送";var dot=$("prov").querySelector(".dot");if(b)dot.className="dot run";else dot.className="dot "+(state.info&&state.info.credentials?"on":"off")}
function loadSession(sid,keepLive){state.sid=sid;state.next=0;state.live=[];
  document.querySelectorAll(".sess").forEach(function(b){b.classList.toggle("active",b.dataset.id===sid)});
  return api("/api/sessions/"+encodeURIComponent(sid)).then(function(v){renderTranscript(v.messages);v.events.forEach(applyEvent);state.next=v.next;renderSide(v);
    if(v.status==="error"&&v.error)$("log").appendChild(el("div","err-line","")).textContent="错误："+v.error;
    state.status=v.status;setBusy(v.status==="running");if(v.status==="running")poll();scrollEnd()})}
function poll(){clearTimeout(state.timer);state.timer=setTimeout(function(){if(!state.sid)return;var sid=state.sid;
  api("/api/sessions/"+encodeURIComponent(sid)+"?since="+state.next).then(function(v){if(sid!==state.sid)return;
    v.events.forEach(applyEvent);if(v.events.length)scrollEnd();state.next=v.next;renderSide(v);
    if(v.status==="running")poll();else{loadSession(sid);loadSessions()}}).catch(function(){poll()})},600)}
function loadSessions(){return api("/api/sessions").then(function(r){var box=$("sessions");box.innerHTML="";
  if(!r.sessions.length){box.innerHTML='<div class="empty">还没有会话。</div>';return}
  r.sessions.forEach(function(s){var b=el("button","sess");b.dataset.id=s.id;b.innerHTML="<b></b><span></span>";b.querySelector("b").textContent=s.preview||"（空会话）";b.querySelector("span").textContent=s.id+" · "+s.count+" 条";
    if(s.id===state.sid)b.classList.add("active");b.onclick=function(){loadSession(s.id);$("shell").classList.remove("show-left")};box.appendChild(b)})})}
function newSession(){return api("/api/sessions",{method:"POST",body:"{}"}).then(function(r){state.sid=r.id;renderTranscript([]);renderSide({plan:null,evidence:[]});
  document.querySelectorAll(".sess").forEach(function(b){b.classList.remove("active")});$("input").focus()})}
function send(){var t=$("input").value.trim();if(!t||state.status==="running")return;var go=state.sid?Promise.resolve():newSession();
  go.then(function(){$("input").value="";autosize();if(!$("log").querySelector(".msg,.tool"))$("log").innerHTML="";
    return api("/api/sessions/"+encodeURIComponent(state.sid)+"/messages",{method:"POST",body:JSON.stringify({text:t})})})
  .then(function(r){if(r.status==="error"){$("log").appendChild(el("div","err-line")).textContent="错误："+r.error;return}state.status="running";setBusy(true);poll()})
  .catch(function(e){$("log").appendChild(el("div","err-line")).textContent="错误："+e.message})}
function autosize(){var i=$("input");i.style.height="auto";i.style.height=Math.min(i.scrollHeight,180)+"px"}
var memoryView={scope:null,revision:null,content:null,loading:false};
function memoryParams(){if(!memoryView.scope)return "";var s=memoryView.scope;return "?scope="+encodeURIComponent(s.scope)+(s.room?"&room="+encodeURIComponent(s.room):"")+(s.bot?"&bot="+encodeURIComponent(s.bot):"")}
function setMemoryStatus(msg){$("memory-status").textContent=msg}
function memoryDirty(){return memoryView.content!==null&&$("memory-content").value!==memoryView.content}
function readMemory(){if(!memoryView.scope)return Promise.resolve();memoryView.loading=true;$("memory-save").disabled=true;setMemoryStatus("正在读取…");
  return api("/api/memory"+memoryParams()).then(function(v){memoryView.revision=v.revision;memoryView.content=v.content;$("memory-content").value=v.content;
    setMemoryStatus((v.exists?"已载入":"暂无记忆文件")+" · "+v.bytes+" 字节 · 模型参考最后 "+v.summary_lines+" 行");
  }).catch(function(e){memoryView.revision=null;memoryView.content=null;setMemoryStatus("读取失败："+e.message)}).finally(function(){memoryView.loading=false;$("memory-save").disabled=false})}
function openMemory(){return api("/api/memory/scopes").then(function(data){var sel=$("memory-scope");sel.innerHTML="";
    var current=sel.value;data.scopes.forEach(function(s,i){var opt=document.createElement("option");opt.value=String(i);opt.textContent=s.label;sel.appendChild(opt)});
    if(!data.scopes.length)throw new Error("没有可用记忆范围");
    var ix=data.scopes.findIndex(function(s){return memoryView.scope&&s.scope===memoryView.scope.scope&&s.room===memoryView.scope.room&&s.bot===memoryView.scope.bot});
    sel.value=String(ix<0?0:ix);memoryView.scope=data.scopes[Number(sel.value)];memoryView.scopes=data.scopes;
    $("memory-dialog").showModal();return readMemory();
  }).catch(function(e){setMemoryStatus("加载失败："+e.message);$("memory-dialog").showModal()})}
function saveMemory(){if(memoryView.loading||memoryView.revision===null||!memoryView.scope)return;
  var text=$("memory-content").value;
  if(!text&&memoryView.content&& !window.confirm("确定清空该机器人全部长期记忆吗？"))return;
  $("memory-save").disabled=true;setMemoryStatus("正在保存…");
  return api("/api/memory",{method:"POST",body:JSON.stringify({
    scope:memoryView.scope.scope,room:memoryView.scope.room,bot:memoryView.scope.bot,
    revision:memoryView.revision,content:text,
  })}).then(function(v){memoryView.revision=v.revision;memoryView.content=v.content;setMemoryStatus("已保存 · "+v.bytes+" 字节。下次模型请求可使用更新后的记忆。")})
    .catch(function(e){setMemoryStatus("保存失败（本地编辑仍保留）："+e.message+"；请先复制本地修改，再重新读取合并。")})
    .finally(function(){$("memory-save").disabled=false})}
function loadInfo(){return api("/api/info").then(function(i){state.info=i;$("ver").textContent="v"+i.version;
  var p=$("prov");p.querySelector("span").textContent=i.provider?(i.provider+" / "+i.model):"provider 未配置";p.querySelector(".dot").className="dot "+(i.credentials?"on":"off");p.title=i.provider_desc||i.provider_error||"";
  var sel=$("mode");sel.innerHTML="";i.modes.forEach(function(m){var o=el("option");o.value=m;o.textContent=m;if(m===i.mode)o.selected=true;sel.appendChild(o)});
  var kv=$("model-kv");kv.innerHTML="";var rows=[["Provider",i.provider||"—"],["模型",i.model||"—"],["凭据",i.credentials?"已配置":"未配置"],["模式",i.mode],["工作目录",i.workdir]];
  if(i.model_switches&&i.model_switches.length)rows.push(["切换记录",i.model_switches.map(function(s){return s.from+" → "+s.to+"（"+s.error+"）"}).join("；")]);
  if(i.fallback_chain&&i.fallback_chain.length)rows.push(["兜底链",i.fallback_chain.join(" → ")]);
  rows.forEach(function(r){kv.appendChild(el("span")).textContent=r[0];kv.appendChild(el("span")).textContent=r[1]});
  var c=$("cfg-kv");c.innerHTML="";var cfg=i.config||{};[["版本",i.version],["当前 provider",i.provider_desc||i.provider_error||"—"],["最大轮数",cfg.max_turns],["配置上下文窗口",cfg.context_window_tokens||"未知"],["自动压缩",cfg.auto_compact_enabled?("已启用 · "+cfg.auto_compact_threshold*100+"%"):"未启用"],["MCP",cfg.mcp_enabled?("已启用（"+i.mcp_tools+" 个工具）"):"未启用"],["沙盒（配置）",cfg.sandbox+"（网页界面在本地执行）"],["档案",(cfg.profiles||[]).join(", ")||"—"]].forEach(function(r){c.appendChild(el("span")).textContent=r[0];c.appendChild(el("span")).textContent=r[1]==null?"—":String(r[1])});
  var k=$("keys");k.innerHTML="";i.keys.forEach(function(x){var tr=el("tr");var st=x.env?(x.configured?"✓ 已配置":(x.connector?"未设置（可用已保存连接器）":(x.needs_key?"未设置":"无需 Key"))):"无需 Key";
    [x.provider,x.env||"—",st].forEach(function(v){tr.appendChild(el("td")).textContent=v});k.appendChild(tr)});
  var ps=$("provider-select");ps.innerHTML="";(i.providers||[]).forEach(function(pr){var o=el("option");o.value=pr.name;o.textContent=pr.name+(pr.default_model?" · "+pr.default_model:" · 自定义");if(pr.name===i.provider)o.selected=true;ps.appendChild(o)});
  fillModelList();
  syncModeSeg(i.mode)})}
function syncModeSeg(mode){document.querySelectorAll("#mode-seg button").forEach(function(b){b.classList.toggle("active",b.dataset.mode===mode)})}
function fillModelList(){var ps=$("provider-select");if(!ps)return;var name=ps.value;var pr=null;(state.info.providers||[]).forEach(function(p){if(p.name===name)pr=p});
  var dl=$("model-list");dl.innerHTML="";(pr&&pr.models||[]).forEach(function(m){var o=document.createElement("option");o.value=m;dl.appendChild(o)});
  var mi=$("model-input");if(mi&&!mi.dataset.touched)mi.value=(name===state.info.provider)?(state.info.model||(pr?pr.default_model||"":"")):(pr?pr.default_model||"":"")}
function loadSkills(){if(!state.info)return Promise.resolve();var i=state.info;
  var sl=$("skills-list");sl.innerHTML="";
  if(!(i.skills||[]).length)sl.innerHTML='<div class="empty">没有可用技能。</div>';
  i.skills.forEach(function(s){var d=el("div","skillcard");d.innerHTML="<b></b><p></p>";d.querySelector("b").textContent=s.name;d.querySelector("p").textContent=s.description||"";sl.appendChild(d)});
  var g=$("tools-grid");g.innerHTML="";$("tool-count").textContent=String((i.tools||[]).length);
  i.tools.forEach(function(t){var d=el("div","toolcard");d.innerHTML="<b></b> <span class='st "+(t.needs_approval?"wait":"ok")+"'>"+(t.needs_approval?"需批准":"只读")+"</span><p></p>";d.querySelector("b").textContent=t.name;d.querySelector("p").textContent=t.description||"";g.appendChild(d)})}
function loadSchedule(){return api("/api/schedule").then(function(r){var box=$("sched-list");box.innerHTML="";
  if(!r.tasks.length){box.innerHTML='<div class="empty">还没有定时任务。用 <code>nyra schedule add</code> 命令添加。</div>';return}
  r.tasks.forEach(function(t){var row=el("div","sched-row");
    var grow=el("div","grow");var b=el("b");b.textContent=t.name;grow.appendChild(b);
    var parts=[t.at?("每天 "+t.at):(t.every_seconds?("每 "+Math.round(t.every_seconds/60)+" 分钟"):""),t.mode+"模式"];
    if(t.provider)parts.push(t.provider+(t.model?(" / "+t.model):""));
    if(t.last_status)parts.push("上次："+t.last_status);
    if(t.last_run)parts.push("上次运行："+fmtTime(t.last_run));
    if(t.last_summary)parts.push("摘要："+String(t.last_summary).slice(0,80));
    var s=el("span");s.textContent=parts.filter(Boolean).join(" · ");grow.appendChild(s);
    var p=el("div");p.textContent=t.prompt;p.style.cssText="font-size:12.5px;color:var(--muted);overflow-wrap:anywhere";grow.appendChild(p);
    row.appendChild(grow);
    var lab=el("label","switch");lab.innerHTML='<input type="checkbox"><span class="tr"></span>';
    var cb=lab.querySelector("input");cb.checked=!!t.enabled;cb.setAttribute("aria-label","启用 "+t.name);
    cb.onchange=function(){api("/api/schedule",{method:"POST",body:JSON.stringify({action:"toggle",name:t.name})}).then(loadSchedule).catch(function(e){$("sched-status").textContent="切换失败："+e.message;cb.checked=!cb.checked})};
    row.appendChild(lab);
    var del=el("button","btn-danger");del.textContent="删除";del.onclick=function(){if(!window.confirm("确定删除定时任务「"+t.name+"」吗？"))return;api("/api/schedule",{method:"POST",body:JSON.stringify({action:"remove",name:t.name})}).then(loadSchedule).catch(function(e){$("sched-status").textContent="删除失败："+e.message})};
    row.appendChild(del);box.appendChild(row)})}).catch(function(e){$("sched-list").innerHTML='<div class="empty">定时任务读取失败：'+esc(e.message)+'</div>'})}
function loadGroups(){return api("/api/groups").then(function(r){var box=$("group-list");box.innerHTML="";
  if(!r.groups.length){box.innerHTML='<div class="empty">还没有机器人群。在群聊页面新建一个群。</div>';return}
  r.groups.forEach(function(g){var row=el("div","sched-row");var grow=el("div","grow");
    var b=el("b");b.textContent=g.name;grow.appendChild(b);
    var s=el("span");s.textContent=g.bots+" 位机器人";grow.appendChild(s);row.appendChild(grow);
    var open=el("a","btn-primary");open.textContent="打开";open.href="/groups?token="+encodeURIComponent(TOKEN)+"&room="+encodeURIComponent(g.id);open.style.textDecoration="none";row.appendChild(open);box.appendChild(row)})}).catch(function(e){$("group-list").innerHTML='<div class="empty">群列表读取失败：'+esc(e.message)+'</div>'})}
function renderSwatches(){var data=[["背景","#F3F5F4","鼠尾草雾白"],["表面","#FFFFFF","卡片底"],["面板","#E9EDEA","侧栏底"],["文字","#2A2D34","柔炭黑"],["次要文字","#6E7278","说明文字"],["边框","#DEE3DE","分隔线"],["主色","#5F7D5C","鼠尾草绿"],["强调","#6B8CAE","雾蓝"],["暖色点缀","#E07856","蜜桃珊瑚，小面积"],["成功","#4C9A6C","完成态"],["危险","#C24B42","失败/拒绝"]];
  var box=$("swatches");box.innerHTML="";
  data.forEach(function(d){var s=el("div","swatch");var c=el("div","chip");c.style.background=d[1];s.appendChild(c);
    var t=el("div");t.innerHTML="<b></b><span></span><br><span></span>";t.querySelector("b").textContent=d[0];var sp=t.querySelectorAll("span");sp[0].textContent=d[1];sp[1].textContent=d[2];s.appendChild(t);box.appendChild(s)})}
$("form").addEventListener("submit",function(e){e.preventDefault();send()});
$("input").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
$("input").addEventListener("input",autosize);
$("chips").addEventListener("click",function(e){var b=e.target.closest(".chip");if(!b)return;$("input").value=b.dataset.prompt;autosize();$("input").focus()});
$("new-session").onclick=function(){newSession();$("shell").classList.remove("show-left")};
$("mode").onchange=function(){api("/api/mode",{method:"POST",body:JSON.stringify({mode:this.value})}).then(loadInfo).catch(function(){loadInfo()})};
$("mode-seg").addEventListener("click",function(e){var b=e.target.closest("button[data-mode]");if(!b)return;api("/api/mode",{method:"POST",body:JSON.stringify({mode:b.dataset.mode})}).then(loadInfo).catch(function(){loadInfo()})});
$("model-input").addEventListener("input",function(){this.dataset.touched="1"});
$("provider-select").addEventListener("change",function(){var mi=$("model-input");if(mi)mi.dataset.touched="";fillModelList()});
$("apply-provider").onclick=function(){var ps=$("provider-select");var mi=$("model-input");var st=$("provider-status");
  st.textContent="切换中…";
  api("/api/provider",{method:"POST",body:JSON.stringify({provider:ps.value,model:(mi.value||"").trim()||null})}).then(function(r){if(mi)mi.dataset.touched="";st.textContent="已切换到 "+r.provider+" / "+r.model+"，新会话生效。";loadInfo()}).catch(function(e){st.textContent="切换失败："+e.message})};
$("open-settings").onclick=function(){showView("settings")};
$("open-memory").onclick=openMemory;
$("memory-refresh").onclick=function(){if(memoryDirty()&&!window.confirm("有未保存的编辑，确定丢弃并重新读取吗？"))return;readMemory()};
$("memory-save").onclick=saveMemory;
$("memory-close").onclick=function(){if(memoryDirty()&&!window.confirm("有未保存的编辑，确定关闭吗？"))return;$("memory-dialog").close()};
$("memory-scope").onchange=function(){
  if(memoryDirty()&&!window.confirm("切换机器人会丢弃未保存的编辑，是否继续？")){var ix=memoryView.scopes.findIndex(function(s){return s===memoryView.scope});this.value=String(ix);return}
  memoryView.scope=memoryView.scopes[Number(this.value)];readMemory()
};
$("memory-dialog").addEventListener("cancel",function(e){if(memoryDirty()&&!window.confirm("有未保存的编辑，确定关闭吗？"))e.preventDefault()});
$("toggle-right").onclick=function(){$("shell").classList.toggle("show-right")};$("toggle-left").onclick=function(){$("shell").classList.toggle("show-left")};
$("nav").addEventListener("click",function(e){var b=e.target.closest("button[data-view]");if(!b)return;showView(b.dataset.view)});
$("tab-evidence").onclick=function(){$("tab-evidence").classList.add("active");$("tab-status").classList.remove("active");$("pane-evidence").hidden=false;$("pane-status").hidden=true};
$("tab-status").onclick=function(){$("tab-status").classList.add("active");$("tab-evidence").classList.remove("active");$("pane-status").hidden=false;$("pane-evidence").hidden=true};
renderSwatches();
loadInfo().then(loadSessions).then(function(){renderTranscript([])}).catch(function(e){$("log").innerHTML="";$("log").appendChild(el("div","err-line")).textContent="无法连接 Nyra：" + e.message});
})();
</script>
</body>
</html>
"""

