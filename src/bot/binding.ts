// src/bot/binding.ts — 缺口 42 第二批：BotRunner 与持久电脑的绑定。
//
// Bot 启动时（BotRunner 构造时）调一次 resolveBotComputer：
//   - 这台 Bot 的 Soul 身份下已有电脑 → 直接用它；
//   - 有 Soul、没电脑 → 自动建一台（默认配置 1024 MB / 50% / 15 分钟；
//     建电脑本身会记 computer.created 活动，失败时不挡 Bot 启动）；
//   - 没 Soul → 返回 null，Bot 照常跑（工作目录仍是启动时的目录），
//     启动时打一条提示，告诉机主跑 `nyra soul init <agent>` 再建电脑。
// 绑定是一次性的（构造时定死）：运行中换电脑要重启 Bot——Bot 的电脑
// 与身份一一对应，不在运行中途换。
import { computerForAgent, createComputer, computerWorkspacePath, type BotComputer } from "./computer.ts";
import { soulExists } from "../soul.ts";

export interface BotComputerBinding {
  /** 绑上的电脑。 */
  computer: BotComputer;
  /** 本次是新建的（true）还是本来就有的（false）。 */
  created: boolean;
  /** Agent 在这台电脑里的工作目录（Agent 的 workdir 落在这里）。 */
  workdir: string;
}

/**
 * 给定 home 与 Bot 的 Soul 身份，解析它那台电脑。返回 null 表示没接上
 * （没 Soul，或建电脑失败——内存超限、磁盘写失败等）；调用方用启动时的
 * 工作目录继续跑，并打一条提示（Bot 不因电脑接不上而拒绝启动：没电脑的
 * Bot 在第一批之前就是这么跑的）。只有读电脑账本本身失败（账本损坏）
 * 时才抛错——账本坏了是硬故障，静默降级会让 Bot 在错误的目录里跑任务。
 */
export function resolveBotComputer(home: string, agent: string): BotComputerBinding | null {
  const existing = computerForAgent(home, agent);
  if (existing) {
    return { computer: existing, created: false, workdir: computerWorkspacePath(home, existing) };
  }
  if (!soulExists(home, agent)) return null;
  try {
    const created = createComputer(home, { agent });
    return { computer: created, created: true, workdir: computerWorkspacePath(home, created) };
  } catch {
    // 已有电脑被别的进程抢先建了（createComputer 抛“已经有一台电脑”）时
    // 再读一次；内存超限等其他失败回 null，让 Bot 用启动目录兜底跑。
    const raced = computerForAgent(home, agent);
    if (raced) {
      return { computer: raced, created: false, workdir: computerWorkspacePath(home, raced) };
    }
    return null;
  }
}
