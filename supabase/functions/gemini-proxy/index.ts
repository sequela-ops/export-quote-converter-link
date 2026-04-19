/**
 * 外贸报价计算器 Pro - V7.1.0  (Qwen AI集成版)
 * 部署环境: Supabase Edge Functions (Deno)
 * 核心引擎: Qwen API (支持 Qwen3.6-plus)
 * 架构: SSE Streaming — 解决 25s wall-clock timeout 问题
 */

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
    logisticsInfo = `- Logistics Detail: Route [${lc.mode}], Total ${cartons} Cartons.
   - Specs: ${lc.dimensions}, Gross Wt: ${lc.grossWeight}. Unit Freight: ${lc.unitFreight}.
   - Feasibility: Current space availability checked for these dimensions.`;

  } else if (payload.logisticsData?.l && payload.logisticsData?.perCtn) {
    // 旧版前端降级兼容：浏览器缓存未刷新时的防御性兜底
    const ld = payload.logisticsData;
    hasLogistics = true;
    const cartons = Math.ceil(ld.totalPcs / ld.perCtn);
    const unit = (ld.logisticsMode === 'sea') ? 'RT' : 'KG';
    logisticsInfo = `- Logistics Detail: ${cartons} Cartons, ${ld.result} ${unit}
   - Feasibility: Current space availability checked for these dimensions.`;
  }

  const userPrompt = `
Context

Product: ${payload.productName || 'Target Product'}

Incoterms: ${payload.incoterms}

Destination: ${payload.destination}

Quoted Price: ${payload.unitPrice}

Total Amount: ${payload.totalPrice}
${logisticsInfo}

Key Notes: ${payload.notes}

Sales Mode: ${payload.salesMode || 'Balanced'}

Task

撰写一封以"推动客户确认订单"为目标的英文报价邮件。

Requirements (必须执行)
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

  return await callQwenAPIStream(apiKey, systemInstruction, userPrompt, corsHeaders);
}

// --- 场景二：智能 HS Code 审计 ---
else if (action === 'predict_hs') {
  const systemInstruction = `你是一位精通全球海关编码与国际贸易合规的审计专家。`;
  const userPrompt = `
    分析产品 "${payload.productDescription}" 进入 "${payload.destinationCountry}" 的贸易环境。
    请严格按此格式返回（简体中文）：
    1. 📋 建议 HS Code: [给出6位国际通用码及逻辑]
    2. 📉 进口成本:[目标国关税与VAT环境]
    3. 🛡️ 准入认证:[必要证书如CE/FDA/GCC等]
    4. 🚨 清关风控:[反倾销或禁限规则提醒]
  `;
  return await callQwenAPIStream(apiKey, systemInstruction, userPrompt, corsHeaders);
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
 * 核心 API 调用函数 — SSE Streaming 版本
 */
async function callQwenAPIStream(key: string, system: string, user: string, corsHeaders: Record<string, string>) {
  const url = `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      // 【Fix-1: 握手激活】fetch 发出前立即写入 SSE 注释行，激活网关连接。
      // qwen3.6-plus thinking 阶段可达 30-50s，不发字节会触发 Supabase 25s
      // wall-clock timeout，导致 "connection closed before message completed"。
      // SSE 规范：冒号开头为注释行，前端 EventSource / 手动解析器均静默忽略。
      await writer.write(encoder.encode(": handshake

"));

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: "qwen3.6-plus",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.3,
          max_tokens: 2000,
          top_p: 0.8,
          stream: true
        })
      });

      // 【Fix-2: 错误流化】上游报错时 throw 进 catch，统一序列化进流。
      // 前端 callAIEngine 的 parsed.error 分支负责弹窗，而非触发网络抖动重试。
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Aliyun API Error (${response.status}): ${errorText.slice(0, 200)}`);
      }

      // 【Fix-3: 防御性 body 校验】body 为 null 时提前抛出，避免 .getReader() 崩溃
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Upstream response body is empty");

      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('
');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          // 【Fix-4: 单一 [DONE]】跳过上游信号，由 finally 统一发送，
          // 防止"上游转发一次 + finally 再发一次"造成前端收到双重结束信号。
          if (raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            // 过滤 thinking 内容（reasoning_content），只转发 content
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ chunk: content })}

`));
            }
          } catch {
            // 跳过心跳包或非 JSON 行，不中断循环
          }
        }
      }

    } catch (e) {
      console.error("[Backend Stream Error]:", e.message);
      // 将错误序列化进流，保持前端 SSE 解析路径一致
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}

`));
    } finally {
      // 【Fix-5: 统一收尾】无论成功/失败，由此处发送结束标志并关闭流，
      // 确保 Deno 实例资源释放，不留悬挂连接。
      await writer.write(encoder.encode("data: [DONE]

"));
      await writer.close().catch(() => {});
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
