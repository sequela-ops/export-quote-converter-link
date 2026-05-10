/**
 * 外贸报价计算器 Pro  (Qwen AI集成版）
 * 部署环境: Supabase Edge Functions (Deno)
 * 核心引擎: Qwen API (支持 Qwen3.6-plus)
 * 架构: SSE Streaming — 解决 25s wall-clock timeout 问题
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// 输入清洗：剥离换行 + 长度截断，挡住 prompt injection 与 token 滥用
const sanitize = (s: unknown, max = 500) =>
  String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)

// 鉴权失败时以 SSE 流格式返回错误，与前端解析协议保持一致
const authErrorStream = (errMsg: string, corsHeaders: Record<string, string>) => {
  const stream = new ReadableStream({
    start(controller) {
      const data = JSON.stringify({ error: errMsg });
      controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' }
  });
};

Deno.serve(async (req) => {
// 1. 获取当前请求的来源域名
const origin = req.headers.get('Origin');

// 2. 配置您的专属白名单（绝对不能带子路径和末尾斜杠）
const allowedOrigins =[
'https://sequela-ops.github.io',  // ✅ 只需要到 .io 结束，不能有后面的路径
'http://127.0.0.1:5500',          // 供本地 VSCode Live Server 测试用
'http://localhost:5500'           // 供本地测试用
];

// 3. 如果请求来源在白名单里，就允许；否则默认只允许您的 GitHub Pages 主域名
const allowOrigin = allowedOrigins.includes(origin) ? origin : 'https://sequela-ops.github.io';

const corsHeaders = {
'Access-Control-Allow-Origin': allowOrigin,
'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

try {
// ── JWT 校验：拒绝裸 anon key 调用，强制必须有真实用户 session ──
const authHeader = req.headers.get('Authorization') || ''
const jwt = authHeader.replace(/^Bearer\s+/i, '')
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
if (!jwt || jwt === anonKey) {
  return authErrorStream('AUTH_REQUIRED', corsHeaders)
}
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  anonKey!,
  { global: { headers: { Authorization: `Bearer ${jwt}` } } }
)
const { data: { user } } = await sb.auth.getUser()
if (!user) {
  return authErrorStream('INVALID_TOKEN', corsHeaders)
}

const { action, payload } = await req.json()
const apiKey = Deno.env.get('QWEN_API_KEY')

if (!apiKey) throw new Error("API_KEY_NOT_CONFIGURED")

// --- 场景一：Elite Closer 驱动报价邮件（成交驱动型） ---
if (action === 'generate_email') {
  const systemInstruction = `
你是一位顶级外贸成交专家（Elite Closer），你的核心能力是：
在不冒犯客户的前提下，自然推动对方做出"立即行动"。

你的思维方式：
客户不是缺信息，而是缺"决策理由"
邮件的目标不是灌输各种数据，而是减少拖延
每一句话要么降低风险感，要么推动具体的下一步

你的风格：
简洁、有控制力、掌控感
像一个在真实做生意的人，而不是写模板的人
`;

  // 【架构解耦】：后端作纯粹的透传层（Dumb Proxy），不维护任何前端业务枚举
  // 前端（generateAIEmail）负责将 logisticsMode 翻译为人类可读的 mode 标签后发送
  // 双向兼容：优先读取 V7+ 的 logisticsContext，降级兼容旧版 logisticsData
  let logisticsInfo = `- Shipping Context: Order volume based pricing.`;
  let hasLogistics = false;

  if (payload.logisticsContext) {
    // V7+ 前端：已完成业务字典翻译，后端直接透传
    const lc = payload.logisticsContext;
    hasLogistics = true;
    const cartons = Math.ceil(lc.totalPcs / (lc.pcsPerCarton || 1));
    logisticsInfo = `- Logistics Detail: Route [${sanitize(lc.mode, 60)}], Total ${cartons} Cartons.
   - Specs: ${sanitize(lc.dimensions, 80)}, Gross Wt: ${sanitize(lc.grossWeight, 50)}. Unit Freight: ${sanitize(lc.unitFreight, 50)}.
   - Feasibility: Current space availability checked for these dimensions.`;

  } else if (payload.logisticsData?.l && payload.logisticsData?.perCtn) {
    // 旧版前端降级兼容：浏览器缓存未刷新时的防御性兜底
    const ld = payload.logisticsData;
    hasLogistics = true;
    const cartons = Math.ceil(ld.totalPcs / ld.perCtn);
    const unit = (ld.logisticsMode === 'sea') ? 'RT' : 'KG';
    logisticsInfo = `- Logistics Detail: ${cartons} Cartons, ${sanitize(ld.result, 50)} ${unit}
   - Feasibility: Current space availability checked for these dimensions.`;
  }

  const userPrompt = `
Context

Product: ${sanitize(payload.productName || 'Target Product', 200)}

Incoterms: ${sanitize(payload.incoterms, 30)}

Destination: ${sanitize(payload.destination, 120)}

Quoted Price: ${sanitize(payload.unitPrice, 60)}

Total Amount: ${sanitize(payload.totalPrice, 60)}
${logisticsInfo}

Key Notes: ${sanitize(payload.notes, 800)}

Sales Mode: ${sanitize(payload.salesMode || 'Balanced', 30)}

Task

撰写一封以"推动客户确认订单"为目标的英文报价邮件。

Requirements (必修执行)
1. 成交结构（必须遵循）

Hook（1句）：确认需求，直接进入主题

Clarity：清晰给出报价 +（如有）物流可执行性

Value：说明此方案如何降低客户操作复杂度或风险

Real Urgency（关键）：

必须使用"当前市场语境"（如 recently / current / this week）

必须具体（不可泛泛而谈）

Action Step（关键）：

明确客户需要做的动作（confirm / sign PI / reply）

明确确认后你会做什么（lock price / secure space / start production）

2. 决策引导（必须包含）

必须包含一句"建议性引导"，例如：

we suggest proceeding with this structure

this setup would be the most efficient option

👉 目的：减少客户思考成本

3. Urgency强度控制

Balanced：保持商务礼仪，轻微提醒（默认）

Closing：明确强调"可能变化 + 建议尽快确认"（例如排产或物流舱位的"临界点"等）

4. 物流表达

${hasLogistics
? "- 必须自然提及箱数 + CBM/重量，让方案显得可立即执行"
: "- 无物流数据时，强调价格或排产的有效期"}

5. 严格禁令

禁止解释成本

禁止营销词（best price / huge discount）

禁止长段解释DDP

禁止空话

6. 风格

150–220词

每句话必须有"功能"（信息 or 推动决策）

像真实业务员写的，而不是AI

7. 输出

直接输出邮件正文
`;

  // ✅ 手术级补丁：末尾透传 req.signal 感知客户端真实存活状态
  return await callQwenAPIStream(apiKey, systemInstruction, userPrompt, corsHeaders, req.signal);
}

// --- 场景二：智能 HS Code 审计 ---
else if (action === 'predict_hs') {
  const systemInstruction = `你是一位精通全球海关编码与国际贸易合规的审计专家。`;
  const userPrompt = `
    分析产品 "${sanitize(payload.productDescription, 500)}" 进入 "${sanitize(payload.destinationCountry, 120)}" 的贸易环境。
    请严格按此格式返回（简体中文）：
    1. 📋 建议 HS Code: [给出6位国际通用码及逻辑]
    2. 📉 进口成本:[目标国关税与VAT环境]
    3. 🛡️ 准入认证:[必要证书如CE/FDA/GCC等]
    4. 🚨 清关风控:[反倾销或禁限规则提醒]
  `;
  // ✅ 手术级补丁：末尾透传 req.signal
  return await callQwenAPIStream(apiKey, systemInstruction, userPrompt, corsHeaders, req.signal);
}

throw new Error("UNKNOWN_ACTION");

} catch (err) {
console.error(`[Error]: ${err.message}`);
// 错误也以 SSE 格式返回，保持前端解析一致
const errorStream = new ReadableStream({
start(controller) {
const data = JSON.stringify({ error: err.message });
controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
controller.close();
}
});
return new Response(errorStream, {
status: 200,
headers: { ...corsHeaders, 'Content-Type': 'text/event-stream' }
});
}
})

/**
 * 核心 API 调用函数 — 彻底解决深思大模型“静默窒息”的终极保活版 (V4 双引擎版)
 */
async function callQwenAPIStream(key: string, system: string, user: string, corsHeaders: Record<string, string>, reqSignal: AbortSignal) {
  const url = `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 安全写入封装，吞噬由于并发断开导致的 Broken Pipe 异常
  const safeWrite = async (data: string) => {
    if (reqSignal.aborted) return;
    try { await writer.write(encoder.encode(data)); } catch (e) {}
  };

  (async () => {
    // 【终极防线：独立起搏器】解决阿里云晚高峰 GPU 排队、连首包都不发的绝对静默问题
    // 每 10 秒强制向前端发送一次心跳，独立于 API 返回流之外
    let keepAliveTimer: number | undefined;

    const cleanup = () => {
      if (keepAliveTimer !== undefined) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
      }
    };
    reqSignal.addEventListener('abort', cleanup, { once: true });

    try {
      keepAliveTimer = setInterval(() => {
        safeWrite(": keep-alive-ping\n\n");
      }, 10000);

      // 第一道心跳：初始握手，突破首包等待期的网关拦截
      await safeWrite(": handshake\n\n");

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages:[
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.3,
          max_tokens: 2000,
          top_p: 0.8,
          stream: true
        }),
        signal: reqSignal // 绑定客户端生命周期，人走灯灭，不浪费一分钱
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Aliyun API Error (${response.status}): ${errorText.slice(0, 200)}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Upstream response body is empty");

      const decoder = new TextDecoder();
      let lineBuffer = ""; 

      while (true) {
        if (reqSignal.aborted) break; // 客户端离开，立刻停止拉取

        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || ""; 

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          
          try {
            const parsed = JSON.parse(raw);
            const content = parsed.choices?.[0]?.delta?.content;
            
            // 抓取模型的思考过程（reasoning_content）
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;

            if (content) {
              // 1. 正式内容：正常输出给网页显示
              await safeWrite(`data: ${JSON.stringify({ chunk: content })}\n\n`);
            } else if (reasoning) {
              // 2. 思考期映射流：骗过网关，强制重置 Supabase/Nginx 的 Idle Timeout
              await safeWrite(`: heartbeat\n\n`);
            }
          } catch { continue; } // 忽略非标准 JSON 的解析报错
        }
      }
    } catch (e) {
      console.error("[Backend Stream Error]:", e.message);
      if (!reqSignal.aborted) {
        await safeWrite(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      }
    } finally {
      // 停止起搏器，防止内存泄漏
      cleanup();
      
      if (!reqSignal.aborted) {
        await safeWrite("data: [DONE]\n\n");
      }
      try { await writer.close(); } catch (_) {}
    }
  })();

  // 立即返回可读流，0ms 首包响应，不阻塞等待 Qwen thinking 阶段
  return new Response(readable, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    }
  });
}
