/**
 * 外贸报价计算器 Pro - V6 最终版
 * 部署环境: Supabase Edge Functions (Deno)
 * 核心引擎: Google Gemini 1.5 Flash (Singapore Node)
 */

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json'
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { action, payload } = await req.json()
    const apiKey = Deno.env.get('GEMINI_API_KEY')

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

      return await callGeminiAPI(apiKey, systemInstruction, userPrompt, corsHeaders);
    }

    // --- 场景二：智能 HS Code 审计 ---
    else if (action === 'predict_hs') {
      const systemInstruction = `你是一位精通全球海关编码与国际贸易合规的审计专家。`;
      const userPrompt = `
        分析产品 "${payload.productDescription}" 进入 "${payload.destinationCountry}" 的贸易环境。
        请严格按此格式返回（简体中文）：
        1. 📋 建议 HS Code: [给出6位国际通用码及逻辑]
        2. 📉 进口成本: [目标国关税与VAT环境]
        3. 🛡️ 准入认证: [必要证书如CE/FDA/GCC等]
        4. 🚨 清关风控: [反倾销或禁限规则提醒]
      `;
      return await callGeminiAPI(apiKey, systemInstruction, userPrompt, corsHeaders);
    }

    throw new Error("UNKNOWN_ACTION");

  } catch (err) {
    console.error(`[Error]: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 200, 
      headers: corsHeaders 
    });
  }
})

/**
 * 核心 API 调用函数
 */
async function callGeminiAPI(key, system, user, headers) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-002:generateContent?key=${key}`;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15秒超时

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [
          { 
            role: "user",
            parts: [{ text: user }]
          }
        ],
        generationConfig: { 
          temperature: 0.3, 
          maxOutputTokens: 2000,
          topP: 0.8
        }
      })
    });

    clearTimeout(timeout);
    const data = await response.json();

    if (data.error) {
      return new Response(JSON.stringify({ result: `AI 暂时不可用: ${data.error.message}` }), { headers });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "AI 忙碌中，请稍后。";
    return new Response(JSON.stringify({ result: text }), { headers });

  } catch (e) {
    const msg = e.name === 'AbortError' ? "请求超时，请稍后重试" : e.message;
    return new Response(JSON.stringify({ result: `连接 AI 失败: ${msg}` }), { headers });
  }
}
