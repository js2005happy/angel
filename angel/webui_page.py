"""The single self-contained page served by `python3 -m angel ui`.

Inline HTML/CSS/JS only: no CDN, fonts, images or other external resources.
Brand palette from DESIGN.md: Ink #111A42, Gold #EAC45F, Paper #FAF8F4.
"""

PAGE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Angel</title>
<style>
:root{--ink:#111A42;--gold:#EAC45F;--gold2:#B8902C;--paper:#FAF8F4;--bg:#FAF8F4;--panel:#F3EFE6;--surface:#fff;--text:#111A42;--muted:#5A6170;--line:#E4DED1;--accent:#B8902C;--ok:#2E8B57;--bad:#C2413A;--code:#0D1433;--codet:#E8E6F0;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0B1030;--panel:#0F163C;--surface:#141C47;--text:#EDEBF5;--muted:#A3A9C2;--line:#26305E;--accent:#EAC45F;--code:#070B22}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 var(--sans);display:grid;grid-template-rows:52px 1fr;overflow:hidden}
button,select,textarea{font:inherit;color:inherit}
code,pre{font-family:var(--mono)}
.top{display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px}
.brand small{font:500 11px var(--mono);color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted);background:var(--bg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.dot.on{background:var(--ok)}.dot.off{background:var(--bad)}.dot.run{background:var(--gold);box-shadow:0 0 0 3px rgba(234,196,95,.35)}
.spacer{flex:1}
.ibtn{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:13px}
.ibtn:hover{border-color:var(--accent)}
select.ibtn{padding:4px 8px}
.shell{display:grid;grid-template-columns:260px 1fr 300px;min-height:0}
aside{background:var(--panel);min-height:0;overflow:auto}
.left{border-right:1px solid var(--line);padding:12px}
.right{border-left:1px solid var(--line);padding:14px}
.new{width:100%;padding:9px;border-radius:10px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);font-weight:600;cursor:pointer;margin-bottom:12px}
@media (prefers-color-scheme:dark){.new{background:var(--gold);color:var(--ink);border-color:var(--gold)}}
.label{font:700 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:14px 2px 8px}
.sess{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:10px;padding:8px 10px;cursor:pointer;margin-bottom:2px}
.sess:hover{background:var(--surface)}.sess.active{background:var(--surface);border-color:var(--line);box-shadow:inset 3px 0 0 var(--gold)}
.sess b{display:block;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess span{font:11px var(--mono);color:var(--muted)}
.empty{color:var(--muted);font-size:13px;padding:6px 4px}
main{display:grid;grid-template-rows:1fr auto;min-height:0;min-width:0}
.log{overflow:auto;padding:22px clamp(14px,4vw,48px) 12px}
.welcome{max-width:560px;margin:10vh auto;text-align:center;color:var(--muted)}
.welcome h1{color:var(--text);font-size:22px;margin:12px 0 6px}
.msg{max-width:760px;margin:0 auto 14px;display:flex;gap:10px}
.msg .who{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;font:700 12px var(--mono);margin-top:2px}
.msg.user .who{background:var(--line);color:var(--text)}
.msg.assistant .who{background:var(--ink);color:var(--gold)}
@media (prefers-color-scheme:dark){.msg.assistant .who{background:var(--gold);color:var(--ink)}}
.bubble{min-width:0;flex:1}
.msg.user .bubble{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.md p{margin:0 0 8px}.md p:last-child{margin:0}
.md pre{background:var(--code);color:var(--codet);padding:10px 12px;border-radius:10px;overflow:auto;font-size:12.5px}
.md code{background:rgba(234,196,95,.18);padding:1px 5px;border-radius:5px;font-size:12.5px}
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
.st.ok{color:var(--ok);background:rgba(46,139,87,.12)}.st.err{color:var(--bad);background:rgba(194,65,58,.12)}.st.wait{color:var(--accent);background:rgba(234,196,95,.18)}
.tool .body{border-top:1px solid var(--line);padding:8px 12px;font-size:12px}
.tool pre{margin:4px 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;background:var(--panel);padding:8px;border-radius:8px}
.approve{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-top:1px solid var(--line);background:rgba(234,196,95,.12)}
.approve p{margin:0;flex:1;min-width:200px;font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);max-height:360px;overflow:auto}
.yes,.no{border-radius:8px;padding:6px 14px;font-weight:600;cursor:pointer;border:1px solid}
.yes{background:var(--ok);border-color:var(--ok);color:#fff}.no{background:var(--surface);border-color:var(--bad);color:var(--bad)}
.err-line{max-width:760px;margin:0 auto 12px;color:var(--bad);font-size:13px;padding-left:36px}
.recovery{max-width:760px;margin:0 auto 14px;border:1px solid var(--accent);border-radius:12px;background:rgba(234,196,95,.12);padding:12px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.recovery p{margin:0;flex:1;min-width:220px;font-size:13px}
.composer{border-top:1px solid var(--line);padding:12px clamp(14px,4vw,48px) 14px;background:var(--bg)}
.box{max-width:760px;margin:0 auto;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);background:var(--surface);border-radius:14px;padding:8px}
.box:focus-within{border-color:var(--accent)}
textarea{flex:1;border:0;outline:0;resize:none;background:transparent;min-height:24px;max-height:180px;padding:4px 6px}
.send{border:0;background:var(--ink);color:var(--paper);border-radius:10px;padding:7px 16px;font-weight:600;cursor:pointer}
@media (prefers-color-scheme:dark){.send{background:var(--gold);color:var(--ink)}}
.send:disabled{opacity:.45;cursor:default}
.hint{max-width:760px;margin:6px auto 0;font-size:11.5px;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}
.card h4{margin:0 0 8px;font-size:12px;font-family:var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12.5px}
.kv span:nth-child(odd){color:var(--muted)}.kv span:nth-child(even){overflow-wrap:anywhere}
.plan ol{margin:0;padding-left:20px;font-size:13px}.plan li{margin:3px 0}
.ev{display:block;font-size:12.5px;padding:6px 0;border-bottom:1px dashed var(--line);overflow-wrap:anywhere}
.ev:last-child{border:0}.ev a{color:var(--accent)}.ev small{display:block;color:var(--muted);font:11px var(--mono)}
dialog{border:1px solid var(--line);border-radius:16px;background:var(--surface);color:var(--text);max-width:560px;width:calc(100% - 32px);padding:20px}
dialog::backdrop{background:rgba(11,16,48,.45)}
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
@media (max-width:1100px){.shell{grid-template-columns:230px 1fr}.right{display:none}.shell.show-right .right{display:block;position:fixed;right:0;top:52px;bottom:0;width:300px;z-index:5;box-shadow:-10px 0 30px rgba(0,0,0,.15)}}
@media (max-width:720px){.shell{grid-template-columns:1fr}.left{display:none}.shell.show-left .left{display:block;position:fixed;left:0;top:52px;bottom:0;width:260px;z-index:5;box-shadow:10px 0 30px rgba(0,0,0,.15)}.menu{display:inline-block}.pill.prov{display:none}}
</style>
</head>
<body>
<header class="top">
  <button class="ibtn menu" id="toggle-left" aria-label="会话列表">☰</button>
  <div class="brand"><svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#111A42"/><ellipse cx="32" cy="15" rx="13" ry="4.2" fill="none" stroke="#EAC45F" stroke-width="3"/><path d="M32 24 L44 52 H38.6 L35.9 45.4 H28.1 L25.4 52 H20 Z M29.8 41 H34.2 L32 35.4 Z" fill="#FAF8F4"/></svg>Angel <small id="ver"></small></div>
  <span class="pill prov" id="prov"><i class="dot"></i><span>…</span></span>
  <span class="spacer"></span>
  <a class="ibtn" id="groupLink" href="/groups" style="text-decoration:none">机器人群聊</a>
  <button class="ibtn" id="open-memory" aria-label="查看和管理长期记忆">长期记忆</button>
  <label class="pill" title="审批模式">模式
    <select class="ibtn" id="mode" aria-label="审批模式"></select></label>
  <button class="ibtn" id="toggle-right" aria-label="检查器">检查器</button>
  <button class="ibtn" id="open-settings" aria-label="设置">⚙ 设置</button>
</header>
<div class="shell" id="shell">
  <aside class="left">
    <button class="new" id="new-session">＋ 新会话</button>
    <div class="label">会话</div>
    <div id="sessions"><div class="empty">加载中…</div></div>
  </aside>
  <main>
    <div class="log" id="log" aria-live="polite"></div>
    <div class="composer">
      <form class="box" id="form">
        <textarea id="input" rows="1" placeholder="给 Angel 一个任务…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="send" id="send" type="submit">发送</button>
      </form>
      <div class="hint" id="hint">auto 模式下，写文件、执行命令前会在对话里出现审批卡片。</div>
    </div>
  </main>
  <aside class="right" id="right">
    <div class="card"><h4>模型</h4><div class="kv" id="model-kv"></div></div>
    <div class="card"><h4>Token 用量</h4><div class="kv" id="usage-kv"></div><div class="hint" id="usage-hint">仅统计当前进程中 API 返回的真实用量。</div></div>
    <div class="card plan"><h4>计划</h4><div id="plan"><div class="empty">这个会话还没有调用 plan。</div></div></div>
    <div class="card"><h4>证据</h4><div id="evidence"><div class="empty">联网抓取的页面原文会作为证据列在这里。</div></div></div>
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
<dialog id="settings">
  <h2>设置</h2>
  <p style="color:var(--muted);margin:0 0 10px;font-size:13px">只读视图：来自 <code>~/.angel/config.json</code> 与环境变量。Key 只显示是否已配置，从不显示其值。</p>
  <div class="kv" id="cfg-kv"></div>
  <table><thead><tr><th>Provider</th><th>环境变量</th><th>状态</th></tr></thead><tbody id="keys"></tbody></table>
  <p style="text-align:right;margin:14px 0 0"><button class="ibtn" id="close-settings">关闭</button></p>
</dialog>
<script>
(function(){
"use strict";
var params=new URLSearchParams(location.search);
var TOKEN=params.get("token")||"";
document.getElementById("groupLink").href="/groups?token="+encodeURIComponent(TOKEN);
var state={sid:null,next:0,live:[],status:"idle",timer:null,info:null,pending:null};
var $=function(id){return document.getElementById(id)};
function api(path,opts){opts=opts||{};opts.headers=Object.assign({"X-Angel-Token":TOKEN,"Content-Type":"application/json"},opts.headers||{});
  return fetch(path,opts).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j})})}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e}
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
function failed(r){return /^(错误：|执行失败：)/.test(String(r||""))}
function addMsg(role,text){var m=el("div","msg "+role);m.appendChild(el("div","who",role==="user"?"你":"A"));var b=el("div","bubble"+(role==="assistant"?" md":""));
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
  if(!messages.length&&!state.live.length){log.innerHTML='<div class="welcome"><svg width="44" height="44" viewBox="0 0 64 64"><ellipse cx="32" cy="20" rx="20" ry="6.5" fill="none" stroke="#EAC45F" stroke-width="4"/></svg><h1>今天想让 Angel 做什么？</h1><p>Angel 会通过调用工具完成任务：读写文件、执行命令、联网查证。每一步都会出现在这里。</p></div>';return}
  messages.forEach(function(m){
    if(m.role==="user")addMsg("user",m.content||"");
    else if(m.role==="assistant"){if(m.content)addMsg("assistant",m.content);(m.tool_calls||[]).forEach(function(tc){var f=tc.function||{};toolCard(tc.id,f.name,f.arguments)})}
    else if(m.role==="tool"){setResult(findCard(m.tool_call_id),m.content||"")}
  });}
function markUncertainTools(){document.querySelectorAll(".tool").forEach(function(card){var st=card.querySelector(".st");if(!st||!st.classList.contains("wait"))return;
  st.className="st err";st.textContent="中断 · 结果未知";card.querySelector(".rl").hidden=false;var re=card.querySelector(".re");re.hidden=false;
  re.textContent="任务中断前没有保存该工具的结果，无法确认操作是否完成。恢复时先检查当前状态和证据。"})}
function renderRecovery(v){var old=$("log").querySelector(".recovery");if(old)old.remove();if(!v.resume_available)return;
  var box=el("div","recovery"),p=el("p"),button=el("button","ibtn");p.textContent="上次任务没有正常结束。Angel 已保存最近的会话和工具结果；不确定的调用不会自动重放。继续前先检查当前状态。";
  button.type="button";button.textContent="检查状态并继续";button.onclick=function(){button.disabled=true;
    api("/api/sessions/"+encodeURIComponent(state.sid)+"/resume",{method:"POST",body:"{}"}).then(function(r){
      if(r.status!=="running")throw new Error(r.error||"未能恢复任务");state.status="running";state.next=0;setBusy(true);box.remove();poll();
    }).catch(function(e){button.disabled=false;p.textContent="恢复失败："+e.message})};
  box.appendChild(p);box.appendChild(button);$("log").prepend(box)}
function applyEvent(ev){var d=ev.data||{};
  if(ev.type==="user")addMsg("user",d.content);
  else if(ev.type==="assistant"||ev.type==="final"){if(d.content)addMsg("assistant",d.content)}
  else if(ev.type==="trace_start")addMsg("assistant","执行追踪："+String(d.trace_id||"").slice(0,12));
  else if(ev.type==="trace_span"){
    var ms=Number(d.duration_ms);var elapsed=Number.isFinite(ms)?(ms<1000?Math.round(ms)+" ms":(ms/1000).toFixed(2)+" s"):"时长未知";var line="";
    if(d.kind==="model"){
      var u=d.usage||{};var toks=u.total_tokens==null?"token 未报告":(Number(u.total_tokens).toLocaleString()+" tokens");
      line="模型 "+(d.provider||"?")+" / "+(d.model||"?")+" · "+elapsed+" · "+toks;
      if(d.attempts&&d.attempts.length>1)line+=" · 兜底尝试 "+d.attempts.length+" 次";
    }else if(d.kind==="tool")line="工具 "+(d.name||"?")+" · "+elapsed+" · "+(d.status||"unknown");
    else line="任务追踪结束 · "+(d.status||"unknown")+" · "+elapsed;
    addMsg("assistant",line);
  }
  else if(ev.type==="provider_fallback"){
    var failures=(d.failed||[]).map(function(x){return x.provider+"："+x.reason}).join("、");
    addMsg("assistant","模型自动兜底："+d.from_provider+" / "+d.from_model+" → "+d.to_provider+" / "+d.to_model+(failures?"（"+failures+"）":""));
    loadInfo();
  }
  else if(ev.type==="tool_start")toolCard(d.id,d.name,d.arguments);
  else if(ev.type==="tool_result")setResult(findCard(d.id),d.result);
  else if(ev.type==="approval")approvalBox($("log").querySelector(".tool:last-of-type"),d);
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
  if(v.plan){p.innerHTML="";var t=el("div",null);var interrupted=v.plan.state==="interrupted";t.innerHTML="<b></b> <span class='st "+(v.plan.state==="running"?"wait":interrupted?"err":"ok")+"'>"+(v.plan.state==="running"?"进行中":interrupted?"已中断":"已结束")+"</span>";t.querySelector("b").textContent=v.plan.title;p.appendChild(t);var ol=el("ol");v.plan.steps.forEach(function(s){var li=el("li");li.textContent=s;ol.appendChild(li)});p.appendChild(ol)}
  else p.innerHTML='<div class="empty">这个会话还没有调用 plan。</div>';
  var e=$("evidence");if(!v.evidence.length){e.innerHTML='<div class="empty">联网抓取的页面原文会作为证据列在这里。</div>';return}
  e.innerHTML="";v.evidence.forEach(function(x){var a=el("div","ev");var safe=/^https?:\/\//.test(x.source);a.innerHTML=(safe?'<a target="_blank" rel="noopener noreferrer"></a>':'<span></span>')+"<small></small>";var l=a.firstChild;l.textContent=x.query?("搜索："+x.query):x.source;if(safe)l.href=x.source;a.querySelector("small").textContent=[x.kind,x.time,x.file].filter(Boolean).join(" · ");e.appendChild(a)})}
function setBusy(b){$("send").disabled=b;$("send").textContent=b?"执行中…":"发送";var dot=$("prov").querySelector(".dot");if(b)dot.className="dot run";else dot.className="dot "+(state.info&&state.info.credentials?"on":"off")}
function loadSession(sid,keepLive){state.sid=sid;state.next=0;state.live=[];
  document.querySelectorAll(".sess").forEach(function(b){b.classList.toggle("active",b.dataset.id===sid)});
  return api("/api/sessions/"+encodeURIComponent(sid)).then(function(v){renderTranscript(v.messages);if(v.resume_available)markUncertainTools();renderRecovery(v);v.events.forEach(applyEvent);state.next=v.next;renderSide(v);
    if(v.status==="error"&&v.error)$("log").appendChild(el("div","err-line","")).textContent="错误："+v.error;
    state.status=v.status;setBusy(v.status==="running");if(v.status==="running")poll();scrollEnd()})}
function poll(){clearTimeout(state.timer);state.timer=setTimeout(function(){if(!state.sid)return;var sid=state.sid;
  api("/api/sessions/"+encodeURIComponent(sid)+"?since="+state.next).then(function(v){if(sid!==state.sid)return;
    v.events.forEach(applyEvent);if(v.resume_available)markUncertainTools();renderRecovery(v);if(v.events.length)scrollEnd();state.next=v.next;renderSide(v);
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
  var kv=$("model-kv");kv.innerHTML="";[["Provider",i.provider||"—"],["模型",i.model||"—"],["凭据",i.credentials?"已配置":"未配置"],["模式",i.mode],["工作目录",i.workdir]].forEach(function(r){kv.appendChild(el("span")).textContent=r[0];kv.appendChild(el("span")).textContent=r[1]});
  var c=$("cfg-kv");c.innerHTML="";var cfg=i.config||{};[["版本",i.version],["当前 provider",i.provider_desc||i.provider_error||"—"],["最大轮数",cfg.max_turns],["配置上下文窗口",cfg.context_window_tokens||"未知"],["自动压缩",cfg.auto_compact_enabled?("已启用 · "+cfg.auto_compact_threshold*100+"%"):"未启用"],["MCP",cfg.mcp_enabled?("已启用（"+i.mcp_tools+" 个工具）"):"未启用"],["沙盒（配置）",cfg.sandbox+"（网页界面在本地执行）"],["档案",(cfg.profiles||[]).join(", ")||"—"]].forEach(function(r){c.appendChild(el("span")).textContent=r[0];c.appendChild(el("span")).textContent=r[1]==null?"—":String(r[1])});
  var k=$("keys");k.innerHTML="";i.keys.forEach(function(x){var tr=el("tr");var st=x.env?(x.configured?"✓ 已配置":(x.connector?"未设置（可用已保存连接器）":(x.needs_key?"未设置":"无需 Key"))):"无需 Key";
    [x.provider,x.env||"—",st].forEach(function(v){tr.appendChild(el("td")).textContent=v});k.appendChild(tr)})})}
$("form").addEventListener("submit",function(e){e.preventDefault();send()});
$("input").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
$("input").addEventListener("input",autosize);
$("new-session").onclick=function(){newSession();$("shell").classList.remove("show-left")};
$("mode").onchange=function(){api("/api/mode",{method:"POST",body:JSON.stringify({mode:this.value})}).then(loadInfo)};
$("open-settings").onclick=function(){$("settings").showModal()};$("close-settings").onclick=function(){$("settings").close()};
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
loadInfo().then(loadSessions).then(function(){renderTranscript([])}).catch(function(e){$("log").innerHTML="";$("log").appendChild(el("div","err-line")).textContent="无法连接 Angel：" + e.message});
})();
</script>
</body>
</html>
"""
