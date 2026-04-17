/**
 * 外贸报价计算器 Pro - V6 最终版 (Qwen AI集成版)
 * 部署环境: Supabase Edge Functions (Deno)
 * 核心引擎: Qwen API (支持 Qwen3.6-plus)
 * 架构: SSE Streaming — 解决 25s wall-clock timeout 问题
 */

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { action, payload } = await req.json()
    const apiKey = Deno.env.get('QWEN_API_KEY')

    if (!apiKey) throw new Error("API_KEY_NOT_CONFIGURED")

    // --- 场景一：高转化率报价邮件（深度集成用户约束） ---
    if (action === 'generate_email') {
      const systemInstruction = `你是一位拥有15年全球贸易经验的资深外贸专家，精通跨文化沟通与高转化率文案。你自信、专业、有分寸感，强调产品价值和服务优势。`;
      
      const userPrompt = `
      # Context
      - Product: ${payload.productName || 'Target Product'}
      - Incoterms: ${payload.incoterms}
      - Destination: ${payload.destination}
      - Quoted Price: USD ${payload.unitPrice}
      - Total Amount: USD ${payload.totalPrice}
      - Key Notes: ${payload.notes}

      # Task
      撰写一封专业、且具备成交推动力的英文报价/跟进邮件。

      # Requirements (必须严格执行)
      1. **模块化写作结构**：
         - 第一步：确认客户需求/背景。
         - 第二步：展示专业报价（使用上述提供的数据）。
         - 第三步：提供优势提醒或风险预警（基于 ${payload.incoterms} 条款给客户带来的保障）。
         - 第四步：明确的行动启发（Call to Action）。

      2. **核心禁令 (商业机密保护)**：
         - **严禁提及或暗示任何关于“进货底价”、“成本构成”、“内部利润率”或“降价空间”的信息。**
         - **报价口径：仅使用提供的“Quoted Price”进行陈述，绝对不得向客户解释价格是如何计算出来的。**
         - 严禁出现 "Our cost is..." 或 "My profit is very low" 等非专业、乞求式的表达。
         - 严禁任何 "Dear respected sir" 这种过时称呼。

      3. **语气与风格**：
         - 语气：自信、专业、利他主义、符合国际商务礼仪。
         - 表达：地道商务英语，拒绝中式翻译。
         - **输出要求：直接输出邮件正文，严禁包含任何开场白、解释语或结束语。**
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
