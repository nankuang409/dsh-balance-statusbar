/**
 * dsh-balance-statusbar — host half.
 *
 * 独立实现（不依赖 dsh-deepseek-quota）：注册一条聚合路由
 *
 *   GET /api/balance-statusbar?sessionId=<id>
 *
 * 一次返回底部状态栏需要的全部数据：
 *
 *   {
 *     ok: true,
 *     balance: <DeepSeek /user/balance provider payload>,
 *     todayConsumed: <number|null>,
 *     todayConsumedSource: "official" | "estimate",
 *     sessionCost: {
 *       cost, costUsd, calls, inputTokens, cacheReadTokens, outputTokens,
 *       breakdown
 *     } | null,
 *     sessionStats: {
 *       turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens
 *     } | null,
 *     tokenUsage: {
 *       uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
 *     } | null
 *   }
 *
 * - balance：通过凭据缝（credentials seam，同一个 `DEEPSEEK_API_KEY`
 *   引用）调用 DeepSeek 官方 `/user/balance`。
 * - todayConsumed：优先平台官方用量接口（需 `DEEPSEEK_PLATFORM_TOKEN`
 *   凭据），否则按余额差值估算（与 dsh-deepseek-quota 同策略）。
 * - sessionCost：按官方价格表对会话日志做全量回放计价（含安装前历史），
 *   与 dsh-deepseek-quota 的会话费用接口同源。
 * - sessionStats / tokenUsage：直接读框架内置会话投影
 *   （`ctx.sessionProjections.snapshot(session)`，数据源与 UI 内置统计条
 *   StatsLine 完全一致：轮数/步数、LLM/工具时长、首 token、解码吞吐、
 *   token 分桶与缓存命中）。
 *
 * API key 永不出宿主：浏览器只与本路由通信。
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { costOf, priceAt } from "./pricing.js";

const name = "dsh-balance-statusbar";
const inject = ["credentials", "webServer", "sessionProjections"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
const PLATFORM_TOKEN_REF = credentialRef("DEEPSEEK_PLATFORM_TOKEN");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/balance-statusbar";
const TIMEOUT_MS = 15000;
const DAY_STATE_FILE = "balance-statusbar-day.json";
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {}
  return `DeepSeek 接口返回 HTTP ${status}`;
}

// ---- today's consumption: official platform source ------------------------

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

async function fetchPlatformTodayCost(token) {
  const now = new Date();
  const url = `${PLATFORM_USAGE_URL}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Origin: "https://platform.deepseek.com",
      Referer: "https://platform.deepseek.com/usage"
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DeepSeek 平台用量接口返回 HTTP ${response.status}`);
  const body = await response.json();
  const biz = body && typeof body === "object" ? body.data : void 0;
  if (body?.code !== 0 || biz === void 0 || biz.biz_code !== 0) {
    const code = body?.code ?? biz?.biz_code;
    if (code === 40002 || code === 40003) {
      throw new Error("DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken");
    }
    throw new Error(`DeepSeek 平台用量接口错误 (code ${code ?? "unknown"})`);
  }
  const bizData = biz.biz_data;
  const container = Array.isArray(bizData) ? bizData[0] : bizData;
  const days = container && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return null;
  const today = localDate();
  const entry = days.find((d) => d && d.date === today);
  if (!entry || !Array.isArray(entry.data)) return null;
  let total = 0;
  for (const modelEntry of entry.data) {
    if (!modelEntry || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
    for (const u of modelEntry.usage) {
      if (!u || typeof u !== "object") continue;
      const value = toFinite(u.cost ?? u.amount);
      if (Number.isFinite(value)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}

// ---- today's consumption: balance-delta estimate --------------------------

function dayStatePath(ctx) {
  let storages;
  const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") {
    storages = homeFn("storages");
  } else if (process.env.DSH_HOME) {
    storages = join(process.env.DSH_HOME, "storages");
  } else {
    storages = join(homedir(), ".dsh", "storages");
  }
  return join(storages, DAY_STATE_FILE);
}

function loadDayState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.date === "string" &&
      typeof parsed.opening === "number" &&
      typeof parsed.last === "number"
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

function saveDayState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {}
}

const TODAY_COST_MIN_INTERVAL_MS = 30000;
let todayCostCache = null;

/**
 * 当天消费 = 当天所有会话日志里 assistant/message 的计价之和。
 *
 * 比「开盘余额 − 当前余额」可靠：余额差值遇到充值就失真（充值把差值压成负数，
 * 被夹到 0，当天此前的消费全丢）。日志求和与余额无关，充值多少都不影响。
 * 全量扫描不便宜，所以 30s 一次，失败则由调用方回退到余额差值。
 */
async function computeTodayConsumedFromLogs(ctx) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === void 0 || typeof persistence.list !== "function") return null;
  const today = localDate();
  if (todayCostCache !== null && todayCostCache.date === today && Date.now() - todayCostCache.at < TODAY_COST_MIN_INTERVAL_MS) {
    return todayCostCache.cost;
  }
  try {
    const snapshots = await persistence.list();
    let cost = 0;
    for (const snapshot of snapshots ?? []) {
      // id 在 header 里，snapshot 自身没有这个字段。
      const id = snapshot?.header?.id;
      if (typeof id !== "string" || id === "") continue;
      // 子 agent 会话也在 list 里，各自独立计价，这里不能走 replaySessionCost
      // 的递归聚合，否则父子相加会重复计算。
      const record = await replayOwnCost(ctx, id);
      if (record === null) continue;
      cost += record.todayCost ?? 0;
    }
    const rounded = Math.round(cost * 100) / 100;
    todayCostCache = { date: today, cost: rounded, at: Date.now() };
    return rounded;
  } catch (error) {
    ctx.logger.warn("dsh-balance-statusbar: failed to sum today's cost from logs");
    ctx.logger.warn(error);
    return null;
  }
}

function computeTodayConsumed(ctx, balance) {
  if (!Number.isFinite(balance)) return null;
  const path = dayStatePath(ctx);
  const today = localDate();
  const stored = loadDayState(path);
  let opening = stored !== null && stored.date === today ? stored.opening : (stored !== null ? stored.last : balance);
  // 充值会让余额回升，而消费额是 opening - balance 的累计。不补正的话充值把差
  // 值压成负数，被夹到 0，当天此前的消费就丢了。把涨幅并入 opening 即可续算。
  if (stored !== null && stored.date === today && Number.isFinite(stored.last) && balance > stored.last) {
    opening += balance - stored.last;
  }
  saveDayState(path, { date: today, opening, last: balance });
  const consumed = Math.max(0, opening - balance);
  return Math.round(consumed * 100) / 100;
}

// ---- session cost (official price table replay) ---------------------------

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

function emptyCostRecord() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    buckets: {
      input: { tokens: 0, cost: 0 },
      cacheRead: { tokens: 0, cost: 0 },
      output: { tokens: 0, cost: 0 }
    }
  };
}

function priceEventInto(record, event) {
  const data = event.data;
  const usage = data?.usage;
  if (usage === void 0 || usage === null) return false;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return false;
  const source = data.message?.source;
  const model = typeof source?.model === "string" ? source.model : "unknown";
  const unit = priceAt(model, event.time ?? Date.now());
  const sample = costOf(usage, unit);
  record.calls += 1;
  record.cost += sample.cost;
  record.costUsd += sample.costUsd;
  record.inputTokens += sample.inputTokens;
  record.cacheReadTokens += sample.cacheReadTokens;
  record.outputTokens += sample.outputTokens;
  record.buckets.input.tokens += sample.inputTokens;
  record.buckets.input.cost += (sample.inputTokens * unit.cny.input) / 1e6;
  record.buckets.cacheRead.tokens += sample.cacheReadTokens;
  record.buckets.cacheRead.cost += (sample.cacheReadTokens * unit.cny.cacheRead) / 1e6;
  record.buckets.output.tokens += sample.outputTokens;
  record.buckets.output.cost += (sample.outputTokens * unit.cny.output) / 1e6;
  return true;
}

function breakdownOf(record) {
  const parts = [
    { label: "输入(未命中)", key: "input" },
    { label: "缓存命中", key: "cacheRead" },
    { label: "输出", key: "output" }
  ];
  return parts.map(({ label, key }) => {
    const bucket = record.buckets[key];
    const tokens = bucket.tokens;
    const subtotal = bucket.cost;
    const rate = tokens > 0 ? roundCost((subtotal / tokens) * 1e6) : 0;
    return { label, tokens, rate, subtotal: roundCost(subtotal) };
  });
}

const REPLAY_MIN_INTERVAL_MS = 2000;
const logCostCache = new Map();

async function replayOwnCost(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  // handle 模型（stat/open/read）。旧的 readRaw/readStoredRevision 已从
  // @deepseek-ai/dsh-session-persistence 移除，留着只会让这里恒返回 null。
  if (persistence === void 0 || typeof persistence.open !== "function" || typeof persistence.stat !== "function") {
    return null;
  }
  let revision;
  try {
    const snapshot = await persistence.stat(sessionId);
    if (snapshot === void 0) return null;
    revision = snapshot.revision;
  } catch (error) {
    ctx.logger.warn("dsh-balance-statusbar: failed to stat session for costing");
    ctx.logger.warn(error);
    return null;
  }
  if (revision === void 0) return null;
  const cached = logCostCache.get(sessionId);
  if (cached !== void 0) {
    if (cached.revision === revision) return cached;
    if (Date.now() - cached.at < REPLAY_MIN_INTERVAL_MS) return cached;
  }
  let handle;
  try {
    // 'read' 不夺所有权，活跃会话被别的 handle 写着也能读。
    handle = await persistence.open(sessionId, "read");
    const record = emptyCostRecord();
    const todayRecord = emptyCostRecord();
    const today = localDate();
    const children = [];
    const { events } = await handle.read();
    for (const event of events ?? []) {
      if (event === null || typeof event !== "object") continue;
      if (event.type === "assistant/message") {
        try {
          priceEventInto(record, event);
          // 同一条事件按自身时间戳归日，跨零点的会话不会整段算进今天。
          if (typeof event.time === "number" && localDate(new Date(event.time)) === today) {
            priceEventInto(todayRecord, event);
          }
        } catch {}
        continue;
      }
      // 子 agent 是独立会话，开销落在它自己的日志里。父日志只有这条事件记着
      // childId，不顺着它走就会少算（实测一次 4 子 agent 的审查漏掉 81%）。
      if (event.type === "subagent/catalog") {
        const childId = event.data?.childId;
        const label = typeof event.data?.label === "string" ? event.data.label : undefined;
        if (typeof childId === "string" && childId !== "") children.push({ childId, label });
      }
    }
    const result = { ...record, revision, at: Date.now(), children, todayCost: todayRecord.cost };
    logCostCache.set(sessionId, result);
    return result;
  } catch (error) {
    ctx.logger.warn("dsh-balance-statusbar: failed to replay session log for costing");
    ctx.logger.warn(error);
    return null;
  } finally {
    // 读 handle 不关会泄露后端资源；close 自身失败不该盖掉上面的结果。
    if (handle !== void 0) {
      try { await handle.close(); } catch {}
    }
  }
}

function addCostRecord(into, from) {
  into.calls += from.calls;
  into.cost += from.cost;
  into.costUsd += from.costUsd;
  into.inputTokens += from.inputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.outputTokens += from.outputTokens;
  for (const key of ["input", "cacheRead", "output"]) {
    into.buckets[key].tokens += from.buckets[key].tokens;
    into.buckets[key].cost += from.buckets[key].cost;
  }
}

const MAX_SUBAGENT_DEPTH = 4;

/**
 * 会话自身 + 其子 agent 会话的合计开销。子 agent 会 spawn 子 agent，所以要递归；
 * `seen` 防环（子会话理论上不会指回父，但 childId 来自日志，不值得信）。
 * 单个子会话读失败（已被保留策略清理等）只跳过它，不影响总数。
 */
async function replaySessionCost(ctx, sessionId, seen = new Set(), depth = 0) {
  if (seen.has(sessionId)) return null;
  seen.add(sessionId);
  const own = await replayOwnCost(ctx, sessionId);
  if (own === null) return null;
  const total = emptyCostRecord();
  addCostRecord(total, own);
  const children = [];
  if (depth < MAX_SUBAGENT_DEPTH) {
    for (const { childId, label } of own.children ?? []) {
      const child = await replaySessionCost(ctx, childId, seen, depth + 1);
      if (child === null) continue;
      addCostRecord(total, child);
      children.push({
        sessionId: childId,
        label: label ?? childId.slice(0, 8),
        cost: roundCost(child.cost),
        calls: child.calls,
        tokens: child.inputTokens + child.cacheReadTokens + child.outputTokens
      });
    }
  }
  return {
    ...total,
    revision: own.revision,
    at: own.at,
    ownCost: roundCost(own.cost),
    // 本会话自身的 token，与 UI 自带 StatsLine 同口径；聚合值只用于费用。
    ownTokens: own.inputTokens + own.cacheReadTokens + own.outputTokens,
    children
  };
}

// ---- plugin body ----------------------------------------------------------

function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const sessionId = url.searchParams.get("sessionId") ?? "";

          // 1) balance
          const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
          if (hit === void 0) {
            sendJson(res, 503, {
              ok: false,
              error: "no-api-key",
              message: "未配置 DEEPSEEK_API_KEY：请在 设置 → 模型 中填写 DeepSeek API Key。"
            });
            return;
          }
          const response = await fetch(balanceUrl(), {
            headers: {
              Authorization: `Bearer ${hit.value}`,
              Accept: "application/json"
            },
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
          const text = await response.text();
          if (!response.ok) {
            sendJson(res, response.status, {
              ok: false,
              error: "provider",
              message: providerMessage(text, response.status)
            });
            return;
          }
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          const total = body && Array.isArray(body.balance_infos) ? Number(body.balance_infos[0]?.total_balance) : NaN;

          // 2) today's consumption
          let todayConsumed = null;
          let todayConsumedSource = "estimate";
          const platformHit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF);
          if (platformHit !== void 0) {
            try {
              const official = await fetchPlatformTodayCost(platformHit.value);
              if (official !== null) {
                todayConsumed = official;
                todayConsumedSource = "official";
              }
            } catch (error) {
              ctx.logger.warn("dsh-balance-statusbar: platform usage fetch failed; falling back to estimate");
              ctx.logger.warn(error);
            }
          }
          if (todayConsumedSource !== "official") {
            // 日志求和优先：余额差值遇到充值会失真（见 computeTodayConsumed）。
            const fromLogs = await computeTodayConsumedFromLogs(ctx);
            if (fromLogs !== null) {
              todayConsumed = fromLogs;
              todayConsumedSource = "logs";
            } else if (Number.isFinite(total)) {
              todayConsumed = computeTodayConsumed(ctx, total);
            }
          }
          // 余额差值那条即使没被采用也要跑，它负责维护当天的 opening/last 存档。
          if (todayConsumedSource === "logs" && Number.isFinite(total)) {
            computeTodayConsumed(ctx, total);
          }

          // 3) current conversation cost (optional, needs sessionId)
          let sessionCost = null;
          if (sessionId !== "") {
            const record = await replaySessionCost(ctx, sessionId);
            if (record !== null) {
              sessionCost = {
                cost: roundCost(record.cost),
                costUsd: roundCost(record.costUsd),
                calls: record.calls,
                inputTokens: record.inputTokens,
                cacheReadTokens: record.cacheReadTokens,
                outputTokens: record.outputTokens,
                breakdown: breakdownOf(record),
                // cost 已含子 agent；ownCost/ownTokens 是本会话自身。
                ownCost: record.ownCost,
                ownTokens: record.ownTokens,
                children: record.children ?? []
              };
            }
          }

          // 4) built-in session projections (stats + token usage), same source
          //    as the UI's StatsLine: turns/steps, LLM/tool wall times, TTFT,
          //    decode throughput, token buckets & cache-hit.
          let sessionStats = null;
          let tokenUsage = null;
          if (sessionId !== "" && ctx.sessionProjections !== void 0) {
            try {
              const live = ctx.sessions.get(sessionId);
              if (live !== void 0) {
                const snap = ctx.sessionProjections.snapshot(live);
                const stats = snap?.values?.sessionStats;
                if (stats !== void 0 && stats !== null) {
                  sessionStats = {
                    turns: stats.turns,
                    steps: stats.steps,
                    llmMs: stats.llmMs,
                    toolMs: stats.toolMs,
                    ttftMs: stats.ttftMs,
                    ttftSteps: stats.ttftSteps,
                    decodeMs: stats.decodeMs,
                    decodeTokens: stats.decodeTokens
                  };
                }
                const usage = snap?.values?.tokenUsage;
                if (usage !== void 0 && usage !== null) {
                  tokenUsage = {
                    uncachedInputTokens: usage.uncachedInputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheWriteTokens: usage.cacheWriteTokens
                  };
                }
              }
            } catch (error) {
              ctx.logger.warn("dsh-balance-statusbar: session projection read failed");
              ctx.logger.warn(error);
            }
          }

          sendJson(res, 200, {
            ok: true,
            balance: body,
            todayConsumed,
            todayConsumedSource,
            sessionCost,
            sessionStats,
            tokenUsage
          });
        } catch (error) {
          ctx.logger.warn("dsh-balance-statusbar: failed to fetch status data");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "fetch-failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }),
    "dsh-balance-statusbar: balance status route"
  );
}

export { name, inject, apply };
