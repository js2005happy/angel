// src/gatewayClient.ts — CLI/定时任务/群聊接 gateway 用的 HTTP 客户端。
// 与 gateway 共用同一份会话：所有写操作都走 gateway 的 API，不在本进程
// 另起 agent，所以双客户端看到的会话、队列、历史完全一致。
export interface GatewayClientOptions {
  url?: string;
  token?: string;
}

export class GatewayClient {
  baseUrl: string;
  token: string;

  constructor(opts: GatewayClientOptions = {}) {
    const raw = opts.url ?? process.env.NYRA_GATEWAY_URL ?? "http://127.0.0.1:8765";
    this.baseUrl = raw.replace(/\/$/, "").replace(/\?token=.*$/, "");
    this.token = opts.token ?? process.env.NYRA_GATEWAY_TOKEN ?? "";
  }

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "X-Nyra-Token": this.token, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  health(): Promise<unknown> { return this.call("/api/health"); }
  sessions(): Promise<unknown> { return this.call("/api/sessions"); }
  createSession(): Promise<{ id: string }> { return this.call("/api/sessions", { method: "POST", body: "{}" }) as Promise<{ id: string }>; }
  sessionView(id: string, since = 0): Promise<unknown> { return this.call(`/api/sessions/${encodeURIComponent(id)}?since=${since}`); }
  history(id: string): Promise<{ messages: { id: number; role: string; text: string }[] }> {
    return this.call(`/api/sessions/${encodeURIComponent(id)}/history`) as Promise<{ messages: { id: number; role: string; text: string }[] }>;
  }
  send(id: string, text: string): Promise<unknown> {
    return this.call(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  }
  approvals(): Promise<unknown> { return this.call("/api/approvals"); }
  decide(id: string, approve: boolean, always = false): Promise<unknown> {
    return this.call(`/api/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ approve, always }) });
  }
  rewind(id: string, messageId: number, action: "truncate" | "edit" | "fork", text?: string | null): Promise<unknown> {
    return this.call(`/api/sessions/${encodeURIComponent(id)}/rewind`, {
      method: "POST", body: JSON.stringify({ message_id: messageId, action, text: text ?? null }),
    });
  }
  info(): Promise<unknown> { return this.call("/api/info"); }
  schedule(): Promise<unknown> { return this.call("/api/schedule"); }
}
