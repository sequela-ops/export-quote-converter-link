import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { action, payload } = await req.json()
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) throw new Error('Backend Secret Missing: GEMINI_API_KEY')

    // 1. 数据预处理：防止前端传空值导致模型幻觉
    const clean = (val: any) => (val && val !== 'null') ? val : "Not Specified";

    let systemInstruction = "";
    let userPrompt = "";

    // --- 场景一：智能撰写高转化率邮件 ---
    if (action === 'generate_email') {
      systemInstruction = `你是一位拥有20年实战经验的高级外贸主管，擅长地道的商务英语和博弈。你的目标是写出让客户无法拒绝、展现专业度且没有中式英语痕迹的报价跟进邮件。`;
      userPrompt = `
      # Context
      - 产品: ${clean(payload.productName)}
      - 贸易术语: ${clean(payload.incoterms)} (请在邮件中体现出该术语下我方的专业服务保障)
      - 目的港/国: ${clean(payload.destination)}
      - 报价: ${clean(payload.unitPrice)} (Total: ${clean(payload.totalPrice)})
      - 附加细节: ${clean(payload.notes)}

      # Constraints
      - 严禁任何 "Dear respected sir" 这种过时称呼。
      - 采用模块化写作：确认需求 -> 专业报价 -> 优势/风险提醒 -> 明确的行动启发。
      - **商业机密保护：严禁提及或暗示任何关于“进货底价”、“成本构成”、“内部利润率”或“降价空间”的信息。**
      - **报价口径：仅使用提供的“建议报价”进行陈述，不得向客户解释价格是如何计算出来的。**
      - 严禁出现 "Our cost is..." 或 "My profit is very low" 等非专业、乞求式的表达。
      - 语气：自信、专业、有分寸感、利他主义、强调产品价值和服务优势、符合国际商务礼仪。
      - **直接输出邮件内容，严禁任何解释语。**
      `;
    } 

    // --- 场景二：HS Code 预测与贸易合规审计 ---
    else if (action === 'predict_hs') {
      systemInstruction = `你是一位全球通关合规审计专家，精通 WCO HS 协调制度、各国贸易准入壁垒及关税政策。`;
      userPrompt = `
      # Objective
      预测产品 "${clean(payload.productDescription)}" 进入 "${clean(payload.destinationCountry)}" 的 HS Code 并预警风险。

      # Output Structure (严格遵循)
      1. 📋 **核心编码**: [给出前6位国际通用码，说明分类逻辑]
      2. 📉 **进口成本**: [预估该国对该品类的平均 MFN 税率，如涉及中国出口，请特别提醒是否有特定壁垒]
      3. 🛡️ **准入认证**: [列出必须的证书，如 CE, UKCA, REACH, FDA, UL, GCC 等]
      4. 🚨 **风控预警**: [重点提及反倾销、反补贴、知识产权或该国特定清关雷区]

      **语言: 简体中文。回答要硬核、干练。**
      `;
    }

    // 2. 使用 Gemini 1.5 Flash 高级调用模式
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Gemini 1.5 专有的系统指令，能极大地稳定输出风格
        system_instruction: {
          parts: [{ text: systemInstruction }]
        },
        contents: [{
          parts: [{ text: userPrompt }]
        }],
        generationConfig: {
          temperature: 0.3, // 降低随机性，确保报价和编码的严谨性
          topP: 0.8,
          maxOutputTokens: 2048,
          responseMimeType: "text/plain"
        }
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(`Gemini API Error: ${data.error.message}`);

    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No AI response generated.";

    return new Response(JSON.stringify({ result: resultText }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
