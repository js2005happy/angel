// src/rewind.ts — /rewind：基于 conversations SQLite 存储的会话回退。
// 任意消息可回退（删掉它之后的消息）、编辑重发（改写该条 user 消息后
// 删掉它之后的消息，调用方再发新一轮）、fork 新会话（复制截至该消息的
// 历史到新会话，原会话不动）。三端（CLI / 网页 / 手机）共用同一份实现，
// 所以结果一致；手机端走的也是 gateway 的同一条 API。
// 注意与 CLI 旧 /rewind N 的区别：旧命令撤销的是本地文件检查点
// （checkpoints.undo），这里回退的是对话历史；两者互不干扰。
import { newSessionId } from "./memory.ts";
import { ConversationStore, type MessageRow } from "./conversations.ts";

export type RewindAction = "truncate" | "edit" | "fork";

export interface RewindResult {
  action: RewindAction;
  session_id: string;
  new_session_id: string | null;
  message_id: number;
  kept: number;
  deleted: number;
  edited_text: string | null;
}

function keptCount(store: ConversationStore, sessionId: string): number {
  return store.history(sessionId, 100000).length;
}

/** 回退到 messageId：删掉它之后的消息，保留它及之前。 */
export function rewindTo(store: ConversationStore, sessionId: string, messageId: number): RewindResult {
  const target = store.getMessage(messageId);
  if (!target) throw new Error(`消息不存在：${messageId}`);
  if (target.session_id !== sessionId) throw new Error(`消息 ${messageId} 不属于会话 ${sessionId}`);
  const deleted = store.deleteAfter(sessionId, messageId);
  return {
    action: "truncate", session_id: sessionId, new_session_id: null,
    message_id: messageId, kept: keptCount(store, sessionId), deleted, edited_text: null,
  };
}

/** 编辑重发：messageId 必须是 user 消息；改写它，删掉它之后的消息。 */
export function rewindEdit(store: ConversationStore, sessionId: string, messageId: number, newText: string): RewindResult {
  const target = store.getMessage(messageId);
  if (!target) throw new Error(`消息不存在：${messageId}`);
  if (target.session_id !== sessionId) throw new Error(`消息 ${messageId} 不属于会话 ${sessionId}`);
  if (target.role !== "user") throw new Error(`只能编辑 user 消息重发，消息 ${messageId} 是 ${target.role}`);
  const updated = store.updateMessageText(messageId, newText);
  const deleted = store.deleteAfter(sessionId, messageId);
  return {
    action: "edit", session_id: sessionId, new_session_id: null,
    message_id: messageId, kept: keptCount(store, sessionId), deleted, edited_text: updated.text,
  };
}

/** fork：复制截至 messageId 的历史到新会话，原会话不动。 */
export function rewindFork(store: ConversationStore, sessionId: string, messageId: number, newSessionId?: string | null): RewindResult {
  const target = store.getMessage(messageId);
  if (!target) throw new Error(`消息不存在：${messageId}`);
  if (target.session_id !== sessionId) throw new Error(`消息 ${messageId} 不属于会话 ${sessionId}`);
  const forkId = newSessionId ?? newSessionId_();
  const copied = store.copyUpTo(sessionId, messageId, forkId);
  return {
    action: "fork", session_id: sessionId, new_session_id: forkId,
    message_id: messageId, kept: copied, deleted: 0, edited_text: null,
  };
}

function newSessionId_(): string {
  return newSessionId();
}

export function rewind(store: ConversationStore, sessionId: string, messageId: number, action: RewindAction, text?: string | null): RewindResult {
  if (action === "truncate") return rewindTo(store, sessionId, messageId);
  if (action === "edit") {
    if (typeof text !== "string" || !text.trim()) throw new Error("编辑重发需要新的消息文本");
    return rewindEdit(store, sessionId, messageId, text);
  }
  if (action === "fork") return rewindFork(store, sessionId, messageId);
  throw new Error(`未知的回退操作：${action}`);
}

/** 把 store 里的历史转成 agent 消息格式（role/content），供回退后重建 live 会话。 */
export function storeHistoryToAgentMessages(rows: MessageRow[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const msg: Record<string, unknown> = { role: r.role, content: r.text };
    if (r.tool_name) msg.tool_name = r.tool_name;
    return msg;
  });
}
