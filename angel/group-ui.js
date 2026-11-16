/* Angel group chat UI: standard browser JavaScript, no framework or CDN.
 * Bot prompts and user messages are rendered with textContent, never as HTML.
 */
(() => {
  "use strict";
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const maxBots = 8;
  const templates = [
    {id:"lead",name:"组长",role:"任务拆解与团队协调",instructions:"先确认目标与可交付成果，分配关注点。允许其他成员反对你的方案。"},
    {id:"architect",name:"架构师",role:"独立技术方案",instructions:"关注整体架构、长期维护和权衡。可以明确不同意组长，不要盲从。"},
    {id:"builder",name:"开发者",role:"具体实现与验证",instructions:"关注真实可运行代码、测试和最小增量。区分建议与已执行结果。"},
    {id:"reviewer",name:"审查员",role:"质疑和评估风险",instructions:"指出潜在缺陷、安全和测试问题；不要为了达成一致而附和。"},
    {id:"researcher",name:"研究员",role:"资料检索与事实核验",instructions:"区分事实、推断和未知；提供可核验的依据，不要编造来源。"},
    {id:"security",name:"安全员",role:"威胁分析与隐私检查",instructions:"检查信任边界、权限、注入风险和隐私泄露，并给出具体缓解措施。"},
    {id:"product",name:"产品经理",role:"用户需求与验收标准",instructions:"从目标用户和实际流程出发，澄清成功标准、边界条件与取舍。"},
    {id:"performance",name:"性能工程师",role:"性能与资源效率",instructions:"关注延迟、吞吐、内存和费用；优先依据测量提出优化建议。"}
  ];
  const el = id => document.getElementById(id);
  const rooms = el("rooms"), messages = el("messages"), members = el("members");
  const composer = el("composer"), status = el("status");
  let activeId = null, activeRoom = null, activeRunId = null, busy = false;

  el("backLink").href = "/?token=" + encodeURIComponent(token);
  function say(message) { status.textContent = message; }
  function node(tag, value, cls) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (cls) element.className = cls;
    return element;
  }
  async function api(path, body) {
    const init = {headers:{"X-Angel-Token":token}};
    if (body !== undefined) {
      init.method = "POST";
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(path, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "请求失败（HTTP " + response.status + "）");
    return data;
  }
  function showMessages(room) {
    messages.replaceChildren();
    const labels = Object.fromEntries(room.bots.map(b => [b.id, b.name]));
    for (const entry of room.messages) {
      const box = node("article", undefined, "message" +
        (entry.sender === "user" ? " user" : "") + (entry.error ? " error" : "") +
        (entry.cancelled ? " cancelled" : ""));
      const who = entry.sender === "user" ? "你" : (labels[entry.sender] || entry.sender);
      box.append(node("div", who + " · " + (entry.time || ""), "speaker"));
      box.append(node("div", entry.content, "content"));
      messages.append(box);
    }
    messages.scrollTop = messages.scrollHeight;
  }
  function showMembers(room) {
    members.replaceChildren();
    for (const bot of room.bots) {
      const div = node("div", undefined, "member");
      div.append(node("b", bot.name + "  @" + bot.id));
      div.append(node("p", bot.role));
      div.append(node("p", bot.provider || "默认 provider", "muted"));
      div.append(node("p", bot.model || "默认模型", "muted"));
      div.append(node("p", "独立记忆 · " + bot.mode, "muted"));
      members.append(div);
    }
  }
  async function openRoom(id) {
    activeId = id;
    activeRoom = await api("/api/groups/" + encodeURIComponent(id));
    el("roomTitle").textContent = activeRoom.name + " · " + activeRoom.bots.length + " 位机器人";
    composer.style.display = "flex";
    showMessages(activeRoom);
    showMembers(activeRoom);
    document.querySelectorAll(".room").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.room === id);
    });
  }
  async function loadRooms() {
    const data = await api("/api/groups");
    rooms.replaceChildren();
    for (const room of data.groups) {
      const btn = node("button", room.name + " · " + room.bots, "room");
      btn.dataset.room = room.id;
      btn.addEventListener("click", () => openRoom(room.id).catch(e => say(e.message)));
      rooms.append(btn);
    }
    if (activeId && data.groups.some(room => room.id === activeId)) await openRoom(activeId);
    else if (data.groups.length) await openRoom(data.groups[0].id);
  }
  function addField(parent, tag, label, value, maxlen) {
    const wrapper = node("label", undefined, "field");
    wrapper.append(node("span", label, "muted"));
    const field = document.createElement(tag);
    field.value = value || "";
    if (maxlen) field.maxLength = maxlen;
    wrapper.append(field);
    parent.append(wrapper);
    return field;
  }
  const botFields = el("botFields");
  function refreshBotControls() {
    const count = botFields.children.length;
    el("botCount").textContent = "当前 " + count + " / " + maxBots + " 位机器人";
    el("addBot").disabled = count >= maxBots;
    for (const panel of botFields.children) {
      panel.querySelector(".remove-bot").disabled = count <= 2;
    }
  }
  function addBotPanel(bot) {
    if (botFields.children.length >= maxBots) return;
    if (!bot) bot = templates.find(item =>
      ![...botFields.children].some(panel => panel.dataset.id === item.id));
    if (!bot) return;
    const panel = node("div", undefined, "botfield");
    const heading = node("div", undefined, "botfield-head");
    heading.append(node("strong", "@" + bot.id + " · " + bot.name));
    const remove = node("button", "移除", "remove-bot");
    remove.type = "button";
    remove.addEventListener("click", () => {
      panel.remove();
      refreshBotControls();
    });
    heading.append(remove);
    panel.append(heading);
    const role = addField(panel, "input", "职责", bot.role, 200);
    const instructions = addField(panel, "textarea", "独立个性与指令", bot.instructions, 2000);
    const provider = addField(panel, "select", "提供商", "");
    for (const choice of ["", "deepseek", "xai", "openrouter", "ollama", "openai", "custom"]) {
      const opt = node("option", choice || "使用默认模型");
      opt.value = choice;
      provider.append(opt);
    }
    const model = addField(panel, "input", "模型 ID（可选）", "", 180);
    panel.dataset.id = bot.id;
    panel.botInputs = {role, instructions, provider, model, bot};
    botFields.append(panel);
    refreshBotControls();
  }
  for (const bot of templates.slice(0, 4)) addBotPanel(bot);
  el("addBot").addEventListener("click", () => addBotPanel());
  el("newRoom").onclick = () => {
    botFields.replaceChildren();
    for (const bot of templates.slice(0, 4)) addBotPanel(bot);
    el("newDialog").showModal();
  };
  el("cancelCreate").onclick = () => el("newDialog").close();
  el("createForm").addEventListener("submit", async event => {
    event.preventDefault();
    const roomId = el("newId").value.trim();
    const bots = [...botFields.children].map(panel => {
      const p = panel.botInputs, b = p.bot;
      return {
        id:b.id, name:b.name, role:p.role.value,
        instructions:p.instructions.value,
        provider:p.provider.value || null, model:p.model.value.trim() || null,
        mode:"readonly"
      };
    });
    try {
      el("createForm").querySelector('button[type="submit"]').disabled = true;
      await api("/api/groups", {id:roomId, name:el("newName").value.trim(), bots});
      activeId = roomId;
      el("newDialog").close();
      await loadRooms();
      say("已创建独立机器人群。发送消息时会产生模型 API 请求。");
    } catch (error) { say(error.message); }
    finally { el("createForm").querySelector('button[type="submit"]').disabled = false; }
  });
  composer.addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeId || busy) return;
    const input = el("messageInput");
    const value = input.value.trim();
    if (!value) return;
    const parallel = el("parallelResponses").checked;
    const roomId = activeId;
    activeRunId = roomId;
    busy = true;
    el("sendBtn").disabled = true;
    el("cancelBtn").hidden = false;
    say(parallel
      ? "并行讨论中：最多 4 个机器人同时请求模型；同一轮互不读取对方的未完成回复……"
      : "机器人正在依次思考和回复。每位机器人最多运行 3 轮模型调用……");
    try {
      const result = await api("/api/groups/" + encodeURIComponent(roomId) + "/messages", {
        text:value, rounds:Number(el("rounds").value), parallel
      });
      input.value = "";
      await openRoom(roomId);
      say(result.execution && result.execution.cancelled
        ? "本轮已停止；已启动的模型请求完成后收尾，未启动的机器人和后续轮次已跳过。"
        : result.execution && result.execution.mode === "parallel"
          ? "并行结果已保存；下一轮读取本轮全部结果。总调用数与费用不变。"
          : "本轮讨论已保存；每位成员的记忆与会话单独保存。");
    } catch (error) {
      say(error.message);
      if (roomId) await openRoom(roomId).catch(() => {});
    } finally {
      busy = false;
      el("sendBtn").disabled = false;
      el("cancelBtn").hidden = true;
      el("cancelBtn").disabled = false;
      activeRunId = null;
    }
  });
  el("cancelBtn").addEventListener("click", async () => {
    if (!activeRunId || !busy) return;
    el("cancelBtn").disabled = true;
    try {
      await api("/api/groups/" + encodeURIComponent(activeRunId) + "/cancel", {});
      say("已请求停止：未启动的机器人调用和后续轮次会跳过；已经发出的模型请求会等返回后收尾。");
    } catch (error) { say(error.message); }
  });
  loadRooms().catch(error => say(error.message));
})();
