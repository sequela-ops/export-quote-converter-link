/**
 * 外贸报价计算器 Pro - V6 最终版 (Qwen AI集成版)
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
在不冒犯客户的前提下，自然推动对方做出“立即行动”。

你的思维方式：
- 客户不是缺信息，而是缺“决策理由”
- 邮件的目标不是灌输各种数据，而是减少拖延
- 每一句话要么降低风险感，要么推动具体的下一步

你的风格：
- 简洁、有控制力、掌控感
- 像一个在真实做生意的人，而不是写模板的人
`;

      const ld = payload.logisticsData || {};
      const hasLogistics = !!(ld.l && ld.perCtn);
      const logisticsInfo = hasLogistics ? 
        `- Logistics Detail: ${Math.ceil(ld.totalPcs / ld.perCtn)} Cartons, ${ld.logisticsMode === 'sea' ? ld.result + ' RT' : ld.result + ' KG'}
         - Feasibility: Current space availability checked for these dimensions.` : 
        `- Shipping Context: Order volume based pricing.`;

      const userPrompt = `
# Context
- Product: ${payload.productName || 'Target Product'}
- Incoterms: ${payload.incoterms}
- Destination: ${payload.destination}
- Quoted Price: USD ${payload.unitPrice}
- Total Amount: USD ${payload.totalPrice}
${logisticsInfo}
- Key Notes: ${payload.notes}
- Sales Mode: ${payload.salesMode || 'Balanced'}

# Task
撰写一封以“推动客户确认订单”为目标的英文报价邮件。

# Requirements (必须执行)

## 1. 成交结构（必须遵循）
- Hook（1句）：确认需求，直接进入主题
- Clarity：清晰给出报价 +（如有）物流可执行性
- Value：说明此方案如何降低客户操作复杂度或风险
- Real Urgency（关键）：
  - 必须使用“当前市场语境”（如 recently / current / this week）
  - 必须具体（不可泛泛而谈）
- Action Step（关键）：
  - 明确客户需要做的动作（confirm / sign PI / reply）
  - 明确确认后你会做什么（lock price / secure space / start production）

## 2. 决策引导（必须包含）
必须包含一句“建议性引导”，例如：
- we suggest proceeding with this structure
- this setup would be the most efficient option

👉 目的：减少客户思考成本

## 3. Urgency强度控制
- Balanced：保持商务礼仪，轻微提醒（默认）
- Closing：明确强调“可能变化 + 建议尽快确认”（例如排产或物流舱位的“临界点”等）

## 4. 物流表达
${hasLogistics 
? "- 必须自然提及箱数 + CBM/重量，让方案显得可立即执行" 
: "- 无物流数据时，强调价格或排产的有效期"}

## 5. 严格禁令
- 禁止解释成本
- 禁止营销词（best price / huge discount）
- 禁止长段解释DDP
- 禁止空话

## 6. 风格
- 150–220词
- 每句话必须有“功能”（信息 or 推动决策）
- 像真实业务员写的，而不是AI

## 7. 输出
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
 * 
 * 架构要点：
 * - 向 Qwen 发起 stream:true 请求，拿到流式响应
 * - 将 Qwen 的 SSE chunks 转发给前端，解决 Supabase 25s wall-clock timeout
 * - 只要第一个 chunk 在 25s 内到达，连接就不会被 shutdown
 * - Qwen3.6-plus 思考过程的 token 不计入 max_tokens，只影响首包延迟
 */
async function callQwenAPIStream(key, system, user, corsHeaders) {
  const url = `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`;

  // TransformStream：把 Qwen SSE 流转换成只含 content 文本的精简 SSE 流
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // 异步处理流，不阻塞 Response 返回
  (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          // 【温馨提示】：注意"qwen3.6-plus"模型用量控制，免费额度用尽后请切换至其他可用模型。
          model: "qwen3.6-plus",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.3,
          max_tokens: 2000,
          top_p: 0.8,
          stream: true  // 【核心改动】开启流式输出
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        const errMsg = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
        await writer.write(encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`));
        await writer.write(encoder.encode(`data: [DONE]\n\n`));
        await writer.close();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            // 转发终止信号
            await writer.write(encoder.encode(`data: [DONE]\n\n`));
            continue;
          }
          try {
            const parsed = JSON.parse(raw);
            // 过滤 thinking 内容（reasoning_content），只转发 content
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              // 只把 content 片段转发，格式精简
              await writer.write(encoder.encode(`data: ${JSON.stringify({ chunk: content })}\n\n`));
            }
          } catch {
            // 跳过无法解析的行（心跳包等）
          }
        }
      }

    } catch (e) {
      const msg = e.name === 'AbortError' ? "上游请求超时" : e.message;
      await writer.write(encoder.encode(`data: ${JSON.stringify({ error: `连接 AI 失败: ${msg}` })}\n\n`));
      await writer.write(encoder.encode(`data: [DONE]\n\n`));
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'  // 禁止 Nginx 缓冲，确保 chunks 实时推送
    }
  });
}
