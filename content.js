// 抖音火花助手 - 深度语义接话 + 全尺寸表情包感知 + 高并发防罢工引擎 (v1.9.0)
(function () {
  let isProcessing = false;
  let processingStartTime = 0;
  let sparkCheckTimer = null;
  let lastSparkSentDate = "";

  // 记录已经成功回复过的【对方消息 DOM 节点集合】+ 文本签名双重校验（防虚拟列表复用节点导致罢工）
  let repliedDomElements = new WeakSet();
  let lastSendTimestamp = 0;
  let lastSwitchedFriendName = "";
  const recentBotReplies = [];

  // 表情包与图片视觉描述内存缓存（src Clean Key -> 描述，跨轮次持久保持，防止历史消息失忆丢失画面）
  const localMediaDescCache = new Map();
  function cacheMediaDescription(key, desc) {
    if (!key || !desc) return;
    if (localMediaDescCache.size > 600) {
      const firstKey = localMediaDescCache.keys().next().value;
      if (firstKey) localMediaDescCache.delete(firstKey);
    }
    localMediaDescCache.set(key, desc);
  }

  const REPLY_VARIATION_SEEDS = [
    "【语气节奏】先紧扣对方这句话的具体内容接话，再顺势调侃或反问一句，短促自然（4~15字）",
    "【语气节奏】针对对方刚聊到的具体事情直接给反应（赞同/拆台/吐槽），像真人手机随手秒回，可带1个表情如[狗头][裂开]",
    "【语气节奏】抓准对方话里的重点或笑点精准接梗，口语化接地气，绝不答非所问",
    "【语气节奏】直接回应对方说的事，顺带损他一句或问个细节，可搭配[捂脸][泣不成声][白眼]",
    "【语气节奏】像熟人唠嗑一样顺着话茬往下聊，干脆利落，绝不背诵套话"
  ];

  const CHECK_INTERVAL = 1100;

  function setProcessingLock(state) {
    isProcessing = state;
    processingStartTime = state ? Date.now() : 0;
  }

  /**
   * 双重校验某条对方消息是否已经回复过：
   * 既检查 WeakSet 节点引用，又核对节点上的文本签名，防止抖音消息过多时虚拟列表复用 DOM 节点导致“消息太多罢工”！
   */
  function isMessageAlreadyReplied(msg) {
    if (!msg || !msg.element) return false;
    if (!repliedDomElements.has(msg.element)) return false;
    const savedSig = msg.element.dataset ? msg.element.dataset.dySparkRepliedSig : "";
    return savedSig === msg.text;
  }

  function markMessageReplied(msg) {
    if (!msg || !msg.element) return;
    repliedDomElements.add(msg.element);
    if (msg.element.dataset) {
      msg.element.dataset.dySparkRepliedSig = msg.text;
      delete msg.element.dataset.dySparkMidFlight;
    }
  }

  /**
   * 确保私信滚动容器始终滚到底部，并自动点击“新消息/回到底部”悬浮提示，防止消息太多溢出视口底部而罢工
   */
  function ensureChatScrolledToBottom(scrollContainer) {
    if (!scrollContainer) return;
    try {
      const scrollables = [scrollContainer, ...Array.from(scrollContainer.querySelectorAll("div"))];
      for (const el of scrollables) {
        if (el.scrollHeight > el.clientHeight + 16) {
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (gap > 8 && gap < 2500) {
            el.scrollTop = el.scrollHeight;
          }
        }
      }
      // 如果聊天窗底部出现了“X条新消息”或“回到底部”按钮，自动点一下
      const btns = scrollContainer.parentElement
        ? scrollContainer.parentElement.querySelectorAll("div, span, button")
        : [];
      for (const b of btns) {
        if (b.children.length > 2) continue;
        const t = (b.innerText || "").trim();
        if (/^\d+条新消息$|^新消息$|^回到底部$/.test(t)) {
          simulateRealClick(b);
          break;
        }
      }
    } catch (e) {}
  }

  function init() {
    if (window.DySparkUI) {
      window.DySparkUI.runDiagnose = runDiagnose;
      window.DySparkUI.forceReplyCurrent = forceReplyCurrent;
      window.DySparkUI.watchCurrentVideo = watchCurrentVideo;
      window.DySparkUI.commentOnCurrentVideo = commentOnCurrentVideo;
      window.DySparkUI.shareCurrentVideoToBro = shareCurrentVideoToBro;
    }

    loadPersistedStyleData();
    installDomWakeObserver();
    scheduleTick(800);
    sparkCheckTimer = setInterval(checkDailySpark, 60 * 1000);
  }

  // ==========================================================================
  // ⚙️ 串行调度器：同一时刻只跑一个任务，上一个回复没结束绝不开始下一个（根治高频多人聊天死机）
  // ==========================================================================
  const IDLE_INTERVAL = 1500;
  const JOB_HARD_TIMEOUT = 40000;
  let tickTimer = null;
  let tickRunning = false;
  let wakeRequested = false;
  let nextTickDueAt = 0;
  let lastRedDotScanAt = 0;
  const friendLastServedAt = new Map();

  function scheduleTick(delay) {
    clearTimeout(tickTimer);
    nextTickDueAt = Date.now() + delay;
    tickTimer = setTimeout(runTick, delay);
  }

  function requestSoonTick() {
    if (tickRunning) {
      wakeRequested = true;
      return;
    }
    if (nextTickDueAt - Date.now() > 350) {
      scheduleTick(300);
    }
  }

  function installDomWakeObserver() {
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        requestSoonTick();
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function withHardTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时(${ms / 1000}s)，已自动放弃`)), ms))
    ]);
  }

  async function runTick() {
    if (tickRunning) {
      wakeRequested = true;
      return;
    }
    tickRunning = true;
    let nextDelay = IDLE_INTERVAL;
    try {
      nextDelay = await withHardTimeout(mainLoop(), JOB_HARD_TIMEOUT, "本轮任务");
    } catch (e) {
      if (window.DySparkUI) window.DySparkUI.log(`⚠ ${e.message}`, "warn");
      setProcessingLock(false);
      nextDelay = 800;
    } finally {
      tickRunning = false;
      if (wakeRequested) {
        wakeRequested = false;
        nextDelay = Math.min(nextDelay || IDLE_INTERVAL, 200);
      }
      scheduleTick(typeof nextDelay === "number" ? nextDelay : IDLE_INTERVAL);
    }
  }

  // ==========================================================================
  // 🧬 风格学习：区分“AI 发的”和“你本人亲手打的”消息，用你本人的真实说话样本去校准 AI 口吻
  // ==========================================================================
  const STYLE_STORE_KEY = "dy_spark_style_data";
  let botSentTexts = new Set();
  let ownStyleSamples = [];
  const recentBotRepliesByFriend = new Map();
  let styleSaveTimer = null;

  function loadPersistedStyleData() {
    try {
      chrome.storage.local.get([STYLE_STORE_KEY], (res) => {
        const data = (res && res[STYLE_STORE_KEY]) || {};
        botSentTexts = new Set(Array.isArray(data.botSent) ? data.botSent : []);
        ownStyleSamples = Array.isArray(data.ownSamples) ? data.ownSamples : [];
      });
    } catch (e) {}
  }

  function persistStyleDataSoon() {
    clearTimeout(styleSaveTimer);
    styleSaveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({
          [STYLE_STORE_KEY]: {
            botSent: Array.from(botSentTexts).slice(-400),
            ownSamples: ownStyleSamples.slice(-60)
          }
        });
      } catch (e) {}
    }, 1500);
  }

  function normalizeForCompare(t) {
    return (t || "").replace(/\s+/g, "").trim();
  }

  function recordBotReply(text, friendName = "") {
    if (!text) return;
    const clean = text.replace(/[\r\n\t]/g, " ").trim();
    if (!clean) return;
    recentBotReplies.push(clean);
    if (recentBotReplies.length > 12) recentBotReplies.shift();

    if (friendName) {
      const list = recentBotRepliesByFriend.get(friendName) || [];
      list.push(clean);
      if (list.length > 8) list.shift();
      recentBotRepliesByFriend.set(friendName, list);
    }

    botSentTexts.add(normalizeForCompare(clean));
    persistStyleDataSoon();
  }

  /**
   * 从当前聊天记录里收集“我方气泡但不是 AI 发的” -> 这就是你本人亲手打的字，作为风格样本
   */
  function harvestOwnStyleSamples(messages) {
    let changed = false;
    for (const m of messages) {
      if (!m.isSelf || m.msgType !== "text") continue;
      const t = (m.text || "").trim();
      if (t.length < 2 || t.length > 40) continue;
      if (/^\[/.test(t)) continue;
      const key = normalizeForCompare(t);
      if (botSentTexts.has(key)) continue;
      if (ownStyleSamples.some((s) => normalizeForCompare(s) === key)) continue;
      ownStyleSamples.push(t);
      changed = true;
    }
    if (ownStyleSamples.length > 60) ownStyleSamples = ownStyleSamples.slice(-60);
    if (changed) persistStyleDataSoon();
  }

  function pickStyleSamples(n = 12) {
    if (ownStyleSamples.length <= n) return ownStyleSamples.slice();
    const recent = ownStyleSamples.slice(-Math.ceil(n / 2));
    const older = ownStyleSamples.slice(0, -Math.ceil(n / 2));
    const randomOlder = [];
    while (randomOlder.length < n - recent.length && older.length > 0) {
      randomOlder.push(older.splice(Math.floor(Math.random() * older.length), 1)[0]);
    }
    return randomOlder.concat(recent);
  }

  function cleanFriendNameText(raw) {
    if (!raw) return "";
    return raw
      .replace(/🔥\s*\d*/g, "")
      .replace(/[\(（]\d+[\)）]/g, "")
      .replace(/\s+\d+$/g, "")
      .replace(/(刚刚|在线|\d+分钟前|\d+小时前|\d+小时内在线|昨天|今天|置顶|消息|私信)/g, "")
      .trim();
  }

  /**
   * 带超时保护的后台通信封装，彻底杜绝因回调未返回导致的永久卡死宕机！
   */
  function sendMessageWithTimeout(msg, timeoutMs = 10000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve({ success: false, error: "请求超时" });
        }
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { success: false, error: "空响应" });
          }
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ success: false, error: e.message });
        }
      }
    });
  }

  /**
   * 主调度（由串行调度器 await 调用，返回下一次检查的间隔毫秒）
   * 公平轮转：刚回完一个好友后，如果列表里有别人在等，优先去回等得最久的人，避免某个人高频刷屏时其他人一直排不上
   */
  async function mainLoop() {
    if (!window.DySparkUI) return IDLE_INTERVAL;
    const config = window.DySparkUI.getConfig();
    if (!config.enabled || !config.apiKey) return 2500;

    // 手动操作（测试发送/看片/评论）进行中，主循环让路；超过 45 秒视为卡住自动释放
    if (isProcessing) {
      if (processingStartTime > 0 && Date.now() - processingStartTime > 45000) {
        window.DySparkUI.log("⚡ 手动任务锁超时，已自动释放", "warn");
        setProcessingLock(false);
      } else {
        return 600;
      }
    }

    if (Date.now() - lastSendTimestamp < 700) return 500;

    // 第一优先级：当前打开的聊天窗口有未回消息 -> 直接回
    const result = await checkCurrentChat(config);
    if (result === "replied") {
      // 回完后若有别人在排队，下一轮立刻去切换（公平轮转）
      return 250;
    }
    if (result === "busy") {
      return 400;
    }

    // 第二优先级：扫描未读红点并切换（节流：最多每 1.2 秒扫一次全列表，避免页面卡顿）
    if (Date.now() - lastRedDotScanAt < 1200) return 600;
    lastRedDotScanAt = Date.now();

    const switched = autoSwitchByRedDot(config);
    if (switched) {
      invalidateChatCache();
      // 等抖音渲染新会话后再检查（下一轮 tick 会自然处理）
      return 900;
    }

    return IDLE_INTERVAL;
  }

  function isGroupInWhitelist(groupName, config) {
    if (!config || !config.whitelist || !config.whitelist.trim()) {
      return false;
    }
    const allowedList = config.whitelist
      .split(/[,，\n]/)
      .map(s => s.trim())
      .filter(Boolean);

    if (allowedList.length === 0) return false;
    return allowedList.some(item => groupName.includes(item) || item.includes(groupName));
  }

  function detectGroupFromSessionRow(row) {
    if (!row) return false;
    const rawLines = (row.innerText || "")
      .split(/[\n\r]/)
      .map(s => s.trim())
      .filter(Boolean);

    const fullText = rawLines.join(" ");
    if (/\[有人@我\]|\[全体成员\]|群聊|粉丝群/.test(fullText)) return true;
    if (rawLines[0] && /[\(（]\d+[\)）]/.test(rawLines[0])) return true;

    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (/^(\d{1,2}:\d{2}|刚刚|\d+分钟前|\d+小时前|昨天|今天|星期.|\d{1,2}-\d{1,2}|\d+)$/.test(line)) {
        continue;
      }
      if (/^[^:：\s]{1,20}[：:]\s*.+/.test(line)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 判断某个元素是否属于【视频评论区】（用于物理隔离私信聊天框与视频评论框！）
   */
  function isInsideVideoCommentArea(el) {
    let curr = el;
    while (curr && curr !== document.body) {
      const e2e = curr.getAttribute("data-e2e") || "";
      const cls = (curr.className || "").toString();
      if (/comment/i.test(e2e) || /comment-main|comment-list|comment-panel|comment-input|commentPopup/i.test(cls)) {
        return true;
      }
      curr = curr.parentElement;
    }
    const ph = (el.getAttribute("placeholder") || el.innerText || "").trim();
    if (/留下你的精彩评论|善语结善缘|发一条友好的评论|爱评论的人/.test(ph)) {
      return true;
    }
    return false;
  }

  /**
   * 寻找当前【私信聊天输入框】（严格排除视频评论框，防止串台宕机！）
   */
  function findChatInput() {
    const selectors = [
      'div[contenteditable="true"]',
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="私信"]',
      'textarea[placeholder*="消息"]',
      'textarea',
      '[contenteditable="true"]'
    ];

    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        if (el.closest && el.closest("#dy-spark-root")) continue;
        // 物理隔离：如果该输入框在视频评论区内，绝对不作为私信框返回！
        if (isInsideVideoCommentArea(el)) continue;

        const placeholder = (el.getAttribute("placeholder") || "").trim();
        if (placeholder.includes("搜索") || placeholder.includes("感兴趣") || placeholder.includes("评论") || placeholder.includes("善语")) continue;

        const rect = el.getBoundingClientRect();
        if (rect.top < 180) continue;

        if (rect.width > 50 && rect.height > 18 && (el.offsetParent !== null || rect.height > 0)) {
          return el;
        }
      }
    }
    return null;
  }

  function findChatDialogBox(inputEl) {
    if (!inputEl) return null;
    let curr = inputEl.parentElement;
    let bestBox = null;
    while (curr && curr !== document.body) {
      const r = curr.getBoundingClientRect();
      if (r.height >= 280 && r.width >= 240) {
        bestBox = curr;
        const parentRect = curr.parentElement ? curr.parentElement.getBoundingClientRect() : null;
        if (parentRect && parentRect.width > window.innerWidth * 0.88 && r.width < window.innerWidth * 0.85) {
          return curr;
        }
      }
      curr = curr.parentElement;
    }
    return bestBox;
  }

  function findChatScrollContainer(inputEl) {
    if (inputEl) {
      let curr = inputEl.parentElement;
      while (curr && curr !== document.body) {
        let sibling = curr.previousElementSibling;
        while (sibling) {
          const rect = sibling.getBoundingClientRect();
          if (rect.height > 120 && rect.width > 180) {
            return sibling;
          }
          sibling = sibling.previousElementSibling;
        }
        curr = curr.parentElement;
      }
    }

    const fallbacks = [
      '[class*="chat-body"]',
      '[class*="message-list"]',
      '[class*="chat-content"]',
      '[class*="message-container"]',
      '[class*="im-chat"]',
      '[class*="MessageList"]'
    ];
    for (const sel of fallbacks) {
      const el = document.querySelector(sel);
      if (el && !isInsideVideoCommentArea(el) && el.getBoundingClientRect().height > 100) return el;
    }

    return null;
  }

  /**
   * 精准识别当前私信聊天窗口的好友/群聊名称
   */
  function getCurrentFriendName(inputEl, scrollContainer) {
    const config = window.DySparkUI ? window.DySparkUI.getConfig() : {};

    const configuredNames = [];
    if (config && Array.isArray(config.personaGroups)) {
      config.personaGroups.forEach(g => {
        if (g.friends) {
          g.friends.split(/[,，\n]/).map(s => s.trim()).filter(Boolean).forEach(n => configuredNames.push(n));
        }
      });
    }
    if (config && config.whitelist) {
      config.whitelist.split(/[,，\n]/).map(s => s.trim()).filter(Boolean).forEach(n => configuredNames.push(n));
    }

    const dialogBox = findChatDialogBox(inputEl);
    const sContainer = scrollContainer || findChatScrollContainer(inputEl);

    let searchLeft = 0;
    let searchRight = window.innerWidth;
    let searchTopMin = 50;
    let searchTopMax = 260;

    if (sContainer) {
      const sRect = sContainer.getBoundingClientRect();
      searchLeft = sRect.left - 15;
      searchRight = sRect.right + 15;
      searchTopMin = Math.max(40, sRect.top - 85);
      searchTopMax = sRect.top + 65;
    } else if (dialogBox) {
      const dRect = dialogBox.getBoundingClientRect();
      searchLeft = dRect.left - 10;
      searchRight = dRect.right + 10;
      searchTopMin = Math.max(40, dRect.top - 20);
      searchTopMax = dRect.top + 95;
    }

    const headerCandidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (!parent) continue;
      if (parent.closest && parent.closest("#dy-spark-root")) continue;

      const raw = (textNode.nodeValue || "").trim();
      if (!raw) continue;

      const r = parent.getBoundingClientRect();
      if (
        r.width > 5 &&
        r.height > 10 &&
        r.top >= searchTopMin &&
        r.top <= searchTopMax &&
        r.left >= searchLeft &&
        r.right <= searchRight
      ) {
        for (const cfgName of configuredNames) {
          if (raw.includes(cfgName)) {
            return cfgName;
          }
        }

        const cleaned = cleanFriendNameText(raw);
        if (
          cleaned &&
          cleaned.length >= 1 &&
          cleaned.length <= 24 &&
          !/^(消息|私信|抖音|精选|推荐|朋友|我的|直播|搜索|发送|返回|关注|商城|壁纸|通知|投稿|公开课|知识|体育|\d+)$/.test(cleaned) &&
          !/^\d+小时|分钟|在线|刚刚/.test(cleaned)
        ) {
          headerCandidates.push({
            text: cleaned,
            raw: raw,
            top: r.top,
            left: r.left,
            fontSize: parseFloat(window.getComputedStyle(parent).fontSize) || 14
          });
        }
      }
    }

    if (headerCandidates.length > 0) {
      headerCandidates.sort((a, b) => b.fontSize - a.fontSize || a.top - b.top);
      return headerCandidates[0].text;
    }

    if (lastSwitchedFriendName) {
      return lastSwitchedFriendName;
    }

    return "当前好友";
  }

  function detectGroupFromChatWindow(inputEl, scrollContainer, friendName) {
    if (/[\(（]\d+[\)）]/.test(friendName)) return true;

    const sContainer = scrollContainer || findChatScrollContainer(inputEl);
    if (sContainer) {
      const sRect = sContainer.getBoundingClientRect();
      const allSpans = document.querySelectorAll("span, div, p");
      for (const el of allSpans) {
        if (el.closest && el.closest("#dy-spark-root")) continue;
        const r = el.getBoundingClientRect();
        if (
          r.top >= sRect.top - 80 &&
          r.top <= sRect.top + 55 &&
          r.left >= sRect.left - 15 &&
          r.right <= sRect.right + 15
        ) {
          const t = (el.innerText || "").trim();
          if (/[\(（]\d+[\)）]/.test(t) || t.includes("群聊") || t.includes("粉丝群")) {
            return true;
          }
        }
      }
    }

    const cleanName = cleanFriendNameText(friendName);
    if (cleanName && cleanName !== "当前好友") {
      const allRows = document.querySelectorAll("div, li");
      for (const row of allRows) {
        if (row.closest && row.closest("#dy-spark-root")) continue;
        const rRect = row.getBoundingClientRect();
        if (rRect.height >= 45 && rRect.height <= 115 && rRect.width > 150) {
          const firstLine = cleanFriendNameText(((row.innerText || "").split(/[\n\r]/)[0] || ""));
          if (firstLine && (firstLine === cleanName || firstLine.startsWith(cleanName))) {
            if (detectGroupFromSessionRow(row)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  function findUnreadRedDots() {
    const results = [];
    const seenRows = new Set();
    const candidates = document.querySelectorAll("div, span, i, sup");

    for (const el of candidates) {
      if (el.closest && el.closest("#dy-spark-root")) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.top < 75 || rect.top > window.innerHeight) continue;
      if (rect.width < 6 || rect.width > 32 || rect.height < 6 || rect.height > 32) continue;

      const style = window.getComputedStyle(el);
      const bg = style.backgroundColor || "";

      let isRedBg = false;
      const rgbMatch = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (rgbMatch) {
        const r = parseInt(rgbMatch[1], 10);
        const g = parseInt(rgbMatch[2], 10);
        const b = parseInt(rgbMatch[3], 10);
        if (r > 190 && g < 95 && b < 130) {
          isRedBg = true;
        }
      }

      if (!isRedBg) continue;

      let row = el.parentElement;
      while (row && row !== document.body) {
        const rRect = row.getBoundingClientRect();
        if (rRect.height >= 40 && rRect.height <= 120 && rRect.width > 150) {
          if (row.id === "dy-spark-root" || (row.closest && row.closest("#dy-spark-root"))) break;
          if (seenRows.has(row)) break;
          seenRows.add(row);

          const lines = (row.innerText || "").split(/[\n\r]/).map(s => s.trim()).filter(Boolean);
          const friendName = cleanFriendNameText(lines[0]) || "未读会话";
          const isGroup = detectGroupFromSessionRow(row);

          results.push({
            dotElement: el,
            rowElement: row,
            friendName: friendName,
            isGroup: isGroup,
            badgeText: (el.innerText || "").trim()
          });
          break;
        }
        row = row.parentElement;
      }
    }

    return results;
  }

  function simulateRealClick(target) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY
    };
    target.dispatchEvent(new PointerEvent("pointerdown", opts));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    target.dispatchEvent(new PointerEvent("pointerup", opts));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.dispatchEvent(new MouseEvent("click", opts));
  }

  function autoSwitchByRedDot(config) {
    const unreadList = findUnreadRedDots();
    if (unreadList.length === 0) return false;

    const currentInput = findChatInput();
    const currentScroll = findChatScrollContainer(currentInput);
    const currentFriend = currentInput ? getCurrentFriendName(currentInput, currentScroll) : "";

    const candidates = [];
    for (const item of unreadList) {
      if (item.isGroup && !isGroupInWhitelist(item.friendName, config)) {
        continue;
      }
      if (currentFriend && currentFriend !== "当前好友" && (item.friendName === currentFriend || item.friendName.includes(currentFriend))) {
        continue;
      }
      candidates.push(item);
    }

    if (candidates.length === 0) return false;

    // 公平调度（Fair Scheduling）：按上次服务时间排序，优先切给等得最久的好友，彻底防止多好友并发时一人独占或卡死
    candidates.sort((a, b) => {
      const ta = friendLastServedAt.get(a.friendName) || 0;
      const tb = friendLastServedAt.get(b.friendName) || 0;
      return ta - tb;
    });

    const item = candidates[0];
    const typeLabel = item.isGroup ? "白名单群聊" : "个人私聊";
    lastSwitchedFriendName = item.friendName;
    window.DySparkUI.log(`🔴 轮转切换至${typeLabel} [${item.friendName}]...`, "info");

    simulateRealClick(item.rowElement);
    const firstChild = item.rowElement.firstElementChild;
    if (firstChild) simulateRealClick(firstChild);
    return true;
  }

  function tryReturnToListIfNeeded() {
    const sessionRows = Array.from(document.querySelectorAll("div, li")).filter(el => {
      const r = el.getBoundingClientRect();
      return r.height >= 55 && r.height <= 95 && r.width >= 200 && r.width <= 380 && el.querySelector("img");
    });
    if (sessionRows.length >= 3) return;

    const inputEl = findChatInput();
    const scrollContainer = findChatScrollContainer(inputEl);
    if (!inputEl || !scrollContainer) return;

    const msgs = extractMessagesWithGeometry(scrollContainer);
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (!last.isSelf && !isMessageAlreadyReplied(last)) {
        return;
      }
    }

    // 只有当外面真的有其他未读消息或者在单栏弹窗模式时才返回
    const sRect = scrollContainer.getBoundingClientRect();
    const allEls = document.querySelectorAll("svg, button, i, span");
    for (const el of allEls) {
      if (el.closest && el.closest("#dy-spark-root")) continue;
      const r = el.getBoundingClientRect();
      if (
        r.top >= sRect.top - 75 &&
        r.top <= sRect.top + 45 &&
        r.left >= sRect.left - 10 &&
        r.left <= sRect.left + 60 &&
        r.width >= 10 &&
        r.width <= 40
      ) {
        window.DySparkUI.log("↩ 当前好友已回完，退回列表检查下一位好友", "info");
        lastSwitchedFriendName = "";
        simulateRealClick(el);
        return;
      }
    }
  }

  /**
   * 精准判断一个 <img> 是否属于聊天窗口两侧的【用户头像】
   * 头像特征：位于容器最左侧 58px 内或最右侧 58px 内，且接近正方形 (22px~54px)，或带 avatar 类名
   */
  function isChatAvatarImage(img, containerRect) {
    if (!img || img.tagName !== "IMG") return false;
    const ir = img.getBoundingClientRect();
    if (ir.width < 20 || ir.height < 20) return false;

    const alt = (img.getAttribute("alt") || "").trim();
    const cls = ((img.className || "") + " " + (img.parentElement ? img.parentElement.className || "" : "")).toString();
    if (/avatar|头像/i.test(cls) || alt === "头像") {
      return true;
    }

    const isSquare = ir.width >= 22 && ir.width <= 54 && Math.abs(ir.width - ir.height) <= 7;
    if (!isSquare) return false;

    const nearLeftEdge = ir.left - containerRect.left < 58;
    const nearRightEdge = containerRect.right - ir.right < 58;
    return nearLeftEdge || nearRightEdge;
  }

  /**
   * 判定消息归属：【头像左右位置】为第一铁律（避免对方消息因为通用 class 名含 right/sender 被误判为我方消息导致不回复！）
   */
  function analyzeMessageOwnership(targetEl, container, containerRect, containerMidX) {
    let curr = targetEl;
    let bubbleRect = targetEl.getBoundingClientRect();
    let rowElement = targetEl;
    let hasSelfClassOrFlex = false;

    while (curr && curr !== container && curr !== document.body) {
      const cStyle = window.getComputedStyle(curr);
      const cls = (curr.className || "").toString();

      if (/is-me|is_self|message-self|mine/i.test(cls)) {
        hasSelfClassOrFlex = true;
      }
      if (cStyle.flexDirection === "row-reverse" || cStyle.justifyContent === "flex-end" || cStyle.alignSelf === "flex-end") {
        hasSelfClassOrFlex = true;
      }

      const rRect = curr.getBoundingClientRect();
      if (rRect.width < containerRect.width * 0.82 && rRect.width >= bubbleRect.width) {
        bubbleRect = rRect;
      }

      // 第一优先级：寻找这一行消息的头像 <img> 在左边还是右边！
      if (rRect.height >= 24 && rRect.height <= 460) {
        const imgs = curr.querySelectorAll("img");
        const avatars = [];
        for (const img of imgs) {
          if (img === targetEl) continue;
          if (isChatAvatarImage(img, containerRect)) {
            avatars.push(img.getBoundingClientRect());
          }
        }

        if (avatars.length === 1) {
          rowElement = curr;
          const av = avatars[0];
          const avCenterX = av.left + av.width / 2;
          if (avCenterX > containerMidX) {
            return { isSelf: true, reason: "avatar-right", bubbleRect, rowElement };
          } else {
            return { isSelf: false, reason: "avatar-left", bubbleRect, rowElement };
          }
        }
        if (avatars.length > 1) {
          break;
        }
      }

      curr = curr.parentElement;
    }

    if (hasSelfClassOrFlex) {
      return { isSelf: true, reason: "flex-end", bubbleRect, rowElement };
    }

    const distLeft = bubbleRect.left - containerRect.left;
    const distRight = containerRect.right - bubbleRect.right;
    const isSelfByBubble = distRight < distLeft - 5;

    return {
      isSelf: isSelfByBubble,
      reason: isSelfByBubble ? "bubble-right" : "bubble-left",
      bubbleRect,
      rowElement
    };
  }

  function invalidateChatCache() {
    lastSendTimestamp = Date.now();
  }

  /**
   * 调用后台视觉模型解析图片/表情包/动图画面内容 (v2.2.0)
   */
  async function enrichMediaDescriptions(items, visionConfig) {
    if (!visionConfig || !visionConfig.enabled || !visionConfig.apiKey) return;
    if (!Array.isArray(items) || items.length === 0) return;

    for (const m of items) {
      if ((m.msgType === "sticker" || m.msgType === "image" || m.isUnlabeledSticker) && (m.mediaSrc || m.dataUrl)) {
        const cleanKey = (m.mediaSrc || "").split("?")[0] || (m.dataUrl ? m.dataUrl.slice(0, 48) : "");

        // 1. 本地内存命中：直接复用，免发后台请求
        if (cleanKey && localMediaDescCache.has(cleanKey)) {
          const cached = localMediaDescCache.get(cleanKey);
          m.text = `[发来图片/表情包，画面内容: ${cached}]`;
          m.hasSpecificMeaning = true;
          m.isUnlabeledSticker = false;
          if (m.mediaElement && m.mediaElement.dataset) {
            m.mediaElement.dataset.dyStickerMeaning = cached;
          }
          continue;
        }

        // 2. 如果已经通过 React Fiber 拿到了具体的官方贴纸含义，直接使用，无需消耗视觉 API
        if (m.hasSpecificMeaning && m.text && !m.text.includes("发来一个抖音表情") && !m.text.includes("发来一张图片")) {
          continue;
        }

        try {
          const res = await sendMessageWithTimeout(
            {
              action: "DESCRIBE_MEDIA",
              src: m.mediaSrc,
              dataUrl: m.dataUrl || "",
              cacheKey: cleanKey,
              vision: visionConfig
            },
            10000
          );
          if (res && res.success && res.desc) {
            const desc = res.desc.replace(/[\r\n\t]/g, " ").trim();
            if (cleanKey) {
              cacheMediaDescription(cleanKey, desc);
            }
            if (m.mediaElement && m.mediaElement.dataset) {
              m.mediaElement.dataset.dyStickerMeaning = desc;
            }
            m.text = `[发来图片/表情包，画面内容: ${desc}]`;
            m.hasSpecificMeaning = true;
            m.isUnlabeledSticker = false;
            if (window.DySparkUI) {
              window.DySparkUI.log(`👁️ 视觉模型识别画面: "${desc}"`, "info");
            }
          }
        } catch (e) {}
      }
    }
  }

  /**
   * 视觉几何 + 全尺寸表情包/Emoji/动图感知消息解析引擎 (v2.1.0)
   */
  function extractMessagesWithGeometry(container) {
    if (!container) return [];

    const containerRect = container.getBoundingClientRect();
    const containerMidX = containerRect.left + containerRect.width / 2;

    const rawItems = [];
    const seenPositions = new Set();

    // 1. 提取所有文本气泡
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parentEl = textNode.parentElement;
      if (!parentEl) continue;
      if (parentEl.closest && parentEl.closest("#dy-spark-root")) continue;

      const rawText = (textNode.nodeValue || "").trim();
      if (!rawText) continue;

      if (/^(\d{1,2}:\d{2}|昨天|今天|刚刚|\d+分钟前|\d+小时前|星期[一二三四五六日]|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})/.test(rawText) && rawText.length < 16) continue;
      if (/^(已读|未读|送达|发送失败|成为朋友|发送消息|点击查看|置顶|新消息|\d+条新消息|回到底部)/.test(rawText)) continue;
      if (rawText.includes("火花") && rawText.length < 28) continue;
      if (/^\d{2}:\d{2}$/.test(rawText)) continue;

      const range = document.createRange();
      range.selectNodeContents(textNode);
      const textRect = range.getBoundingClientRect();

      if (textRect.width < 4 || textRect.height < 10) continue;
      if (textRect.top < containerRect.top - 10 || textRect.bottom > containerRect.bottom + 90) continue;

      const posKey = `txt_${Math.round(textRect.top / 5)}_${rawText}`;
      if (seenPositions.has(posKey)) continue;
      seenPositions.add(posKey);

      const cleanText = rawText.replace(/[\r\n\t]/g, " ").trim();
      const ownership = analyzeMessageOwnership(parentEl, container, containerRect, containerMidX);

      const distLeft = Math.round(ownership.bubbleRect.left - containerRect.left);
      const distRight = Math.round(containerRect.right - ownership.bubbleRect.right);

      rawItems.push({
        element: ownership.rowElement || parentEl,
        text: cleanText,
        msgType: "text",
        isSelf: ownership.isSelf,
        reason: ownership.reason,
        top: textRect.top,
        bottom: textRect.bottom,
        distLeft: distLeft,
        distRight: distRight
      });
    }

    // 2. 提取所有表情包、抖音小黄脸 Emoji (18px+)、图片、分享视频与 Canvas/动图贴纸
    const mediaElements = container.querySelectorAll("img, video, canvas");
    for (const media of mediaElements) {
      if (media.closest && media.closest("#dy-spark-root")) continue;
      const mRect = media.getBoundingClientRect();

      if (mRect.top < containerRect.top - 10 || mRect.bottom > containerRect.bottom + 90) continue;
      if (mRect.width < 18 || mRect.height < 18) continue;

      // 严格排除两侧的用户头像 <img>！
      if (isChatAvatarImage(media, containerRect)) continue;

      const ownership = analyzeMessageOwnership(media, container, containerRect, containerMidX);
      const mediaSrc = media.currentSrc || media.src || media.getAttribute("src") || "";
      let dataUrl = "";
      if (media.tagName === "CANVAS") {
        try {
          dataUrl = media.toDataURL("image/jpeg", 0.85);
        } catch (e) {}
      }

      const cleanSrc = (mediaSrc || "").split("?")[0];
      const cachedDesc = cleanSrc ? (localMediaDescCache.get(cleanSrc) || "") : "";

      const rawAlt = (
        (media.dataset && media.dataset.dyStickerMeaning) ||
        cachedDesc ||
        media.getAttribute("alt") ||
        media.getAttribute("title") ||
        media.getAttribute("aria-label") ||
        ""
      ).trim();

      if (cachedDesc && media.dataset && !media.dataset.dyStickerMeaning) {
        media.dataset.dyStickerMeaning = cachedDesc;
      }

      // 过滤掉无具体含义的通用占位词（如“动画表情”、“图片”、“表情”）
      const isGenericAlt = /^(表情|\[表情\]|动画表情|\[动画表情\]|图片|\[图片\]|sticker|emoji|image)$/i.test(rawAlt);
      const specificMeaning = isGenericAlt ? "" : rawAlt;

      // 判断是否为小尺寸抖音原生 Emoji（如 [狗头]、[捂脸]，通常 18px~58px）
      if (mRect.width < 60 && mRect.height < 60) {
        if (mRect.left < containerRect.left + 44 || mRect.right > containerRect.right - 44) continue;
        const emojiLabel = specificMeaning
          ? (specificMeaning.startsWith("[") ? specificMeaning : `[${specificMeaning}]`)
          : "[表情]";
        const distLeft = Math.round(ownership.bubbleRect.left - containerRect.left);
        const distRight = Math.round(containerRect.right - ownership.bubbleRect.right);

        rawItems.push({
          element: ownership.rowElement || media,
          text: specificMeaning ? `[发来表情: ${emojiLabel}]` : `[发来一个抖音表情]`,
          inlineEmoji: emojiLabel,
          hasSpecificMeaning: !!specificMeaning,
          isUnlabeledSticker: !specificMeaning,
          mediaSrc: mediaSrc,
          dataUrl: dataUrl,
          mediaElement: media,
          msgType: "sticker",
          isSelf: ownership.isSelf,
          reason: ownership.reason,
          top: mRect.top,
          bottom: mRect.bottom,
          distLeft: distLeft,
          distRight: distRight
        });
        continue;
      }

      // 大尺寸表情包 / 斗图梗图 / 分享视频卡片 (>= 60px)
      const cardParent = media.parentElement ? media.parentElement.parentElement : null;
      const cardText = cardParent ? (cardParent.innerText || "").replace(/[\r\n\t]/g, " ").trim() : "";
      const hasPlayIcon = cardParent && !!cardParent.querySelector("svg");
      const isVideoShare = hasPlayIcon && (mRect.height > 110 || cardText.includes("@"));

      let mediaDesc = "";
      let msgType = "sticker";
      let isUnlabeledSticker = false;
      if (isVideoShare) {
        msgType = "video";
        mediaDesc = cardText ? `[分享了抖音视频: ${cardText.substring(0, 35)}]` : `[分享了一个抖音视频]`;
      } else if (specificMeaning) {
        mediaDesc = `[发来表情包，画面含义: ${specificMeaning}]`;
      } else {
        isUnlabeledSticker = true;
        mediaDesc = `[发来一张图片/表情包/动图]`;
      }

      const distLeft = Math.round(ownership.bubbleRect.left - containerRect.left);
      const distRight = Math.round(containerRect.right - ownership.bubbleRect.right);

      rawItems.push({
        element: ownership.rowElement || media,
        text: mediaDesc,
        hasSpecificMeaning: !!specificMeaning,
        isUnlabeledSticker: isUnlabeledSticker,
        mediaSrc: mediaSrc,
        dataUrl: dataUrl,
        mediaElement: media,
        msgType: msgType,
        isSelf: ownership.isSelf,
        reason: ownership.reason,
        top: mRect.top,
        bottom: mRect.bottom,
        distLeft: distLeft,
        distRight: distRight
      });
    }

    // 3. 兜底检测使用 CSS background-image 渲染的动态贴纸/表情包
    const bgDivs = container.querySelectorAll("div, span");
    for (const div of bgDivs) {
      if (div.closest && div.closest("#dy-spark-root")) continue;
      if (div.children.length > 0 || (div.innerText || "").trim()) continue;
      const dRect = div.getBoundingClientRect();
      if (dRect.width < 54 || dRect.width > 240 || dRect.height < 54 || dRect.height > 240) continue;
      if (dRect.top < containerRect.top - 10 || dRect.bottom > containerRect.bottom + 90) continue;
      if (dRect.left < containerRect.left + 44 || dRect.right > containerRect.right - 44) continue;

      const bgImg = window.getComputedStyle(div).backgroundImage || "";
      if (bgImg && bgImg !== "none" && bgImg.includes("url(")) {
        const bgMatch = bgImg.match(/url\(["']?(.*?)["']?\)/);
        const bgUrl = bgMatch ? bgMatch[1] : "";
        const ownership = analyzeMessageOwnership(div, container, containerRect, containerMidX);
        const alreadyHasRow = rawItems.some(it => it.element === ownership.rowElement);
        if (!alreadyHasRow) {
          rawItems.push({
            element: ownership.rowElement || div,
            text: "[发来一张动态表情包]",
            isUnlabeledSticker: true,
            mediaSrc: bgUrl,
            mediaElement: div,
            msgType: "sticker",
            isSelf: ownership.isSelf,
            reason: ownership.reason,
            top: dRect.top,
            bottom: dRect.bottom,
            distLeft: Math.round(ownership.bubbleRect.left - containerRect.left),
            distRight: Math.round(containerRect.right - ownership.bubbleRect.right)
          });
        }
      }
    }

    rawItems.sort((a, b) => a.top - b.top || a.distLeft - b.distLeft);

    // 4. 仅合并【同一个消息行 DOM 节点 (prev.element === item.element)】内部的文本与行内小表情！
    const merged = [];
    for (const item of rawItems) {
      const prev = merged[merged.length - 1];
      if (prev && prev.element === item.element && prev.isSelf === item.isSelf) {
        if (prev.msgType === "text" && item.inlineEmoji) {
          prev.text = `${prev.text}${item.inlineEmoji}`;
        } else if (prev.inlineEmoji && item.msgType === "text") {
          prev.text = `${prev.inlineEmoji}${item.text}`;
          prev.msgType = "text";
          prev.isUnlabeledSticker = false;
        } else if (prev.inlineEmoji && item.inlineEmoji) {
          prev.text = `[发来表情: ${prev.inlineEmoji}${item.inlineEmoji}]`;
        } else if (prev.msgType === "text" && item.msgType === "text") {
          if (!prev.text.includes(item.text)) {
            prev.text = `${prev.text} ${item.text}`;
          }
        }
        if (!prev.mediaSrc && item.mediaSrc) prev.mediaSrc = item.mediaSrc;
        if (!prev.dataUrl && item.dataUrl) prev.dataUrl = item.dataUrl;
        prev.bottom = Math.max(prev.bottom, item.bottom);
      } else {
        merged.push({ ...item });
      }
    }

    return merged;
  }

  /**
   * 识别对方本轮发来的消息语气（三级情绪镜像检测器）：
   * - AGGRESSIVE: 对方言语带明显攻击性、脏话、侮辱或恶意挑衅 -> 才允许使用低素质粗口互怼！
   * - PLAYFUL: 对方在轻微嘴贫、调侃开玩笑或斗图 -> 用幽默风趣接梗，不骂脏话！
   * - NORMAL: 对方正常说话、问问题、聊日常 -> 必须100%正常好好回复，严禁为了攻击而攻击！
   */
  function analyzeIncomingTone(unreadIncomingList) {
    const combinedText = unreadIncomingList.map(m => m.text).join(" ");

    // 1. 攻击性/骂人/粗口挑衅特征词库
    const aggressiveRegex = /(傻逼|煞笔|沙比|sb|脑瘫|有病|神经病|神金|滚|爬|狗叫|你妈|他妈|tm|cnm|nm|大爷|你爹|我是你爹|叫爸爸|孙子|儿子|废物|菜逼|真菜|垃圾|出生|畜生|铸币|小丑|弱智|智障|去死|死吧|闭嘴|放屁|关你屁事|有屁|眼瞎|瞎了|犯病|发癫|猪吧|狗东西|贱|恶心|傻子|大傻春|白痴|蠢|锤子|揍你|打死你|发怒|便便|吃屎|去吃屎|多吃点屎|喂你吃)/i;
    if (aggressiveRegex.test(combinedText)) {
      return "AGGRESSIVE";
    }

    // 2. 轻微嘴贫/调侃/开玩笑特征
    const playfulRegex = /(哈哈|笑死|笑尿|略略略|嘿嘿|切|啧|就这|不会吧|该不会|吹牛|装逼|老六|坑爹|下饭|抠脚|单身狗|显眼包|666|牛逼|狗头|裂开|捂脸|泣不成声|吃瓜|白眼)/i;
    const allStickers = unreadIncomingList.every(m => m.msgType === "sticker");
    if (playfulRegex.test(combinedText) || allStickers) {
      return "PLAYFUL";
    }

    // 3. 默认：对方在正常好好说话
    return "NORMAL";
  }

  /**
   * 检测对话中是否存在恶意语言陷阱/套路/占便宜/恶心自贬陷阱 (v2.2.0)
   */
  function detectConversationalTrap(unreadIncomingList, historySlice) {
    const unreadText = unreadIncomingList.map(m => m.text).join(" ");
    const recentHistoryText = (historySlice || []).slice(-8).map(m => m.text).join(" ");
    const combinedContext = `${recentHistoryText} | ${unreadText}`;

    // 1. 喂食/吃恶心东西陷阱（如前面有狗拉屎/便便/垃圾图，对方说“喂你吃”、“请你吃”、“你只是想吃”）
    const hasDisgustingContext = /(拉屎|大便|便便|屎|狗屎|猫砂|马桶|垃圾|呕吐|吐了|恶心)/i.test(combinedContext);
    const hasFeedingBait = /(喂你|请你吃|给你吃|喂你吃|尝尝|多吃点|吃饱|好不好吃|香不香|你只是想吃|想吃就直说|是不是想吃|张嘴|吃这个)/i.test(unreadText);
    if (hasDisgustingContext && hasFeedingBait) {
      return {
        isTrap: true,
        type: "FEEDING_POOP_TRAP",
        instruction: "【⚠️ 极度危险圈套：对方在前文发了拉屎/便便/恶心画面后，企图诱导你吃屎或喂你吃！】\n【绝对禁止】：严禁顺从或开玩笑说“我张嘴了”、“你喂吧”、“真香”、“被你看穿了”、“我想吃”！\n【必须反击】：立刻用犀利的损友语气狠狠怼回去，识破对方恶心圈套！例如：“喂你妈呢你自己慢慢吃吧[白眼]”、“恶心不恶心啊你留着当夜宵吧”、“吃你大爷[吐]”、“想喂你自己吃个饱[裂开]”。"
      };
    }

    // 2. 诱导自贬/承认吃恶心东西或想吃
    if (/(你只是想吃|你就是想吃|承认吧|你想吃|吃屎|去吃屎|多吃点屎)/i.test(unreadText)) {
      return {
        isTrap: true,
        type: "ADMIT_EATING_TRAP",
        instruction: "【⚠️ 陷阱提醒：对方逼你承认想吃屎或自贬】\n【绝对禁止】：严禁说“被你看穿了”、“被你发现了”、“对我想吃”！\n【必须反应】：直接反驳驳回，反客为主！（如：“吃你大爷[白眼]”、“我看你想吃想疯了”、“你自己吃撑了吧少甩锅”、“滚一边去[裂开]”）。"
      };
    }

    // 3. 无由投喂或莫名其妙说“喂你吃”
    if (/(喂你吃|喂你|喂一口|给你吃|张嘴喂你)/i.test(unreadText) && !/(饭|面|奶茶|火锅|肯德基|麦当劳|肉|蛋糕|水果)/.test(unreadText)) {
      return {
        isTrap: true,
        type: "SUSPICIOUS_FEEDING",
        instruction: "【⚠️ 防下套提醒：对方突然说要喂你吃/请你吃（动机可疑）】\n【绝对禁止】：严禁无脑答应或张嘴说“我张嘴了”！\n【必须反应】：保持警惕与机敏，带刺调侃或反问（如：“喂什么啊就喂[白眼]”、“你又憋什么坏屁呢”、“喂你大爷”、“拿开拿开，你自己吃”）。"
      };
    }

    // 4. 占辈分便宜/认儿子/叫爹陷阱
    if (/(叫爸爸|叫爹|我是你爹|叫声爹|做我儿子|喊爸爸|叫声爸爸|乖儿子|孙子)/i.test(unreadText)) {
      return {
        isTrap: true,
        type: "FAMILY_HIERARCHY_TRAP",
        instruction: "【⚠️ 辈分陷阱：对方企图占你便宜当爹】\n【绝对禁止】：严禁叫爹、叫爸爸或顺从！\n【必须反应】：直接强势回怼占回辈分！（如：“滚你大爷的我才是你爹”、“做你春秋大梦去吧[狗头]”、“逆子反了天了”、“给你两巴掌清醒清醒[裂开]”）。"
      };
    }

    // 5. 逼学动物叫/侮辱陷阱
    if (/(叫一声|学狗叫|学猫叫|汪一声|汪汪汪|你就是狗|承认你是狗)/i.test(unreadText)) {
      return {
        isTrap: true,
        type: "ANIMAL_TRAP",
        instruction: "【⚠️ 侮辱陷阱：对方让你学狗叫或贬低你是狗】\n【绝对禁止】：严禁发出“汪汪”或承认自己是狗！\n【必须反击】：直接怼回去（如：“你叫一个我听听[白眼]”、“神金吧你”、“咬你一口要不要[狗头]”）。"
      };
    }

    return null;
  }

  /**
   * 构建高拟真、真人说话口吻、情绪对等自适应的对话 Payload (v2.3.0 支持多模态直传与深度去人机)
   */
  function buildHumanizedPayload(persona, allMessages, unreadIncomingList, memoryContext = null, friendName = "", apiProfile = null) {
    const friendReplies = recentBotRepliesByFriend.get(friendName) || recentBotReplies.slice(-5);
    const antiRepeatRule = friendReplies.length > 0
      ? `\n你刚跟对方说过：[${friendReplies.slice(-4).join(" / ")}]，本次禁止复读上面说过的词句或相同句式。`
      : "";

    const userSamples = pickStyleSamples(6);
    const styleSection = userSamples.length > 0
      ? `\n你平时的真实打字口吻参考（短、随性、接地气）：[${userSamples.join(" / ")}]`
      : "";

    let memorySection = "";
    if (memoryContext) {
      if (memoryContext.manualNotes) {
        memorySection += `\n【该好友备注】${memoryContext.manualNotes}`;
      }
      if (Array.isArray(memoryContext.memories) && memoryContext.memories.length > 0) {
        const memLines = memoryContext.memories.map(m => m.fact);
        memorySection += `\n【你们近期的共同经历/记忆(自然融入，别生硬背诵)】${memLines.join("；")}`;
      }
    }

    const incomingTone = analyzeIncomingTone(unreadIncomingList);
    const isRoughPersona = persona.groupId === "bro" || /脏话|损友|死党|互怼|互骂|粗口|傻逼|卧槽|滚/.test(persona.prompt);

    let tonePrompt = "";
    if (incomingTone === "AGGRESSIVE" && isRoughPersona) {
      tonePrompt = `【当前情境】对方先骂人或嘴臭挑衅了。针对他说的具体事情，用损友互损的糙话或粗口直接怼回去，损在点子上。单句短促（4~16字），可带[白眼][裂开][狗头]。`;
    } else if (incomingTone === "PLAYFUL") {
      tonePrompt = `【当前情境】对方在开玩笑、贫嘴或发表情互动。像好朋友一样轻松幽默地接梗或调侃，不用动真格骂脏话，4~16字，带[狗头][捂脸][泣不成声]等。`;
    } else {
      tonePrompt = `【当前情境】对方在正常交流/问问题/聊日常，没有攻击你。像真实好朋友一样自然、靠谱地正面回答，绝对禁止无故骂人或攻击，随性口语（4~18字），不加句号。`;
    }

    // 提取当前未读消息之前的最近 32 条真实历史记录（超长上下文记忆，彻底告别单字短记忆失忆与呆滞断层）
    const historyEndIdx = Math.max(0, allMessages.length - unreadIncomingList.length);
    const historySlice = allMessages.slice(Math.max(0, historyEndIdx - 32), historyEndIdx);
    const lastHistoryTopic = historySlice.length > 0 ? historySlice[historySlice.length - 1].text : "";

    const rawTexts = unreadIncomingList.map(m => m.text);
    const allAreStickers = unreadIncomingList.every(m => m.msgType === "sticker");
    const hasUnlabeledSticker = unreadIncomingList.some(m => m.isUnlabeledSticker);
    const hasSpecificMeaningSticker = unreadIncomingList.some(m => m.hasSpecificMeaning);
    const allAreVideos = unreadIncomingList.every(m => m.msgType === "video");

    let mediaInstruction = "";
    if (hasSpecificMeaningSticker) {
      const meanings = unreadIncomingList.filter(m => m.hasSpecificMeaning).map(m => m.text);
      mediaInstruction = `\n对方发来了表情包/图片：${meanings.join(" ")}。请结合画面里的具体搞怪动作或文字接梗、吐槽或回应，像真人看到朋友发这图时的即时反应！`;
    } else if (allAreStickers) {
      if (hasUnlabeledSticker) {
        mediaInstruction = lastHistoryTopic
          ? `\n对方发了一张自定义图片表情包（看不到画面）。顺着刚才聊的（“${lastHistoryTopic}”）自然接一句，或者随手回个表情（如“笑死我了[泣不成声]”、“服了[捂脸]”、“斗图是吧[狗头]”），严禁乱猜画面！`
          : `\n对方单发了一张表情包。随手回个表情或问一句（如“？[狗头]”、“发这啥意思[捂脸]”、“[狗头][狗头]”），控制在 2~12 字，严禁瞎猜图里画了什么！`;
      }
    } else if (allAreVideos) {
      mediaInstruction = `\n对方分享了抖音视频：${rawTexts.join(" ")}。针对视频内容随口接话或吐槽，4~16字。`;
    }

    // 防套路与反恶搞语言圈套检测
    const trapCheck = detectConversationalTrap(unreadIncomingList, historySlice);
    let trapPrompt = "";
    if (trapCheck && trapCheck.isTrap) {
      trapPrompt = `\n${trapCheck.instruction}`;
      if (window.DySparkUI) {
        window.DySparkUI.log(`🛡️ 识破语言陷阱 [${trapCheck.type}]，已触发防套路防御`, "warn");
      }
    }

    const commonSenseRule = `\n【防套路常识与自尊底线】
1. 严禁掉入对方的恶意或恶搞语言圈套！绝不能答应吃恶心东西、吃屎，对方说“喂你吃/请你吃”恶心东西或前文发了拉屎图，绝不能说“我张嘴了”、“你喂吧”、“被你看穿了”、“我想吃”，必须机敏识破并反怼对方（如“喂你妈呢你自己吃吧”、“恶心不恶心”）；
2. 绝不能被占便宜当儿子或认爹，对方叫你喊爹坚决怼回；
3. 听懂网络热梗与阴阳怪气，结合前文真实历史与表情包画面连贯理解，严禁无脑顺从对方的恶俗调侃。`;

    const antiNpcRules = `\n【🔥 绝杀“人机感”硬核规范（违者视为严重故障）】
1. 【字数短脆，禁止长篇大论】：真人手机打字绝大多数在 3~14 字！偶尔一两句不超过 20 字，严禁发小作文。
2. 【严禁“人机空洞客套”】：绝对禁止“哈哈确实”、“确实啊”、“你说得对”、“好呀”、“那挺好的”、“也是哈”等机器人起手式！
3. 【严禁客服式追问】：绝对不要客套追问“你觉得呢？”、“你在忙什么呀？”、“你今天怎么样？”，自然表达自己的态度或随口唠嗑即可。
4. 【针对笑点直接反应，绝不机械复读】：对方发表情包或聊具体事情，直接给真实情绪反应（赞同/吐槽/拆台/无语/接梗），严禁机械复读对方后半句。
5. 【标点符号规范】：真人私信单句末尾【严禁使用句号“。”】！可以不加标点或空格，随性自然，情绪到位时可带 1 个抖音表情如 [狗头][捂脸][裂开][泣不成声][白眼]。
【输出硬性要求】：只输出你要发给朋友的那一句话本身，严禁任何解释、前缀、引号或AI助理式说明。`;

    const enhancedSystemPrompt = `你是这个抖音号的号主本人，正拿着手机跟朋友私聊。
${persona.prompt}
${tonePrompt}${trapPrompt}${commonSenseRule}${antiNpcRules}${styleSection}${memorySection}${mediaInstruction}${antiRepeatRule}`;

    const isMultimodal = apiProfile ? !!apiProfile.isMultimodal : false;
    const payload = [{ role: "system", content: enhancedSystemPrompt }];

    for (const h of historySlice) {
      const role = h.isSelf ? "assistant" : "user";
      const prevTurn = payload[payload.length - 1];

      // 如果当前是多模态模式且历史该条为近期带图消息
      if (isMultimodal && !h.isSelf && (h.msgType === "sticker" || h.msgType === "image") && (h.dataUrl || h.mediaSrc)) {
        payload.push({
          role: "user",
          content: [
            { type: "text", text: h.text || "[发来表情包/图片]" },
            { type: "image_url", image_url: { url: h.dataUrl || h.mediaSrc } }
          ]
        });
        continue;
      }

      if (prevTurn && prevTurn.role === role && typeof prevTurn.content === "string") {
        prevTurn.content = `${prevTurn.content}，${h.text}`;
      } else {
        payload.push({ role, content: h.text });
      }
    }

    const userMessageContent = rawTexts.join("，");
    const incomingImages = isMultimodal
      ? unreadIncomingList.filter(m => (m.msgType === "sticker" || m.msgType === "image" || m.isUnlabeledSticker) && (m.dataUrl || m.mediaSrc))
      : [];

    if (incomingImages.length > 0) {
      const contentParts = [
        { type: "text", text: userMessageContent || "对方发来了表情包/图片" }
      ];
      for (const img of incomingImages.slice(0, 3)) {
        contentParts.push({
          type: "image_url",
          image_url: { url: img.dataUrl || img.mediaSrc }
        });
      }
      payload.push({ role: "user", content: contentParts });
    } else {
      const lastTurn = payload[payload.length - 1];
      if (lastTurn && lastTurn.role === "user" && typeof lastTurn.content === "string") {
        lastTurn.content = `${lastTurn.content}，${userMessageContent}`;
      } else {
        payload.push({ role: "user", content: userMessageContent });
      }
    }

    return payload;
  }

  /**
   * 模拟打字并发送私信消息
   */
  async function sendMessageToChat(text, friendName = "") {
    recordBotReply(text, friendName);
    lastSendTimestamp = Date.now();

    const inputEl = findChatInput();
    if (!inputEl) {
      throw new Error("未定位到私信聊天输入框");
    }

    inputEl.focus();

    if (inputEl.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      selection.removeAllRanges();
      selection.addRange(range);

      const success = document.execCommand("insertText", false, text);
      if (!success) {
        inputEl.innerText = text;
      }
    } else {
      inputEl.value = text;
    }

    inputEl.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

    await new Promise(r => setTimeout(r, 180));

    let sent = false;
    const sendButtons = Array.from(document.querySelectorAll('button, div[role="button"], span, svg'));
    for (const btn of sendButtons) {
      if (btn.closest && btn.closest("#dy-spark-root")) continue;
      if (isInsideVideoCommentArea(btn)) continue;
      const t = (btn.innerText || btn.getAttribute("title") || btn.getAttribute("aria-label") || "").trim();
      if (t === "发送" || t === "Send" || /send-btn|sendBtn/i.test(btn.className || "")) {
        btn.removeAttribute("disabled");
        simulateRealClick(btn);
        sent = true;
        break;
      }
    }

    if (!sent) {
      const eventOptions = {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      };
      inputEl.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
      inputEl.dispatchEvent(new KeyboardEvent("keypress", eventOptions));
      inputEl.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
    }

    lastSendTimestamp = Date.now();
  }

  /**
   * 从消息列表中收集所有待回复的对方消息：
   * 1. 位于最后一条我方消息之后的所有未回复对方消息；
   * 2. 或者在 AI 思考发消息中途（Mid-Flight）对方插队发来、被我方上条回复顶到上面的未回消息！
   */
  function collectUnreadIncomingMessages(messages) {
    if (!messages || messages.length === 0) return [];

    const unreadIncoming = [];
    // 1. 收集底部我方消息之后的未回对方消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.isSelf) break;
      if (isMessageAlreadyReplied(m)) break;
      unreadIncoming.unshift(m);
    }

    if (unreadIncoming.length > 0) {
      return unreadIncoming;
    }

    // 2. 如果最底部是我方刚发出的回复，检查倒数 6 条内是否有 AI 思考期间对方插队发来的 Mid-Flight 未回消息
    const recentStart = Math.max(0, messages.length - 6);
    for (let i = recentStart; i < messages.length; i++) {
      const m = messages[i];
      if (!m.isSelf && !isMessageAlreadyReplied(m) && m.element && m.element.dataset && m.element.dataset.dySparkMidFlight === "1") {
        unreadIncoming.push(m);
      }
    }

    return unreadIncoming;
  }

  /**
   * 检测当前私信聊天并回复（带视觉解析、风格自适应、公平轮转、防并发死锁）
   */
  async function checkCurrentChat(config) {
    const inputEl = findChatInput();
    if (!inputEl) return false;

    const scrollContainer = findChatScrollContainer(inputEl);
    if (!scrollContainer) return false;

    // 确保聊天滚动条拉到底部，防止消息过多溢出可视区
    ensureChatScrolledToBottom(scrollContainer);

    const friendName = getCurrentFriendName(inputEl, scrollContainer);
    const isGroup = detectGroupFromChatWindow(inputEl, scrollContainer, friendName);

    if (isGroup && !isGroupInWhitelist(friendName, config)) {
      return false;
    }

    let messages = extractMessagesWithGeometry(scrollContainer);
    if (!messages || messages.length === 0) return false;

    // 收集用户亲手打的文本作为风格学习语料
    harvestOwnStyleSamples(messages);

    let unreadIncoming = collectUnreadIncomingMessages(messages);
    if (unreadIncoming.length === 0) {
      return false;
    }

    setProcessingLock(true);

    // 400ms 连发聚合缓冲：对方正在分段发第2、第3句时一次性打包
    await new Promise(r => setTimeout(r, 400));
    ensureChatScrolledToBottom(scrollContainer);
    const refreshedMessages = extractMessagesWithGeometry(scrollContainer);
    const refreshedUnread = collectUnreadIncomingMessages(refreshedMessages);
    if (refreshedUnread.length > 0) {
      messages = refreshedMessages;
      unreadIncoming = refreshedUnread;
    }

    // 视觉模型增强：解析待回复消息中的图片/表情包，同时自动为最近历史切片中未解析的表情包补齐画面描述（最多补2张），确保上下文连贯不失忆
    const visionConfig = window.DySparkUI && window.DySparkUI.getVisionConfig ? window.DySparkUI.getVisionConfig() : null;
    const itemsToEnrich = [...unreadIncoming];
    const historyCandidates = messages
      .slice(Math.max(0, messages.length - unreadIncoming.length - 8), Math.max(0, messages.length - unreadIncoming.length))
      .filter(m => (m.msgType === "sticker" || m.msgType === "image" || m.isUnlabeledSticker) && !m.hasSpecificMeaning && (m.mediaSrc || m.dataUrl));
    for (const hc of historyCandidates.slice(-2)) {
      itemsToEnrich.push(hc);
    }
    await enrichMediaDescriptions(itemsToEnrich, visionConfig);

    const preFlightFriendElements = new Set(
      messages.filter(m => !m.isSelf).map(m => m.element)
    );

    const chatType = isGroup ? "群聊" : "私聊";
    const persona = window.DySparkUI.getPersonaForFriend
      ? window.DySparkUI.getPersonaForFriend(friendName)
      : { groupId: "default", groupName: "默认通用", prompt: config.prompt };

    const displayIncoming = unreadIncoming.map(m => m.text).join(" | ");
    const detectedTone = analyzeIncomingTone(unreadIncoming);
    const toneLabel =
      detectedTone === "AGGRESSIVE"
        ? "🔥 对等反击(对方带攻击性)"
        : detectedTone === "PLAYFUL"
          ? "😄 幽默接梗(对方调侃/斗图)"
          : "🌿 和平正常回复(对方未嘴贫)";

    window.DySparkUI.log(
      `收到${chatType} [${friendName}] ${unreadIncoming.length > 1 ? `(合并${unreadIncoming.length}条) ` : ""}消息: "${displayIncoming}"`,
      "info"
    );
    window.DySparkUI.log(`🎭 人格【${persona.groupName}】| 策略【${toneLabel}】思考中...`, "info");

    try {
      // 1.2秒极速超时检索记忆
      const memRes = await sendMessageWithTimeout(
        {
          action: "GET_MEMORY_CONTEXT",
          friend: friendName,
          queryText: displayIncoming,
          apiKey: config.apiKey
        },
        1200
      );
      const memoryContext = memRes && memRes.success ? memRes : null;

      if (memoryContext && memoryContext.memories && memoryContext.memories.length > 0) {
        window.DySparkUI.log(`🧠 已带入 ${memoryContext.memories.length} 条7天动态记忆`, "info");
      }

      const apiProfile = window.DySparkUI && window.DySparkUI.getActiveApiProfile ? window.DySparkUI.getActiveApiProfile() : null;
      const payload = buildHumanizedPayload(persona, messages, unreadIncoming, memoryContext, friendName, apiProfile);

      // 调用大模型接口（支持自定义多接口与多模态直接看图，带 18 秒超时保护）
      const res = await sendMessageWithTimeout(
        { action: "CALL_CHAT_MODEL", apiProfile, apiKey: config.apiKey, messages: payload },
        18000
      );

      if (res && res.success && res.reply) {
        const cleanReply = res.reply.replace(/[\r\n\t]/g, " ").trim();
        const modelLabel = (apiProfile && apiProfile.name) || "大模型";
        window.DySparkUI.log(`🤖【${modelLabel}】回复: "${cleanReply}"`, "success");

        await sendMessageToChat(cleanReply, friendName);
        unreadIncoming.forEach(m => markMessageReplied(m));

        // 检查 AI 思考期间对方是否又新发了插队消息
        ensureChatScrolledToBottom(scrollContainer);
        const afterSendMessages = extractMessagesWithGeometry(scrollContainer);
        for (const m of afterSendMessages) {
          if (!m.isSelf && !isMessageAlreadyReplied(m) && !preFlightFriendElements.has(m.element)) {
            if (m.element && m.element.dataset) {
              m.element.dataset.dySparkMidFlight = "1";
            }
          }
        }

        window.DySparkUI.log(`✔ 已回复 [${friendName}]！`, "success");

        // 记录该好友服务时间戳（公平轮转调度依据）
        friendLastServedAt.set(friendName, Date.now());

        chrome.runtime.sendMessage({
          action: "AFTER_REPLY_ORGANIZE",
          apiKey: config.apiKey,
          friend: friendName,
          personaName: persona.groupName,
          userText: displayIncoming,
          botReply: cleanReply
        });

        setProcessingLock(false);
        tryReturnToListIfNeeded();
        return "replied";
      } else {
        window.DySparkUI.log(`回复失败(稍后将自动重试): ${res ? res.error : "无响应"}`, "error");
        setProcessingLock(false);
        return "failed";
      }
    } catch (e) {
      window.DySparkUI.log(`异常(稍后将自动重试): ${e.message}`, "error");
      setProcessingLock(false);
      return "failed";
    }
  }

  async function forceReplyCurrent() {
    const config = window.DySparkUI ? window.DySparkUI.getConfig() : {};
    if (!config.apiKey) {
      window.DySparkUI.log("请先配置 DeepSeek API Key", "warn");
      return;
    }

    const inputEl = findChatInput();
    if (!inputEl) {
      window.DySparkUI.log("当前不在具体聊天框内，正在尝试点开未读红点...", "warn");
      autoSwitchByRedDot(config);
      return;
    }

    const scrollContainer = findChatScrollContainer(inputEl);
    ensureChatScrolledToBottom(scrollContainer);
    const friendName = getCurrentFriendName(inputEl, scrollContainer);
    const messages = extractMessagesWithGeometry(scrollContainer);

    const lastMsg = messages.length > 0
      ? messages[messages.length - 1]
      : { text: "在干嘛", msgType: "text", isSelf: false };

    const persona = window.DySparkUI.getPersonaForFriend
      ? window.DySparkUI.getPersonaForFriend(friendName)
      : { groupId: "default", groupName: "默认通用", prompt: config.prompt };

    window.DySparkUI.log(`[测试发送] 好友[${friendName}] 启用人格【${persona.groupName}】...`, "info");
    const visionConfig = window.DySparkUI && window.DySparkUI.getVisionConfig ? window.DySparkUI.getVisionConfig() : null;
    const testItems = [lastMsg];
    const historyCand = messages
      .slice(Math.max(0, messages.length - 6))
      .filter(m => (m.msgType === "sticker" || m.msgType === "image" || m.isUnlabeledSticker) && !m.hasSpecificMeaning && (m.mediaSrc || m.dataUrl));
    for (const hc of historyCand.slice(-2)) testItems.push(hc);
    await enrichMediaDescriptions(testItems, visionConfig);
    const apiProfile = window.DySparkUI && window.DySparkUI.getActiveApiProfile ? window.DySparkUI.getActiveApiProfile() : null;
    const payload = buildHumanizedPayload(persona, messages, [lastMsg], null, friendName, apiProfile);

    const res = await sendMessageWithTimeout(
      { action: "CALL_CHAT_MODEL", apiProfile, apiKey: config.apiKey, messages: payload },
      18000
    );

    if (res && res.success && res.reply) {
      const cleanReply = res.reply.replace(/[\r\n\t]/g, " ").trim();
      markMessageReplied(lastMsg);
      friendLastServedAt.set(friendName, Date.now());
      const modelLabel = (apiProfile && apiProfile.name) || "大模型";
      window.DySparkUI.log(`🤖【${modelLabel}】生成: "${cleanReply}"`, "success");
      try {
        await sendMessageToChat(cleanReply, friendName);
        window.DySparkUI.log("✔ 发送成功！", "success");
      } catch (err) {
        window.DySparkUI.log(`❌ 发送失败: ${err.message}`, "error");
      }
    } else {
      window.DySparkUI.log(`API 失败: ${res ? res.error : "无响应"}`, "error");
    }
  }

  function runDiagnose() {
    const config = window.DySparkUI ? window.DySparkUI.getConfig() : {};
    window.DySparkUI.log("===== 开始全面诊断 (v2.3.0) =====", "info");

    const unread = findUnreadRedDots();
    if (unread.length > 0) {
      unread.forEach(u => {
        const persona = window.DySparkUI.getPersonaForFriend ? window.DySparkUI.getPersonaForFriend(u.friendName) : { groupName: "默认" };
        if (u.isGroup) {
          const allowed = isGroupInWhitelist(u.friendName, config);
          window.DySparkUI.log(
            `🔴 未读[群] ${u.friendName}: ${allowed ? `✔ 放行(${persona.groupName})` : "⏭ 未在群白名单"}`,
            allowed ? "success" : "warn"
          );
        } else {
          window.DySparkUI.log(`🔴 未读[私] ${u.friendName}: ✔ 排队(${persona.groupName})`, "success");
        }
      });
    } else {
      window.DySparkUI.log("ℹ 当前列表未扫描到未读红点", "info");
    }

    const inputEl = findChatInput();
    if (inputEl) {
      const scrollContainer = findChatScrollContainer(inputEl);
      const friend = getCurrentFriendName(inputEl, scrollContainer);
      const isGroup = detectGroupFromChatWindow(inputEl, scrollContainer, friend);
      const allowed = !isGroup || isGroupInWhitelist(friend, config);
      const persona = window.DySparkUI.getPersonaForFriend ? window.DySparkUI.getPersonaForFriend(friend) : { groupName: "默认通用" };

      window.DySparkUI.log(
        `当前窗口好友: [${friend}] (${isGroup ? "群聊" : "私聊"}) -> 🎭 命中【${persona.groupName}】`,
        allowed ? "success" : "warn"
      );

      if (scrollContainer) {
        const msgs = extractMessagesWithGeometry(scrollContainer);
        window.DySparkUI.log(`✔ 解析出 ${msgs.length} 条消息`, "info");
        if (msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          window.DySparkUI.log(
            `最后一条[${last.isSelf ? "我方" : "对方"}](依据:${last.reason}): "${last.text.substring(0, 24)}"`,
            last.isSelf ? "warn" : "success"
          );
        }
      }
    } else {
      window.DySparkUI.log("ℹ 当前未打开私信聊天输入框", "info");
    }

    window.DySparkUI.log("===== 诊断结束 =====", "info");
  }

  // ============================================================================
  // 🎬 视频看片、当前活跃视频专属评论区精准定位与转发模块 (v1.7.0)
  // ============================================================================

  /**
   * 定位当前屏幕正在播放的唯一活跃主视频及其专属 Slide 容器
   * （抖音采用 Swiper 预加载上下多个视频，必须严格筛选出处于视口正中央的 active slide！）
   */
  function findActiveVideoSlide() {
    const videos = Array.from(document.querySelectorAll("video"));
    let activeVideo = null;
    let bestScore = -1;

    const viewportCenterY = window.innerHeight / 2;

    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width < 150 || r.height < 180) continue;
      // 视频中心点必须位于当前屏幕视口内部 (top < 60% 且 bottom > 40%)
      const vCenterY = r.top + r.height / 2;
      if (vCenterY < 50 || vCenterY > window.innerHeight - 50) continue;

      const distFromCenter = Math.abs(vCenterY - viewportCenterY);
      const score = r.width * r.height - distFromCenter * 500;
      if (score > bestScore) {
        bestScore = score;
        activeVideo = v;
      }
    }

    if (!activeVideo) return null;

    // 向上寻找属于这单条视频的独立 Slide 容器（排除包含多个 video 的外层 swiper-wrapper）
    let slide = activeVideo.parentElement;
    let curr = activeVideo.parentElement;
    while (curr && curr !== document.body) {
      const videoCount = curr.querySelectorAll("video").length;
      if (videoCount > 1) {
        // 一旦父容器包含了多个 video，说明上一个 curr 就是当前这单条视频的最大独立 Slide 容器！
        break;
      }
      slide = curr;
      curr = curr.parentElement;
    }

    return { video: activeVideo, slide };
  }

  /**
   * 👁️ AI 深度看当前视频：只从【当前正中央活跃视频 Slide】中提取作者、文案与评论区热评
   */
  async function inspectCurrentVideo(autoOpenComments = true) {
    const active = findActiveVideoSlide();
    if (!active) {
      throw new Error("当前屏幕未检测到正在播放的抖音视频");
    }

    const { video, slide } = active;
    const vRect = video.getBoundingClientRect();

    // 1. 只在当前视频 Slide 内部提取作者昵称
    let author = "";
    const authorSelectors = [
      '[data-e2e="feed-video-nickname"]',
      '[data-e2e="video-author-name"]',
      '[class*="author-card-user-name"]',
      '[class*="account-name"]'
    ];
    for (const sel of authorSelectors) {
      const els = slide.querySelectorAll(sel);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.height > 8 && r.top >= 0 && r.bottom <= window.innerHeight) {
          const t = (el.innerText || "").replace(/^@/, "").trim();
          if (t && t.length < 30) {
            author = cleanFriendNameText(t);
            break;
          }
        }
      }
      if (author) break;
    }

    if (!author) {
      const allTextEls = slide.querySelectorAll("span, div, a");
      for (const el of allTextEls) {
        if (el.children.length > 1) continue;
        const r = el.getBoundingClientRect();
        if (r.top > vRect.bottom - 260 && r.bottom <= vRect.bottom + 20 && r.left >= vRect.left && r.left < vRect.left + 450) {
          const t = (el.innerText || "").trim();
          if (t.startsWith("@") && t.length > 1 && t.length < 28) {
            author = cleanFriendNameText(t.slice(1));
            break;
          }
        }
      }
    }

    // 2. 只在当前视频 Slide 内部提取文案标题
    let desc = "";
    const descSelectors = [
      '[data-e2e="video-desc"]',
      '[class*="video-info-detail"]',
      '[class*="title-wrap"]'
    ];
    for (const sel of descSelectors) {
      const els = slide.querySelectorAll(sel);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.height > 10 && r.top >= vRect.top && r.bottom <= window.innerHeight + 20) {
          const t = (el.innerText || "").replace(/[\r\n\t]+/g, " ").trim();
          if (t && t.length > 2) {
            desc = t;
            break;
          }
        }
      }
      if (desc) break;
    }

    // 3. 确保当前视频的评论区抽屉已打开
    let commentPanel = findVisibleVideoCommentPanel(slide);
    if (!commentPanel && autoOpenComments) {
      const clicked = clickActiveSlideCommentButton(slide);
      if (clicked) {
        await new Promise(r => setTimeout(r, 950));
        commentPanel = findVisibleVideoCommentPanel(slide);
      }
    }

    const topComments = extractVisibleVideoComments(commentPanel);
    return {
      author: author || "未知作者",
      desc: desc || "（无文字标题视频）",
      topComments: topComments.slice(0, 5),
      slide,
      commentPanel
    };
  }

  /**
   * 仅点击【当前活跃视频 Slide】右侧操作栏的“评论”图标
   */
  function clickActiveSlideCommentButton(slide) {
    const commentIconSelectors = [
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="video-comment-icon"]',
      '[class*="comment-icon"]'
    ];
    for (const sel of commentIconSelectors) {
      const els = slide.querySelectorAll(sel);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 15 && r.top > 80 && r.bottom < window.innerHeight) {
          simulateRealClick(el);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 寻找当前屏幕上可见的【视频评论区面板】
   * （优先在当前活跃视频 Slide 内部寻找，其次寻找视口右侧展开的评论区抽屉，严格排除预加载的上下隐藏视频！）
   */
  function findVisibleVideoCommentPanel(activeSlide) {
    const panelSelectors = [
      '[data-e2e="comment-list"]',
      '[class*="comment-mainContent"]',
      '[class*="comment-panel"]',
      '[class*="commentPopup"]'
    ];

    // 1. 先在当前活跃视频 Slide 内部找可见的评论面板
    if (activeSlide) {
      for (const sel of panelSelectors) {
        const panels = activeSlide.querySelectorAll(sel);
        for (const p of panels) {
          const r = p.getBoundingClientRect();
          if (r.width > 180 && r.height > 150 && r.top >= 0 && r.top < window.innerHeight * 0.6 && r.left < window.innerWidth) {
            return p.parentElement || p;
          }
        }
      }
    }

    // 2. 在全局找当前正处于屏幕可视区内的评论面板（必须满足 top >= 0 且 bottom <= window.innerHeight + 50）
    for (const sel of panelSelectors) {
      const panels = document.querySelectorAll(sel);
      for (const p of panels) {
        const r = p.getBoundingClientRect();
        if (
          r.width > 180 &&
          r.height > 150 &&
          r.top >= -20 &&
          r.top < window.innerHeight * 0.5 &&
          r.bottom <= window.innerHeight + 60 &&
          r.left >= 0 &&
          r.right <= window.innerWidth + 20
        ) {
          return p.parentElement || p;
        }
      }
    }

    return null;
  }

  function extractVisibleVideoComments(commentPanel) {
    const root = commentPanel || document;
    const comments = [];
    const seen = new Set();
    const items = root.querySelectorAll('[data-e2e="comment-item"], [class*="comment-item"], [class*="CommentItem"]');

    for (const item of items) {
      if (item.closest && item.closest("#dy-spark-root")) continue;
      const r = item.getBoundingClientRect();
      if (r.width < 100 || r.height < 20 || r.top < 40 || r.bottom > window.innerHeight) continue;

      const lines = (item.innerText || "")
        .split(/[\n\r]/)
        .map(s => s.trim())
        .filter(Boolean);

      if (lines.length >= 2) {
        const content = lines.find(
          (l, idx) =>
            idx > 0 &&
            l.length >= 2 &&
            !/^(\d+分钟前|\d+小时前|刚刚|昨天|\d+-\d+|回复|展开\d+条|作者|置顶|\d+(\.\d+)?w?)$/.test(l)
        );
        if (content && !seen.has(content)) {
          seen.add(content);
          comments.push(content.substring(0, 45));
        }
      }
      if (comments.length >= 5) break;
    }
    return comments;
  }

  /**
   * 精准定位并激活【当前正在播放视频的评论输入框】
   * 严格限定在：当前视口可见区域 (0 < top < window.innerHeight) 且处于当前活跃视频 Slide 或展开的评论区面板底部！
   * 彻底杜绝点到私信聊天框或上下预加载视频的隐藏评论框！
   */
  async function findAndActivateCurrentVideoCommentInput(activeSlide, commentPanel) {
    // 确定搜索范围：优先在当前活跃 Slide 和可见评论面板内找
    const searchRoots = [commentPanel, activeSlide, document].filter(Boolean);

    for (const root of searchRoots) {
      // 1. 寻找直接带有评论提示词的叶子元素或输入框
      const candidates = root.querySelectorAll(
        '[data-e2e="comment-input"], [class*="comment-input"], div[contenteditable="true"], textarea, input, span, div'
      );

      for (const el of candidates) {
        if (el.closest && el.closest("#dy-spark-root")) continue;

        const r = el.getBoundingClientRect();
        // 严格视口边界检查：必须在当前屏幕可视范围内！绝不碰上下预加载滑走的隐藏视频（它们 top < 0 或 top > window.innerHeight）！
        if (r.width < 80 || r.height < 16 || r.height > 110) continue;
        if (r.top < 80 || r.bottom > window.innerHeight + 10 || r.left < 0 || r.right > window.innerWidth + 10) continue;

        const ph = (el.getAttribute("placeholder") || "").trim();
        const leafText = el.children.length === 0 ? (el.innerText || "").trim() : "";
        const isCommentTrigger =
          /留下你的精彩评论|善语结善缘|发一条友好的评论|爱评论的人|说点什么/.test(ph) ||
          /留下你的精彩评论|善语结善缘|发一条友好的评论|爱评论的人/.test(leafText) ||
          isInsideVideoCommentArea(el);

        if (!isCommentTrigger) continue;

        // 如果它本身已经是激活的富文本或 textarea，直接返回
        if (el.isContentEditable || el.tagName === "TEXTAREA") {
          return el;
        }

        // 点击该评论输入栏触发激活状态
        simulateRealClick(el);
        await new Promise(res => setTimeout(res, 300));

        // 在该评论栏的小容器内部（向上最多回溯 3 层）寻找刚刚被激活的 contenteditable="true" 或 textarea
        let box = el;
        for (let k = 0; k < 4 && box && box !== document.body; k++) {
          if (box.isContentEditable || box.tagName === "TEXTAREA") return box;
          const innerEditor = box.querySelector('div[contenteditable="true"], textarea, [contenteditable="true"]');
          if (innerEditor) {
            const ir = innerEditor.getBoundingClientRect();
            if (ir.top >= 80 && ir.bottom <= window.innerHeight + 10 && ir.width > 50) {
              return innerEditor;
            }
          }
          box = box.parentElement;
        }
      }
    }

    return null;
  }

  /**
   * 面板按钮 1：【👁️ 看懂此片】
   */
  async function watchCurrentVideo() {
    window.DySparkUI.log("🎬 正在观看并解析当前屏幕中央的视频...", "info");
    try {
      const info = await inspectCurrentVideo(true);
      const persona = window.DySparkUI.getPersonaForFriend
        ? window.DySparkUI.getPersonaForFriend(info.author)
        : { groupName: "默认通用" };

      window.DySparkUI.log(`👤 视频作者: [@${info.author}] -> 匹配人格【${persona.groupName}】`, "success");
      window.DySparkUI.log(`📝 视频文案: "${info.desc.substring(0, 45)}"`, "info");
      if (info.topComments.length > 0) {
        window.DySparkUI.log(`🔥 捕获热评(${info.topComments.length}条): ${info.topComments.slice(0, 3).join(" | ")}`, "success");
      } else {
        window.DySparkUI.log("ℹ 暂未抓取到热评（或该视频尚无评论）", "warn");
      }
      return info;
    } catch (err) {
      window.DySparkUI.log(`❌ 看片失败: ${err.message}`, "error");
      return null;
    }
  }

  /**
   * 面板按钮 2：【💬 评当前视频】（精准锁定当前正在播放视频的评论区！）
   */
  async function commentOnCurrentVideo() {
    const config = window.DySparkUI ? window.DySparkUI.getConfig() : {};
    if (!config.apiKey) {
      window.DySparkUI.log("请先配置 DeepSeek API Key", "warn");
      return;
    }

    window.DySparkUI.log("🎬 正在锁定当前视频评论区并准备评论...", "info");
    try {
      const videoInfo = await inspectCurrentVideo(true);
      const broInfo = window.DySparkUI.getPriorityBroInfo ? window.DySparkUI.getPriorityBroInfo() : {};

      let persona = window.DySparkUI.getPersonaForFriend
        ? window.DySparkUI.getPersonaForFriend(videoInfo.author)
        : null;

      if (!persona || persona.groupId === "default") {
        persona = {
          groupId: "bro",
          groupName: broInfo.groupName || "🔥 死党/损友(测试优先)",
          prompt: broInfo.prompt || config.prompt
        };
      }

      window.DySparkUI.log(`👤 当前视频: [@${videoInfo.author}] "${videoInfo.desc.substring(0, 22)}"`, "info");
      window.DySparkUI.log(`🎭 启用【${persona.groupName}】生成视频评论...`, "info");

      const targetFriend = videoInfo.author !== "未知作者" ? videoInfo.author : (broInfo.firstBro || "死党");
      const memRes = await sendMessageWithTimeout(
        { action: "GET_MEMORY_CONTEXT", friend: targetFriend, queryText: videoInfo.desc, apiKey: config.apiKey },
        1200
      );
      const memoryContext = memRes && memRes.success ? memRes : null;

      let memText = "";
      if (memoryContext && Array.isArray(memoryContext.memories) && memoryContext.memories.length > 0) {
        memText = `\n【你们的共同记忆】\n` + memoryContext.memories.map(m => `- ${m.fact}`).join("\n");
      }

      const commentsContext = videoInfo.topComments.length > 0
        ? `\n【当前评论区网友热评参考】：${videoInfo.topComments.join(" / ")}`
        : "";

      const systemPrompt = `[系统角色剧本：在铁哥们/死党发布的抖音视频底下留神评拆台吐槽]
${persona.prompt}${memText}
【评论要求】
1. 结合视频文案和网友热评的槽点，用死党互损、拆台、玩梗或粗口吐槽的语气写一条抖音评论（4~16字）；
2. 严禁像AI写观后感！要像真朋友刷到死党视频直接在底下损他（如：“这滤镜开得你妈都不认识了[狗头]”、“精神状态挺稳定啊大傻春[裂开]”、“尬得我脚趾抠出三室一厅[泣不成声]”）；
3. 可带1个抖音表情码如 [狗头] [裂开] [泣不成声] [白眼] [666]，不打句号！`;

      const userPrompt = `视频作者：@${videoInfo.author}\n视频文案：${videoInfo.desc}${commentsContext}\n请直接输出你要发在评论区的那句话：`;

      const apiProfile = window.DySparkUI && window.DySparkUI.getActiveApiProfile ? window.DySparkUI.getActiveApiProfile() : null;
      const res = await sendMessageWithTimeout(
        {
          action: "CALL_CHAT_MODEL",
          apiProfile,
          apiKey: config.apiKey,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        },
        12000
      );

      if (!res || !res.success || !res.reply) {
        window.DySparkUI.log(`❌ 生成评论失败: ${res ? res.error : "无响应"}`, "error");
        return;
      }

      const commentText = res.reply.replace(/[\r\n\t]/g, " ").trim();
      window.DySparkUI.log(`💬 生成神评: "${commentText}"，正在填入当前视频评论框...`, "success");

      const commentInput = await findAndActivateCurrentVideoCommentInput(videoInfo.slide, videoInfo.commentPanel);
      if (!commentInput) {
        window.DySparkUI.log("⚠ 未找到当前视频的评论输入框，请确认视频右侧评论抽屉已展开", "warn");
        return;
      }

      commentInput.focus();
      if (commentInput.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(commentInput);
        sel.removeAllRanges();
        sel.addRange(range);
        if (!document.execCommand("insertText", false, commentText)) {
          commentInput.innerText = commentText;
        }
      } else {
        commentInput.value = commentText;
      }

      commentInput.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: commentText }));
      commentInput.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

      await new Promise(r => setTimeout(r, 250));

      // 在该评论输入框所属的评论栏容器内部寻找右侧的发送按钮（纸飞机图标或发送按钮）
      const inputRect = commentInput.getBoundingClientRect();
      let clickedSend = false;
      let inputBar = commentInput.parentElement;
      for (let k = 0; k < 3 && inputBar && inputBar.parentElement; k++) {
        if (inputBar.getBoundingClientRect().width > inputRect.width + 30) break;
        inputBar = inputBar.parentElement;
      }

      const btnCandidates = (inputBar || document).querySelectorAll('span, div[role="button"], button, svg');
      for (const b of btnCandidates) {
        if (b.closest && b.closest("#dy-spark-root")) continue;
        const br = b.getBoundingClientRect();
        if (
          Math.abs(br.top - inputRect.top) < 45 &&
          br.left >= inputRect.right - 45 &&
          br.left <= inputRect.right + 130 &&
          br.width >= 14 &&
          br.width <= 80 &&
          br.top >= 80 &&
          br.bottom <= window.innerHeight + 10
        ) {
          simulateRealClick(b);
          clickedSend = true;
          break;
        }
      }

      if (!clickedSend) {
        const enterOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        commentInput.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
        commentInput.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
        commentInput.dispatchEvent(new KeyboardEvent("keyup", enterOpts));
      }

      window.DySparkUI.log(`✔ 已精准在 [@${videoInfo.author}] 当前视频评论区发送评论！`, "success");

      chrome.runtime.sendMessage({
        action: "AFTER_REPLY_ORGANIZE",
        apiKey: config.apiKey,
        friend: targetFriend,
        personaName: persona.groupName,
        extraFact: `我刚在[${videoInfo.author}]的视频《${videoInfo.desc.substring(0, 18)}》底下评论吐槽了：“${commentText}”`
      });
    } catch (err) {
      window.DySparkUI.log(`❌ 评论视频异常: ${err.message}`, "error");
    }
  }

  /**
   * 面板按钮 3：【📤 发给死党】
   */
  async function shareCurrentVideoToBro() {
    const config = window.DySparkUI ? window.DySparkUI.getConfig() : {};
    if (!config.apiKey) {
      window.DySparkUI.log("请先配置 DeepSeek API Key", "warn");
      return;
    }

    const broInfo = window.DySparkUI.getPriorityBroInfo ? window.DySparkUI.getPriorityBroInfo() : {};
    const targetBro = broInfo.firstBro || "";

    window.DySparkUI.log(`📤 准备将当前视频转发给死党 [${targetBro || "列表首位好友"}]...`, "info");

    try {
      const videoInfo = await inspectCurrentVideo(false);
      const slide = videoInfo.slide;

      const shareSelectors = [
        '[data-e2e="video-share-container"]',
        '[data-e2e="feed-share-icon"]',
        '[class*="share-icon"]',
        '[class*="shareContainer"]'
      ];

      let shareBtn = null;
      for (const sel of shareSelectors) {
        const els = slide.querySelectorAll(sel);
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 15 && r.top > 80 && r.bottom < window.innerHeight) {
            shareBtn = el;
            break;
          }
        }
        if (shareBtn) break;
      }

      if (shareBtn) {
        shareBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        shareBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        simulateRealClick(shareBtn);
        await new Promise(r => setTimeout(r, 750));
      }

      let sharedViaPanel = false;
      const allEls = document.querySelectorAll("div, span, li, button");
      for (const el of allEls) {
        if (el.closest && el.closest("#dy-spark-root")) continue;
        const t = (el.innerText || "").trim();
        if (targetBro && t === targetBro) {
          const r = el.getBoundingClientRect();
          if (r.width > 15 && r.height > 12 && r.top > 50 && r.bottom < window.innerHeight) {
            let card = el.parentElement;
            for (let k = 0; k < 4 && card; k++) {
              const btn = Array.from(card.querySelectorAll("button, span, div")).find(
                b => /^(分享|发送|已分享)$/.test((b.innerText || "").trim())
              );
              if (btn) {
                simulateRealClick(btn);
                sharedViaPanel = true;
                break;
              }
              card = card.parentElement;
            }
            if (!sharedViaPanel) {
              simulateRealClick(el);
              sharedViaPanel = true;
            }
            break;
          }
        }
      }

      const sysPrompt = `${broInfo.prompt || config.prompt}\n你刚刚刷到一个抖音视频《${videoInfo.desc.substring(0, 28)}》（作者@${videoInfo.author}），顺手转发给了你的死党[${targetBro || "朋友"}]，请配上一句4~14字的损友吐槽（比如“快看这个大傻春，简直在演你[泣不成声]”、“看到这个第一反应就是你个臭傻逼[狗头]”），不打句号！`;

      const apiProfile = window.DySparkUI && window.DySparkUI.getActiveApiProfile ? window.DySparkUI.getActiveApiProfile() : null;
      const res = await sendMessageWithTimeout(
        {
          action: "CALL_CHAT_MODEL",
          apiProfile,
          apiKey: config.apiKey,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: "生成转发该视频时的随口损友吐槽：" }
          ]
        },
        12000
      );

      const roast = res && res.success && res.reply ? res.reply.replace(/[\r\n\t]/g, " ").trim() : "快看这个，纯纯在演你[狗头]";
      window.DySparkUI.log(`📤 转发配文: "${roast}"`, "success");

      const shareMsgInput = Array.from(document.querySelectorAll('input, textarea, div[contenteditable="true"]')).find(
        el => {
          if (el.closest && el.closest("#dy-spark-root")) return false;
          const ph = (el.getAttribute("placeholder") || "").trim();
          return /有什么想和朋友说|留言|附言/.test(ph);
        }
      );

      if (shareMsgInput) {
        shareMsgInput.focus();
        shareMsgInput.value = roast;
        shareMsgInput.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        const confirmBtn = Array.from(document.querySelectorAll("button, span, div")).find(
          b => /^(发送|确定|分享)$/.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 20
        );
        if (confirmBtn) simulateRealClick(confirmBtn);
      } else if (findChatInput()) {
        await sendMessageToChat(roast);
      }

      window.DySparkUI.log(`✔ 已完成对死党 [${targetBro || "当前好友"}] 的视频分享与吐槽！`, "success");

      chrome.runtime.sendMessage({
        action: "AFTER_REPLY_ORGANIZE",
        apiKey: config.apiKey,
        friend: targetBro || "当前好友",
        personaName: broInfo.groupName || "死党",
        extraFact: `我把视频《${videoInfo.desc.substring(0, 18)}》转发给了他，并吐槽：“${roast}”`
      });
    } catch (err) {
      window.DySparkUI.log(`❌ 转发视频异常: ${err.message}`, "error");
    }
  }

  /**
   * 每日续火花保活
   */
  async function checkDailySpark() {
    if (!window.DySparkUI) return;
    const config = window.DySparkUI.getConfig();
    if (!config.enabled || !config.sparkEnabled || !config.apiKey) return;

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (lastSparkSentDate === todayStr) return;

    const currentHours = String(now.getHours()).padStart(2, "0");
    const currentMins = String(now.getMinutes()).padStart(2, "0");
    const currentTimeStr = `${currentHours}:${currentMins}`;

    if (currentTimeStr >= (config.sparkTime || "21:00")) {
      window.DySparkUI.log("触发每日续火花保活...", "info");
      lastSparkSentDate = todayStr;

      const messages = [
        {
          role: "system",
          content: "你是一个真实朋友，晚上给好友发一句极简随性问候（4~12字），可带1个抖音表情如[捂脸][狗头]，用来维持抖音火花。绝无AI味。"
        },
        { role: "user", content: "生成一句随性日常问候短句" }
      ];

      const apiProfile = window.DySparkUI && window.DySparkUI.getActiveApiProfile ? window.DySparkUI.getActiveApiProfile() : null;
      chrome.runtime.sendMessage(
        { action: "CALL_CHAT_MODEL", apiProfile, apiKey: config.apiKey, messages: messages },
        async (res) => {
          if (res && res.success && res.reply) {
            try {
              await sendMessageToChat(res.reply);
              window.DySparkUI.log(`已主动发送续火花: "${res.reply}"`, "success");
            } catch (err) {
              window.DySparkUI.log(`发送失败: ${err.message}`, "error");
            }
          }
        }
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
