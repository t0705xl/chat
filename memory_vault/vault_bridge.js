// 本地记忆库同步桥 (Vault Bridge Server) - 实时读写 d:\chat\memory_vault 下的 Markdown 与索引
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 18991;
const VAULT_DIR = __dirname;
const FRIENDS_DIR = path.join(VAULT_DIR, "friends");
const SELF_PROFILE_PATH = path.join(VAULT_DIR, "self_profile.md");
const INDEX_PATH = path.join(VAULT_DIR, "memory_index.json");
const PENDING_PATH = path.join(VAULT_DIR, "pending_sync.json");

if (!fs.existsSync(FRIENDS_DIR)) {
  fs.mkdirSync(FRIENDS_DIR, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    console.error("读取 JSON 失败:", filePath, e.message);
  }
  return fallback;
}

function writeJsonSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("写入 JSON 失败:", filePath, e.message);
    return false;
  }
}

function sanitizeFileName(name) {
  return (name || "未命名好友").replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名好友";
}

/**
 * 计算 7 天动态衰减后的有效权重
 * 半衰期 3.5 天：effectiveWeight = weight * (0.5 ^ (daysElapsed / 3.5))
 */
function computeEffectiveWeight(mem, now = Date.now()) {
  const lastTime = mem.lastHitAt || mem.createdAt || now;
  const daysElapsed = Math.max(0, (now - lastTime) / (1000 * 3600 * 24));
  const baseWeight = typeof mem.weight === "number" ? mem.weight : 1.0;
  const effective = baseWeight * Math.pow(0.5, daysElapsed / 3.5);
  return {
    effectiveWeight: Number(effective.toFixed(3)),
    daysElapsed: Number(daysElapsed.toFixed(2))
  };
}

/**
 * 同步更新好友的 Obsidian Markdown 笔记文件 (friends/<好友名>.md)
 */
function syncFriendMarkdownFile(friendName, friendMemories, personaName = "") {
  const safeName = sanitizeFileName(friendName);
  const mdPath = path.join(FRIENDS_DIR, `${safeName}.md`);

  // 如果已有文件且包含【手动档案备注】区块，保留用户手动编写的内容
  let manualNotes = "- （可在此处手动添加该好友的外号、黑历史、共同经历，AI聊天时会优先读取）";
  if (fs.existsSync(mdPath)) {
    const existing = fs.readFileSync(mdPath, "utf8");
    const match = existing.match(/## 📌 手动档案备注[\r\n]+([\s\S]*?)(?=[\r\n]+## 🧠 AI 动态记忆列表|$)/);
    if (match && match[1].trim()) {
      manualNotes = match[1].trim();
    }
  }

  const now = Date.now();
  const activeLines = [];
  const archivedLines = [];

  friendMemories.forEach((m) => {
    const { effectiveWeight, daysElapsed } = computeEffectiveWeight(m, now);
    const dateStr = new Date(m.lastHitAt || m.createdAt || now).toLocaleString("zh-CN", { hour12: false });
    const line = `- **[权重 ${effectiveWeight} | 初始 ${m.weight} | 提及 ${m.hitCount || 1}次]** ${m.fact} *(更新于: ${dateStr}, 距今 ${daysElapsed} 天)*`;
    if (daysElapsed <= 7 && effectiveWeight >= 0.25) {
      activeLines.push(line);
    } else {
      archivedLines.push(line);
    }
  });

  const mdContent = `# 好友记忆档案：${friendName}
> 所属人格分组：\`${personaName || "自动匹配"}\` | 最后同步：${new Date().toLocaleString("zh-CN", { hour12: false })}

## 📌 手动档案备注
${manualNotes}

## 🧠 AI 动态记忆列表 (7天活跃期内)
${activeLines.length > 0 ? activeLines.join("\n") : "- 暂无活跃动态记忆"}

## 🗄️ 已降权归档记忆 (>7天未提及或低权重)
${archivedLines.length > 0 ? archivedLines.join("\n") : "- 暂无归档记忆"}
`;

  fs.writeFileSync(mdPath, mdContent, "utf8");
  return manualNotes;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 1. 读取自我档案 + 指定好友的活跃记忆 + 待处理重试队列
  if (req.method === "GET" && urlObj.pathname === "/vault/read") {
    const friend = urlObj.searchParams.get("friend") || "当前好友";
    const query = (urlObj.searchParams.get("q") || "").trim();

    const selfProfile = fs.existsSync(SELF_PROFILE_PATH)
      ? fs.readFileSync(SELF_PROFILE_PATH, "utf8")
      : "";

    const indexData = readJsonSafe(INDEX_PATH, { memories: [] });
    const pendingData = readJsonSafe(PENDING_PATH, { pendingQueue: [] });

    const now = Date.now();
    const allMemories = Array.isArray(indexData.memories) ? indexData.memories : [];

    // 筛选该好友的记忆，并计算 7 天动态衰减权重
    const friendMemories = [];
    const hitIds = [];

    for (const m of allMemories) {
      if (m.friend !== friend && !friend.includes(m.friend) && !m.friend.includes(friend)) continue;
      const { effectiveWeight, daysElapsed } = computeEffectiveWeight(m, now);
      // 超过 8 天且有效权重低于 0.2 的记忆不再带入上下文
      if (daysElapsed > 8 && effectiveWeight < 0.2) continue;

      // 检查当前聊天消息是否命中了该条记忆的关键词（命中则增权）
      let relevanceBoost = 0;
      if (query && m.fact) {
        const keywords = (m.tags || []).concat(m.fact.match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) || []);
        for (const kw of keywords) {
          if (kw.length >= 2 && query.includes(kw)) {
            relevanceBoost += 1.5;
            hitIds.push(m.id);
            break;
          }
        }
      }

      friendMemories.push({
        ...m,
        effectiveWeight,
        daysElapsed,
        score: effectiveWeight + relevanceBoost
      });
    }

    // 如果有命中的记忆，执行自动增权 (Boost)
    if (hitIds.length > 0) {
      for (const m of allMemories) {
        if (hitIds.includes(m.id)) {
          m.weight = Math.min(5.0, Number(((m.weight || 1.0) + 0.5).toFixed(2)));
          m.lastHitAt = now;
          m.hitCount = (m.hitCount || 1) + 1;
        }
      }
      writeJsonSafe(INDEX_PATH, indexData);
    }

    // 按综合得分排序，只取最相关的前 5 条（“带入少量上下文”）
    friendMemories.sort((a, b) => b.score - a.score);
    const topMemories = friendMemories.slice(0, 5);

    // 读取该好友 .md 文件里的手动档案备注
    const safeName = sanitizeFileName(friend);
    const mdPath = path.join(FRIENDS_DIR, `${safeName}.md`);
    let manualNotes = "";
    if (fs.existsSync(mdPath)) {
      const existing = fs.readFileSync(mdPath, "utf8");
      const match = existing.match(/## 📌 手动档案备注[\r\n]+([\s\S]*?)(?=[\r\n]+## 🧠 AI 动态记忆列表|$)/);
      if (match && match[1].trim() && !match[1].includes("可在此处手动添加")) {
        manualNotes = match[1].trim();
      }
    }

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        success: true,
        selfProfile,
        manualNotes,
        memories: topMemories,
        pendingQueue: pendingData.pendingQueue || []
      })
    );
    return;
  }

  // 2. 轮后整理：写入或纠正记忆 (Basic Memory Upsert) + 同步生成好友 Markdown 笔记
  if (req.method === "POST" && urlObj.pathname === "/vault/upsert") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const friend = payload.friend || "当前好友";
        const personaName = payload.personaName || "";
        const facts = Array.isArray(payload.facts) ? payload.facts : [];

        const indexData = readJsonSafe(INDEX_PATH, { version: "1.0", memories: [] });
        if (!Array.isArray(indexData.memories)) indexData.memories = [];

        const now = Date.now();

        for (const item of facts) {
          const factText = (typeof item === "string" ? item : item.fact || "").trim();
          if (!factText || factText.length < 3) continue;
          const tags = Array.isArray(item.tags) ? item.tags : [];

          // 查找是否已有相同好友的相似记忆（纠正/合并增权）
          const existing = indexData.memories.find(
            (m) =>
              m.friend === friend &&
              (m.fact === factText ||
                m.fact.includes(factText) ||
                factText.includes(m.fact) ||
                (item.topic && m.topic === item.topic))
          );

          if (existing) {
            existing.fact = factText; // 用最新事实纠正旧事实
            existing.weight = Math.min(5.0, Number(((existing.weight || 1.0) + 0.6).toFixed(2)));
            existing.lastHitAt = now;
            existing.hitCount = (existing.hitCount || 1) + 1;
            if (tags.length > 0) existing.tags = Array.from(new Set([...(existing.tags || []), ...tags]));
          } else {
            indexData.memories.push({
              id: "mem_" + now + "_" + Math.random().toString(36).slice(2, 6),
              friend: friend,
              topic: item.topic || "日常",
              fact: factText,
              tags: tags,
              weight: 1.2,
              createdAt: now,
              lastHitAt: now,
              hitCount: 1
            });
          }
        }

        writeJsonSafe(INDEX_PATH, indexData);

        // 同步更新该好友的 Markdown 笔记文件
        const friendAllMems = indexData.memories.filter((m) => m.friend === friend);
        syncFriendMarkdownFile(friend, friendAllMems, personaName);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: true, totalCount: friendAllMems.length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 3. EX / 失败与待处理队列保存与清空
  if (req.method === "POST" && urlObj.pathname === "/vault/pending") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const pendingData = readJsonSafe(PENDING_PATH, { pendingQueue: [] });
        if (payload.action === "clear") {
          pendingData.pendingQueue = [];
          pendingData.lastRetryAt = new Date().toISOString();
        } else if (payload.item) {
          pendingData.pendingQueue.push({
            ...payload.item,
            failedAt: Date.now()
          });
          if (pendingData.pendingQueue.length > 30) pendingData.pendingQueue.shift();
          pendingData.lastFailedAt = new Date().toISOString();
        }
        writeJsonSafe(PENDING_PATH, pendingData);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: true, queueLength: pendingData.pendingQueue.length }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[抖音火花助手 - 本地记忆库服务] 已启动: http://127.0.0.1:${PORT}`);
  console.log(`[记忆文件夹路径] ${VAULT_DIR}`);
});
