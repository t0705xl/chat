// 后台服务 Service Worker：DeepSeek 通信 + 4层动态记忆系统 (7天增权降权 & 本地 Vault 同步)
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const VAULT_BRIDGE_URL = "http://127.0.0.1:18991";

console.log("[抖音火花助手] Background Service Worker 已启动 (v1.5.0)");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "CALL_DEEPSEEK") {
    handleDeepSeekChat(request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message || "请求异常" }));
    return true;
  }

  if (request.action === "TEST_API_KEY") {
    testApiKey(request.apiKey)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message || "请求异常" }));
    return true;
  }

  // 【01 & 02】聊天前：检索相关记忆 + 读取自我档案 (含 7 天衰减与命中增权)
  if (request.action === "GET_MEMORY_CONTEXT") {
    getMemoryContextForChat(request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // 【03 & EX】回答后：异步筛选值得记的事 -> 写入或纠正 -> 失败入队重试
  if (request.action === "AFTER_REPLY_ORGANIZE") {
    organizeMemoryAfterReply(request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * 计算 7 天半衰期有效权重 (浏览器本地兜底副本使用)
 */
function calcEffectiveWeight(mem, now = Date.now()) {
  const lastTime = mem.lastHitAt || mem.createdAt || now;
  const daysElapsed = Math.max(0, (now - lastTime) / (1000 * 3600 * 24));
  const baseWeight = typeof mem.weight === "number" ? mem.weight : 1.0;
  const effectiveWeight = Number((baseWeight * Math.pow(0.5, daysElapsed / 3.5)).toFixed(3));
  return { effectiveWeight, daysElapsed: Number(daysElapsed.toFixed(2)) };
}

/**
 * 【01 / 先找相关记忆】+【02 / 本地记忆 & 自我档案】
 */
async function getMemoryContextForChat({ friend, queryText, apiKey }) {
  // 优先从本地 d:\chat\memory_vault (Vault Bridge) 读取最新 Markdown 原文与索引
  try {
    const url = `${VAULT_BRIDGE_URL}/vault/read?friend=${encodeURIComponent(friend || "当前好友")}&q=${encodeURIComponent(queryText || "")}`;
    const resp = await fetch(url, { method: "GET" });
    if (resp.ok) {
      const data = await resp.json();
      // 【EX / 失败与待处理】如果发现上次有未同步成功的待处理对话，顺手在后台异步重试
      if (data.pendingQueue && data.pendingQueue.length > 0 && apiKey) {
        retryPendingQueue(data.pendingQueue, apiKey).catch(() => {});
      }
      return {
        success: true,
        source: "local_vault",
        selfProfile: data.selfProfile || "",
        manualNotes: data.manualNotes || "",
        memories: data.memories || []
      };
    }
  } catch (e) {
    // 若本地 Vault Bridge 未启动，无缝回退到 chrome.storage.local 内置记忆库
  }

  // 浏览器内置存储回退
  return new Promise((resolve) => {
    chrome.storage.local.get(["dy_spark_memories"], (res) => {
      const all = Array.isArray(res.dy_spark_memories) ? res.dy_spark_memories : [];
      const now = Date.now();
      const matched = [];

      for (const m of all) {
        if (m.friend !== friend && !friend.includes(m.friend)) continue;
        const { effectiveWeight, daysElapsed } = calcEffectiveWeight(m, now);
        if (daysElapsed > 8 && effectiveWeight < 0.2) continue;

        let boost = 0;
        if (queryText && m.fact && queryText.includes(m.fact.slice(0, 3))) {
          boost = 1.2;
          m.weight = Math.min(5.0, Number(((m.weight || 1.0) + 0.5).toFixed(2)));
          m.lastHitAt = now;
          m.hitCount = (m.hitCount || 1) + 1;
        }
        matched.push({ ...m, effectiveWeight, score: effectiveWeight + boost });
      }

      chrome.storage.local.set({ dy_spark_memories: all });
      matched.sort((a, b) => b.score - a.score);
      resolve({
        success: true,
        source: "chrome_storage",
        selfProfile: "",
        manualNotes: "",
        memories: matched.slice(0, 5)
      });
    });
  });
}

/**
 * 【03 / 回答后的整理】：筛选值得记的事 -> 写入或纠正 Basic Memory -> 同步关联 Markdown
 * 【EX / 失败与待处理】：若失败则写入 pending_sync.json，下次聊天自动重试
 */
async function organizeMemoryAfterReply({ apiKey, friend, personaName, userText, botReply, extraFact }) {
  // 如果有明确的事件事实（比如刚刚评论了死党的视频或分享了视频），直接写入无需大模型筛选
  if (extraFact) {
    await saveFactsToVault(friend, personaName, [{ topic: "互动事件", fact: extraFact, tags: ["视频互动"] }]);
    return { success: true, saved: [extraFact] };
  }

  if (!apiKey || !userText || userText.length < 3) {
    return { success: true, saved: [] };
  }

  // 忽略纯表情包或极短无信息量的语气词（省 Token 且防止垃圾记忆污染）
  if (/^(\[发来表情包|\[发来一个表情包|\?|？|1+|6+|哈哈+|哦|嗯|好)$/.test(userText.trim())) {
    return { success: true, saved: [] };
  }

  const extractPrompt = `你是一个記憶提炼引擎（对应架构图 03/筛选值得记的事）。
请分析以下这一轮抖音私信对话，判断其中是否包含值得在未来7天记住的【客观事实、对方近况、喜好、黑历史、外号、正在做的事、玩的游戏、约定的事】。
【严格过滤】日常无营养寒暄、单纯互骂脏话、表情包互动一律忽略，返回空数组 []！
如果确实有值得记的事实，请输出 JSON 数组格式（最多1~2条，每条简练在20字以内）：
[{"topic": "主题分类", "fact": "简练事实描述", "tags": ["关键词1", "关键词2"]}]
只输出纯 JSON 数组，不要任何多余解释。`;

  try {
    const res = await handleDeepSeekChat({
      apiKey,
      messages: [
        { role: "system", content: extractPrompt },
        { role: "user", content: `好友[${friend}]说：${userText}\n我回复：${botReply}` }
      ],
      temperature: 0.2,
      presence_penalty: 0,
      frequency_penalty: 0
    });

    if (!res.success || !res.reply) {
      throw new Error(res.error || "提炼响应为空");
    }

    const jsonMatch = res.reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { success: true, saved: [] };
    }

    const facts = JSON.parse(jsonMatch[0]);
    if (Array.isArray(facts) && facts.length > 0) {
      await saveFactsToVault(friend, personaName, facts);
      return { success: true, saved: facts };
    }
    return { success: true, saved: [] };
  } catch (err) {
    // 【EX / 失败与待处理】：提炼或写入失败，保存进待处理队列，下次聊天重试
    await saveToPendingQueue({ friend, personaName, userText, botReply, error: err.message });
    return { success: false, error: err.message, queued: true };
  }
}

/**
 * 写入本地 Vault (d:\chat\memory_vault) 与浏览器 Storage 双备份
 */
async function saveFactsToVault(friend, personaName, facts) {
  // 1. 写入本地 d:\chat\memory_vault 文件夹
  try {
    await fetch(`${VAULT_BRIDGE_URL}/vault/upsert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friend, personaName, facts })
    });
  } catch (e) {
    // 忽略本地服务未开异常
  }

  // 2. 同步写入 chrome.storage.local
  return new Promise((resolve) => {
    chrome.storage.local.get(["dy_spark_memories"], (res) => {
      const all = Array.isArray(res.dy_spark_memories) ? res.dy_spark_memories : [];
      const now = Date.now();
      for (const item of facts) {
        const factText = (typeof item === "string" ? item : item.fact || "").trim();
        if (!factText) continue;
        const existing = all.find((m) => m.friend === friend && (m.fact === factText || (item.topic && m.topic === item.topic)));
        if (existing) {
          existing.fact = factText;
          existing.weight = Math.min(5.0, Number(((existing.weight || 1.0) + 0.6).toFixed(2)));
          existing.lastHitAt = now;
          existing.hitCount = (existing.hitCount || 1) + 1;
        } else {
          all.push({
            id: "mem_" + now + "_" + Math.random().toString(36).slice(2, 6),
            friend,
            topic: item.topic || "日常",
            fact: factText,
            tags: item.tags || [],
            weight: 1.2,
            createdAt: now,
            lastHitAt: now,
            hitCount: 1
          });
        }
      }
      chrome.storage.local.set({ dy_spark_memories: all }, () => resolve(true));
    });
  });
}

async function saveToPendingQueue(item) {
  try {
    await fetch(`${VAULT_BRIDGE_URL}/vault/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", item })
    });
  } catch (e) {}
}

async function retryPendingQueue(queue, apiKey) {
  if (!Array.isArray(queue) || queue.length === 0) return;
  try {
    await fetch(`${VAULT_BRIDGE_URL}/vault/pending`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" })
    });
    const lastItem = queue[queue.length - 1];
    await organizeMemoryAfterReply({ ...lastItem, apiKey });
  } catch (e) {}
}

/**
 * 调用 DeepSeek 对话接口
 */
async function handleDeepSeekChat({
  apiKey,
  messages,
  temperature = 1.2,
  presence_penalty = 0.9,
  frequency_penalty = 0.9
}) {
  if (!apiKey || !apiKey.trim()) {
    return { success: false, error: "未配置 DeepSeek API Key" };
  }

  const cleanKey = apiKey.trim();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cleanKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: messages,
        temperature: temperature,
        top_p: 0.95,
        presence_penalty: presence_penalty,
        frequency_penalty: frequency_penalty,
        max_tokens: 90
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `API 请求失败 (HTTP ${response.status})`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.error && errJson.error.message) {
          errMsg = errJson.error.message;
        }
      } catch (e) {
        errMsg = errText || errMsg;
      }
      return { success: false, error: errMsg };
    }

    const data = await response.json();
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
      let reply = data.choices[0].message.content.trim();
      reply = reply.replace(/^["'“‘]|["'”’]$/g, "");
      reply = reply.replace(/[。~～]+$/g, "");
      return { success: true, reply };
    } else {
      return { success: false, error: "模型未返回有效回复内容" };
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return { success: false, error: "请求 DeepSeek 超时 (20s)" };
    }
    return { success: false, error: `网络请求异常: ${error.message}` };
  }
}

async function testApiKey(apiKey) {
  return await handleDeepSeekChat({
    apiKey: apiKey,
    messages: [
      { role: "system", content: "你是一个助手。" },
      { role: "user", content: "测试连接，请回复：ok" }
    ],
    temperature: 0.1,
    presence_penalty: 0,
    frequency_penalty: 0
  });
}
