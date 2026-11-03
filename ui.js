// 抖音火花助手 - UI 界面与反人机多维人格管理模块 (v2.4.0)
(function () {
  if (window.DySparkUI) return;

  const DEFAULT_PERSONA_GROUPS = [
    {
      id: "default",
      name: "🌐 默认通用 (随性真人)",
      isDefault: true,
      friends: "",
      prompt: `你是号主本人，二十岁左右，正拿着手机日常跟朋友发私信。
【说话风格与去人机规范】
1. 像真人随手打字：极简短促（通常3~14字），随性自然，完全去掉机器人公文腔！
2. 严禁空洞客套：“哈哈确实”、“你说得对”、“好呀”、“那挺好的”这类机器人废话坚决不说。
3. 紧扣对方说的事直接给真实反应（好奇、吐槽、接话、分享），对方发表情包或沙雕图就随口吐槽它的笑点或恶搞动作，绝不一本正经总结画面。
4. 句末绝不加句号“。”，可以不加标点，偶尔带1个表情如[狗头][捂脸][裂开][泣不成声][白眼]。`
    },
    {
      id: "bro",
      name: "🔥 死党/铁哥们 (互怼损友)",
      isDefault: false,
      friends: "",
      prompt: `对方是你认识多年的铁哥们/死党，无话不谈，平时互开玩笑、互损互拆台。
【说话风格】
1. 嘴碎、幽默、接地气（4~16字），对方正常聊天就靠谱接话；对方开始贫嘴或恶搞就顺势调侃；对方骂人挑衅就用损友糙话怼回去，损在点子上！
2. 绝对不能认怂，严禁掉入对方的吃恶心东西或认爹圈套，对方恶搞必须狠狠呛回去（如“滚你大爷的[白眼]”、“吃你大爷你自己留着慢慢品吧”）。
3. 句末不加句号，灵活运用[狗头][裂开][白眼][捂脸]。`
    },
    {
      id: "sweet",
      name: "💕 温柔/偏爱 (亲密暧昧)",
      isDefault: false,
      friends: "",
      prompt: `对方是你特别喜欢、偏爱或处于暧昧关系的人。
【说话风格】
1. 认真听对方说的话，秒回感、偏爱感拉满，温柔自然（5~18字），绝不敷衍或机械复读！
2. 针对对方聊到的日常或情绪给温暖反馈，适当撒娇或关心，但不粘腻、不油腻。
3. 句末不加句号，自然穿插表情如[害羞][比心][捂脸][可怜][愉快]。`
    },
    {
      id: "polite",
      name: "🎓 礼貌/长辈/同学同事",
      isDefault: false,
      friends: "",
      prompt: `对方是长辈、老师或普通同学同事。
【说话风格】
1. 得体、清晰、真诚、靠谱地回应对方说的具体事项（6~20字），不玩抽象黑话、不爆粗口。
2. 态度谦和有礼，可适度搭配温和表情如[握手][微笑][抱拳][玫瑰][愉快]，句末不加生硬句号。`
    }
  ];

  const DEFAULT_API_PROFILES = [
    {
      id: "deepseek_multimodal",
      name: "DeepSeek 多模态 (中转/聚合/图文全能)",
      baseUrl: "https://api.deepseek.com/chat/completions",
      apiKey: "",
      model: "deepseek-chat",
      isMultimodal: true,
      temperature: 0.85
    },
    {
      id: "deepseek_v3",
      name: "DeepSeek 官方纯文本 (V3 / R1)",
      baseUrl: "https://api.deepseek.com/chat/completions",
      apiKey: "",
      model: "deepseek-chat",
      isMultimodal: false,
      temperature: 0.9
    },
    {
      id: "zhipu_glm4v",
      name: "智谱 GLM-4V (多模态看图)",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      apiKey: "",
      model: "glm-4v-flash",
      isMultimodal: true,
      temperature: 0.7
    },
    {
      id: "qwen_vl",
      name: "通义千问 Qwen-VL (多模态看图)",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      apiKey: "",
      model: "qwen-vl-plus",
      isMultimodal: true,
      temperature: 0.7
    },
    {
      id: "custom_openai",
      name: "自定义 OpenAI 兼容接口 / 聚合中转",
      baseUrl: "",
      apiKey: "",
      model: "",
      isMultimodal: true,
      temperature: 0.85
    }
  ];

  const VISION_PRESETS = {
    zhipu: {
      label: "智谱 GLM-4V-Flash (免费)",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: "glm-4v-flash"
    },
    qwen: {
      label: "通义千问 Qwen-VL",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen-vl-plus"
    },
    custom: {
      label: "自定义 OpenAI 兼容接口",
      baseUrl: "",
      model: ""
    }
  };

  const DEFAULT_CONFIG = {
    apiKey: "",
    apiProfiles: DEFAULT_API_PROFILES,
    activeApiId: "deepseek_multimodal",
    enabled: false,
    whitelist: "",
    prompt: DEFAULT_PERSONA_GROUPS[0].prompt,
    personaGroups: DEFAULT_PERSONA_GROUPS,
    activePersonaId: "default",
    sparkTime: "21:00",
    sparkEnabled: true,
    visionEnabled: true,
    visionProvider: "zhipu",
    visionApiKey: "",
    visionBaseUrl: VISION_PRESETS.zhipu.baseUrl,
    visionModel: VISION_PRESETS.zhipu.model
  };

  let currentConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  let configChangeCallbacks = [];
  let saveDebounceTimer = null;

  function initDOM() {
    const oldRoot = document.getElementById("dy-spark-root");
    if (oldRoot) oldRoot.remove();

    const root = document.createElement("div");
    root.id = "dy-spark-root";
    root.innerHTML = `
      <div id="dy-spark-toggle-btn" title="点击展开 抖音火花助手 AI 控制台">🔥</div>
      <div id="dy-spark-panel">
        <div class="dy-spark-header">
          <div class="dy-spark-header-top">
            <div class="dy-spark-title">
              <span class="dy-spark-logo-badge">🔥</span>
              <span>抖音火花助手 AI</span>
              <span class="dy-spark-status-pill" id="dy-spark-status-pill">
                <span class="dy-spark-status-dot" id="dy-spark-dot"></span>
                <span id="dy-spark-status-text">待机中</span>
              </span>
            </div>
            <span class="dy-spark-close-btn" id="dy-spark-close" title="收起面板">✕</span>
          </div>
          <div class="dy-spark-tech-bar">
            <span class="dy-spark-tech-tag rose" id="dy-spark-active-model-tag">多模态大模型</span>
            <span class="dy-spark-tech-tag cyan">Manifest V3</span>
            <span class="dy-spark-tech-tag">ES6+ DOM Engine</span>
            <span class="dy-spark-tech-tag">7D MemoryVault</span>
          </div>
        </div>

        <div class="dy-spark-body">
          <!-- 基础连接与大模型 API 管理列表 (支持任意多模态/文本模型) -->
          <div class="dy-spark-section">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <label class="dy-spark-label" style="font-weight: 600; color: #fff;">
                <span>🤖 大模型 API 接口选择与管理</span>
              </label>
              <div style="display: flex; gap: 6px;">
                <button id="dy-spark-add-api" class="dy-spark-btn" style="padding: 2px 7px; font-size: 11px; background: rgba(37,244,238,0.18); color: #25f4ee; border: 1px solid rgba(37,244,238,0.35);">+ 新增接口</button>
                <button id="dy-spark-test-key" class="dy-spark-btn" style="padding: 2px 8px; font-size: 11px; background: linear-gradient(135deg, #fe2c55, #ff5376); border: none;">⚡ 测试连通</button>
              </div>
            </div>

            <!-- 当前选中接口下拉选择框 -->
            <div class="dy-spark-field">
              <select id="dy-spark-api-select" class="dy-spark-input" style="font-weight: 600; padding: 6px 8px;"></select>
            </div>

            <!-- 选中接口的具体配置卡片 -->
            <div id="dy-spark-api-card" style="background: rgba(0,0,0,0.22); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 9px; display: flex; flex-direction: column; gap: 7px;">
              <div style="display: flex; gap: 6px;">
                <input type="text" id="dy-spark-api-name" class="dy-spark-input" style="flex: 1; font-weight: 600;" placeholder="接口名称/备注" />
                <button id="dy-spark-del-api" class="dy-spark-btn" style="padding: 3px 8px; font-size: 11px; background: rgba(248,113,113,0.14); border-color: rgba(248,113,113,0.3); color: #f87171;" title="删除当前接口">删除</button>
              </div>

              <div class="dy-spark-field">
                <label class="dy-spark-label" style="font-size: 11px;">接口地址 (Base URL)</label>
                <input type="text" id="dy-spark-api-url" class="dy-spark-input" placeholder="如 https://api.deepseek.com/chat/completions" />
              </div>

              <div class="dy-spark-field">
                <label class="dy-spark-label" style="font-size: 11px;">API 密钥 (API Key)</label>
                <input type="password" id="dy-spark-api-key" class="dy-spark-input" placeholder="输入 sk-... (本地安全加密存储)" />
              </div>

              <div class="dy-spark-field">
                <label class="dy-spark-label" style="font-size: 11px;">模型名称 (Model Name)</label>
                <input type="text" id="dy-spark-api-model" class="dy-spark-input" placeholder="如 deepseek-chat / deepseek-vl / gpt-4o / qwen-vl-plus" />
              </div>

              <div class="dy-spark-switch-row" style="background: rgba(255,255,255,0.03); padding: 5px 8px; border-radius: 6px;">
                <label class="dy-spark-label" style="font-size: 11.5px; color: #25f4ee; font-weight: 500;">
                  <span>🖼️ 此为多模态模型 (支持直接看图发表情包)</span>
                </label>
                <label class="dy-spark-toggle-switch">
                  <input type="checkbox" id="dy-spark-api-multimodal" />
                  <span class="dy-spark-toggle-slider"></span>
                </label>
              </div>
            </div>

            <div class="dy-spark-switch-row" style="margin-top: 4px;">
              <label class="dy-spark-label" style="font-weight: 600; font-size: 12.5px; color: #fff;">🤖 启动 AI 全自动秒回与巡检</label>
              <label class="dy-spark-toggle-switch">
                <input type="checkbox" id="dy-spark-enable-toggle" />
                <span class="dy-spark-toggle-slider"></span>
              </label>
            </div>

            <div class="dy-spark-switch-row">
              <label class="dy-spark-label">⏰ 每日定时主动续火花保活</label>
              <div style="display: flex; align-items: center; gap: 8px;">
                <input type="time" id="dy-spark-time" class="dy-spark-input" style="padding: 2px 6px; width: 78px; font-size: 11px;" value="21:00" />
                <label class="dy-spark-toggle-switch">
                  <input type="checkbox" id="dy-spark-spark-toggle" checked />
                  <span class="dy-spark-toggle-slider"></span>
                </label>
              </div>
            </div>

            <div class="dy-spark-field">
              <label class="dy-spark-label">
                <span>🛡️ 群聊白名单 <span style="color: #20d57e; font-size: 11px;">(好友私聊默认全回)</span></span>
              </label>
              <input type="text" id="dy-spark-whitelist" class="dy-spark-input" placeholder="留空不回群；多群用逗号隔开，如: 周末开黑群, 宿舍群" />
            </div>
          </div>

          <!-- 视觉识别：图片 / 表情包 / 动图 (当主模型为纯文本时生效) -->
          <div class="dy-spark-section">
            <div class="dy-spark-switch-row">
              <label class="dy-spark-label" style="font-weight: 600; color: #fff;">👁️ 辅助图片/表情包识别</label>
              <label class="dy-spark-toggle-switch">
                <input type="checkbox" id="dy-spark-vision-toggle" checked />
                <span class="dy-spark-toggle-slider"></span>
              </label>
            </div>
            <div id="dy-spark-vision-multimodal-hint" style="font-size: 11px; color: #20d57e; display: none;">✔ 当前主模型已开启【多模态识图】，图片将直接传给主模型识别</div>
            <div style="display: flex; gap: 6px;">
              <select id="dy-spark-vision-provider" class="dy-spark-input" style="flex: 1; padding: 5px 6px;">
                <option value="zhipu">智谱 GLM-4V-Flash (免费)</option>
                <option value="qwen">通义千问 Qwen-VL</option>
                <option value="custom">自定义 OpenAI 兼容接口</option>
              </select>
              <button id="dy-spark-test-vision" class="dy-spark-btn" style="padding: 2px 8px; font-size: 11px;">测试</button>
            </div>
            <input type="password" id="dy-spark-vision-key" class="dy-spark-input" placeholder="辅助视觉 API Key（纯文本主模型时生效）" />
            <div id="dy-spark-vision-custom-box" style="display: none; flex-direction: column; gap: 6px;">
              <input type="text" id="dy-spark-vision-url" class="dy-spark-input" placeholder="接口地址 .../chat/completions" />
              <input type="text" id="dy-spark-vision-model" class="dy-spark-input" placeholder="模型名，如 gpt-4o-mini" />
            </div>
          </div>

          <!-- 多维人格分组模块 -->
          <div class="dy-spark-section">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <label class="dy-spark-label" style="font-weight: 600; color: #fff;">
                <span>🎭 多维好友人格分组引擎</span>
                <span id="dy-spark-save-hint" style="color: #20d57e; font-size: 10px; margin-left: 6px; font-weight: normal;"></span>
              </label>
              <a href="#" id="dy-spark-add-persona" style="color: #25f4ee; text-decoration: none; font-size: 11px; font-weight: bold;">+ 新增人格组</a>
            </div>
            <div class="dy-spark-persona-tabs" id="dy-spark-persona-tabs"></div>

            <div class="dy-spark-persona-card">
              <div id="dy-spark-persona-header-row" style="display: flex; justify-content: space-between; align-items: center; gap: 6px;">
                <input type="text" id="dy-spark-persona-name" class="dy-spark-input" style="flex: 1; padding: 4px 8px; font-weight: 600;" placeholder="分组名称" />
                <button id="dy-spark-delete-persona" class="dy-spark-btn" style="flex: none; padding: 4px 8px; background: rgba(248,113,113,0.16); border-color: rgba(248,113,113,0.3); color: #f87171; font-size: 11px;">删除该组</button>
              </div>

              <div id="dy-spark-persona-friends-box" class="dy-spark-field">
                <label class="dy-spark-label">绑定好友/群名 (逗号隔开，自动切换该人设)</label>
                <input type="text" id="dy-spark-persona-friends" class="dy-spark-input" placeholder="如: 张三, 李四, 游戏搭子" />
              </div>

              <div id="dy-spark-persona-default-tip" style="font-size: 11px; color: #25f4ee; display: none;">
                ℹ 未分配到其他专属分组的好友，均默认使用下方通用人设：
              </div>

              <div class="dy-spark-field">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <label class="dy-spark-label">本组专属 System Prompt</label>
                  <a href="#" id="dy-spark-reset-persona" style="color: #fbbf24; text-decoration: none; font-size: 10px;">↻ 注入去人机强化模板</a>
                </div>
                <textarea id="dy-spark-prompt" class="dy-spark-textarea" style="min-height: 68px;"></textarea>
              </div>
            </div>
          </div>

          <!-- 视频看片/评片/转发操作台 -->
          <div class="dy-spark-video-box">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <label class="dy-spark-label" style="font-weight: 600; color: #ff809b;">🎬 AI 多模态看片 · 神评 · 转发工作台</label>
              <span style="font-size: 10px; color: rgba(255,255,255,0.5);">视口精准锁定</span>
            </div>
            <div class="dy-spark-video-btn-row">
              <button id="dy-spark-watch-video-btn" class="dy-spark-video-btn" title="读取当前视频作者、文案与前5条热评">👁️ 看懂此片</button>
              <button id="dy-spark-comment-video-btn" class="dy-spark-video-btn" style="background: rgba(254,44,85,0.22); border-color: #fe2c55;" title="看完当前视频后，用死党/对应人设自动在评论区发神评">💬 评当前视频</button>
              <button id="dy-spark-share-video-btn" class="dy-spark-video-btn" style="background: rgba(32,213,126,0.18); border-color: #20d57e;" title="把当前播放的视频一键转发给死党分组里的好友并吐槽">📤 发给死党</button>
            </div>
          </div>

          <!-- 实时遥测与调试日志 -->
          <div class="dy-spark-field">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; gap: 4px;">
              <label class="dy-spark-label" style="font-weight: 600;">📟 实时运行遥测日志</label>
              <div style="display: flex; gap: 4px;">
                <button id="dy-spark-test-send-btn" class="dy-spark-btn" style="padding: 2px 7px; font-size: 10.5px; background: rgba(59,130,246,0.25); border-color: rgba(59,130,246,0.5); color: #93c5fd;">⚡ 测试发一条</button>
                <button id="dy-spark-diagnose-btn" class="dy-spark-btn" style="padding: 2px 7px; font-size: 10.5px; background: rgba(32,213,126,0.2); border-color: rgba(32,213,126,0.45); color: #6ee7b7;">🔍 诊断</button>
                <button id="dy-spark-clear-log-btn" class="dy-spark-btn" style="padding: 2px 6px; font-size: 10.5px; color: #9ca3af;" title="清空日志">🗑️</button>
              </div>
            </div>
            <div class="dy-spark-log-box" id="dy-spark-logs"></div>
          </div>
        </div>

        <div class="dy-spark-footer">
          <span>Powered by JavaScript ES6+ · Node.js · DeepSeek LLM</span>
          <span>v2.2.0</span>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    bindEvents();
    loadConfig();
  }

  function showSaveHint() {
    const hint = document.getElementById("dy-spark-save-hint");
    if (!hint) return;
    hint.textContent = "✔ 已实时保存";
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      hint.textContent = "";
    }, 1800);
  }

  function getActivePersonaGroup() {
    if (!currentConfig.personaGroups || currentConfig.personaGroups.length === 0) {
      currentConfig.personaGroups = JSON.parse(JSON.stringify(DEFAULT_PERSONA_GROUPS));
    }
    let group = currentConfig.personaGroups.find(g => g.id === currentConfig.activePersonaId);
    if (!group) {
      group = currentConfig.personaGroups[0];
      currentConfig.activePersonaId = group.id;
    }
    return group;
  }

  function renderPersonaTabsAndCard(skipInputUpdate = false) {
    const tabsContainer = document.getElementById("dy-spark-persona-tabs");
    if (!tabsContainer) return;

    const activeGroup = getActivePersonaGroup();
    tabsContainer.innerHTML = "";

    currentConfig.personaGroups.forEach(group => {
      const tab = document.createElement("div");
      tab.className = `dy-spark-persona-tab ${group.id === activeGroup.id ? "active" : ""}`;

      const friendList = (group.friends || "").split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
      const countHtml = !group.isDefault && friendList.length > 0
        ? `<span class="dy-spark-badge-count">${friendList.length}</span>`
        : "";

      tab.innerHTML = `<span>${group.name}</span>${countHtml}`;
      tab.addEventListener("click", () => {
        currentConfig.activePersonaId = group.id;
        renderPersonaTabsAndCard(false);
        persistConfig();
      });
      tabsContainer.appendChild(tab);
    });

    if (skipInputUpdate) return;

    const headerRow = document.getElementById("dy-spark-persona-header-row");
    const nameInput = document.getElementById("dy-spark-persona-name");
    const deleteBtn = document.getElementById("dy-spark-delete-persona");
    const friendsBox = document.getElementById("dy-spark-persona-friends-box");
    const friendsInput = document.getElementById("dy-spark-persona-friends");
    const defaultTip = document.getElementById("dy-spark-persona-default-tip");
    const promptInput = document.getElementById("dy-spark-prompt");

    if (activeGroup.isDefault) {
      headerRow.style.display = "none";
      friendsBox.style.display = "none";
      defaultTip.style.display = "block";
    } else {
      headerRow.style.display = "flex";
      friendsBox.style.display = "flex";
      defaultTip.style.display = "none";
      nameInput.value = activeGroup.name || "";
      friendsInput.value = activeGroup.friends || "";
      deleteBtn.style.display = "block";
    }

    promptInput.value = activeGroup.prompt || "";
  }

  /**
   * 清洗好友昵称（剥离尾部火花数字、在线状态等杂音），确保 100% 匹配人格分组
   */
  function normalizeFriendName(rawName) {
    if (!rawName) return "";
    return rawName
      .replace(/[\(（]\d+[\)）]/g, "")
      .replace(/\s+\d+$/g, "")
      .replace(/🔥\d*/g, "")
      .replace(/(刚刚|在线|\d+分钟前|\d+小时内在线)/g, "")
      .trim();
  }

  /**
   * 根据好友/群聊名称，匹配对应的人格分组与 Prompt
   */
  function getPersonaForFriend(friendName) {
    const groups = currentConfig.personaGroups || DEFAULT_PERSONA_GROUPS;
    const cleanTarget = normalizeFriendName(friendName);

    if (cleanTarget && cleanTarget !== "当前好友") {
      for (const group of groups) {
        if (group.isDefault) continue;
        const list = (group.friends || "").split(/[,，\n]/).map(s => normalizeFriendName(s)).filter(Boolean);
        if (list.some(name => cleanTarget.includes(name) || name.includes(cleanTarget))) {
          return {
            groupId: group.id,
            groupName: group.name,
            prompt: group.prompt || DEFAULT_PERSONA_GROUPS[0].prompt
          };
        }
      }
    }

    const defaultGroup = groups.find(g => g.isDefault) || groups[0];
    return {
      groupId: defaultGroup.id || "default",
      groupName: defaultGroup.name || "🌐 默认通用",
      prompt: defaultGroup.prompt || DEFAULT_PERSONA_GROUPS[0].prompt
    };
  }

  function sendToBackground(message, timeout = 10000) {
    return new Promise((resolve, reject) => {
      let hasTimedOut = false;
      const timer = setTimeout(() => {
        hasTimedOut = true;
        reject(new Error("后台通信超时，请在 edge://extensions 刷新扩展后，按 F5 刷新本网页"));
      }, timeout);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (hasTimedOut) return;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "扩展上下文失效，请刷新页面"));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        reject(new Error("扩展上下文已失效，请按 F5 刷新网页重试"));
      }
    });
  }

  function persistConfig() {
    try {
      const defaultGroup = (currentConfig.personaGroups || []).find(g => g.isDefault);
      if (defaultGroup) {
        currentConfig.prompt = defaultGroup.prompt;
      }
      const activeApi = getActiveApiProfile();
      if (activeApi) {
        currentConfig.apiKey = activeApi.apiKey || "";
      }
      chrome.storage.local.set({ dy_spark_config: currentConfig }, () => {
        updateStatus(currentConfig.enabled);
        showSaveHint();
        configChangeCallbacks.forEach(cb => cb(currentConfig));
      });
    } catch (err) {
      log("保存配置失败，请刷新网页: " + err.message, "error");
    }
  }

  function getActiveApiProfile() {
    const list = currentConfig.apiProfiles || DEFAULT_API_PROFILES;
    const activeId = currentConfig.activeApiId || list[0].id;
    return list.find(p => p.id === activeId) || list[0];
  }

  function renderApiProfileSelectorAndCard(onlyOptions = false) {
    const apiSelect = document.getElementById("dy-spark-api-select");
    const nameInput = document.getElementById("dy-spark-api-name");
    const urlInput = document.getElementById("dy-spark-api-url");
    const keyInput = document.getElementById("dy-spark-api-key");
    const modelInput = document.getElementById("dy-spark-api-model");
    const multiCheckbox = document.getElementById("dy-spark-api-multimodal");
    const delBtn = document.getElementById("dy-spark-del-api");
    const modelTag = document.getElementById("dy-spark-active-model-tag");
    const multiHint = document.getElementById("dy-spark-vision-multimodal-hint");

    if (!apiSelect) return;

    const list = currentConfig.apiProfiles || DEFAULT_API_PROFILES;
    const active = getActiveApiProfile();

    // 1. 刷新下拉选项
    apiSelect.innerHTML = "";
    list.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.isMultimodal ? "🖼️[多模态] " : "📝[纯文本] "}${p.name} (${p.model || "未设模型"})`;
      if (p.id === active.id) opt.selected = true;
      apiSelect.appendChild(opt);
    });

    if (modelTag) {
      modelTag.textContent = active.model || active.name || "自定义模型";
    }

    if (multiHint) {
      multiHint.style.display = active.isMultimodal ? "block" : "none";
    }

    if (onlyOptions) return;

    // 2. 填充详情卡片
    if (nameInput) nameInput.value = active.name || "";
    if (urlInput) urlInput.value = active.baseUrl || "";
    if (keyInput) keyInput.value = active.apiKey || "";
    if (modelInput) modelInput.value = active.model || "";
    if (multiCheckbox) multiCheckbox.checked = !!active.isMultimodal;
    if (delBtn) delBtn.disabled = list.length <= 1;
  }

  function bindEvents() {
    const toggleBtn = document.getElementById("dy-spark-toggle-btn");
    const panel = document.getElementById("dy-spark-panel");
    const closeBtn = document.getElementById("dy-spark-close");
    const enableToggle = document.getElementById("dy-spark-enable-toggle");
    const whitelistInput = document.getElementById("dy-spark-whitelist");
    const timeInput = document.getElementById("dy-spark-time");
    const sparkToggle = document.getElementById("dy-spark-spark-toggle");
    const testKeyBtn = document.getElementById("dy-spark-test-key");
    const diagnoseBtn = document.getElementById("dy-spark-diagnose-btn");
    const testSendBtn = document.getElementById("dy-spark-test-send-btn");

    const apiSelect = document.getElementById("dy-spark-api-select");
    const addApiBtn = document.getElementById("dy-spark-add-api");
    const delApiBtn = document.getElementById("dy-spark-del-api");
    const apiNameInput = document.getElementById("dy-spark-api-name");
    const apiUrlInput = document.getElementById("dy-spark-api-url");
    const apiKeyInput = document.getElementById("dy-spark-api-key");
    const apiModelInput = document.getElementById("dy-spark-api-model");
    const apiMultiToggle = document.getElementById("dy-spark-api-multimodal");

    const addPersonaBtn = document.getElementById("dy-spark-add-persona");
    const resetPersonaBtn = document.getElementById("dy-spark-reset-persona");
    const personaNameInput = document.getElementById("dy-spark-persona-name");
    const personaFriendsInput = document.getElementById("dy-spark-persona-friends");
    const promptInput = document.getElementById("dy-spark-prompt");
    const deletePersonaBtn = document.getElementById("dy-spark-delete-persona");

    toggleBtn.addEventListener("click", () => panel.classList.toggle("open"));
    closeBtn.addEventListener("click", () => panel.classList.remove("open"));

    // 切换生效 API Profile
    if (apiSelect) {
      apiSelect.addEventListener("change", () => {
        currentConfig.activeApiId = apiSelect.value;
        const active = getActiveApiProfile();
        currentConfig.apiKey = active.apiKey || "";
        renderApiProfileSelectorAndCard(false);
        persistConfig();
        log(`已切换当前模型接口为: 【${active.name}】(${active.model})`, "info");
      });
    }

    // 实时编辑当前生效 API
    const saveActiveApiRealtime = () => {
      const active = getActiveApiProfile();
      if (apiNameInput) active.name = apiNameInput.value.trim() || "自定义接口";
      if (apiUrlInput) active.baseUrl = apiUrlInput.value.trim();
      if (apiKeyInput) active.apiKey = apiKeyInput.value.trim();
      if (apiModelInput) active.model = apiModelInput.value.trim();
      if (apiMultiToggle) active.isMultimodal = apiMultiToggle.checked;
      currentConfig.apiKey = active.apiKey || "";
      renderApiProfileSelectorAndCard(true); // 刷新下拉选项文字
      persistConfig();
    };

    if (apiNameInput) apiNameInput.addEventListener("input", saveActiveApiRealtime);
    if (apiUrlInput) apiUrlInput.addEventListener("input", saveActiveApiRealtime);
    if (apiKeyInput) apiKeyInput.addEventListener("input", saveActiveApiRealtime);
    if (apiModelInput) apiModelInput.addEventListener("input", saveActiveApiRealtime);
    if (apiMultiToggle) apiMultiToggle.addEventListener("change", saveActiveApiRealtime);

    // 新增 API 接口
    if (addApiBtn) {
      addApiBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const list = currentConfig.apiProfiles || DEFAULT_API_PROFILES;
        const newId = "api_" + Date.now();
        const newProfile = {
          id: newId,
          name: "✨ 自定义接口 " + (list.length + 1),
          baseUrl: "https://api.deepseek.com/chat/completions",
          apiKey: "",
          model: "deepseek-chat",
          isMultimodal: true,
          temperature: 0.85
        };
        list.push(newProfile);
        currentConfig.apiProfiles = list;
        currentConfig.activeApiId = newId;
        renderApiProfileSelectorAndCard(false);
        persistConfig();
        log("已新增 API 接口，请填写 Base URL 与 API Key", "info");
      });
    }

    // 删除当前 API 接口
    if (delApiBtn) {
      delApiBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const list = currentConfig.apiProfiles || DEFAULT_API_PROFILES;
        if (list.length <= 1) return;
        const active = getActiveApiProfile();
        currentConfig.apiProfiles = list.filter(p => p.id !== active.id);
        currentConfig.activeApiId = currentConfig.apiProfiles[0].id;
        renderApiProfileSelectorAndCard(false);
        persistConfig();
        log(`已删除接口【${active.name}】`, "warn");
      });
    }

    const saveBaseFields = () => {
      const active = getActiveApiProfile();
      currentConfig.apiKey = active ? active.apiKey : "";
      currentConfig.enabled = enableToggle.checked;
      currentConfig.whitelist = whitelistInput.value.trim();
      currentConfig.sparkTime = timeInput.value;
      currentConfig.sparkEnabled = sparkToggle.checked;
      persistConfig();
    };

    enableToggle.addEventListener("change", () => {
      saveBaseFields();
      log(enableToggle.checked ? "自动聊天已开启" : "自动聊天已暂停", enableToggle.checked ? "success" : "warn");
    });
    whitelistInput.addEventListener("input", saveBaseFields);
    timeInput.addEventListener("change", saveBaseFields);
    sparkToggle.addEventListener("change", saveBaseFields);

    // 实时保存当前编辑中的人格分组（边打字边生效！）
    const saveActivePersonaRealtime = () => {
      const activeGroup = getActivePersonaGroup();
      if (!activeGroup.isDefault) {
        activeGroup.name = personaNameInput.value.trim() || "自定义分组";
        activeGroup.friends = personaFriendsInput.value.trim();
      }
      activeGroup.prompt = promptInput.value;
      renderPersonaTabsAndCard(true);
      persistConfig();
    };

    personaNameInput.addEventListener("input", saveActivePersonaRealtime);
    personaFriendsInput.addEventListener("input", saveActivePersonaRealtime);
    promptInput.addEventListener("input", saveActivePersonaRealtime);

    // 填入去人机强化模板
    resetPersonaBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const activeGroup = getActivePersonaGroup();
      const tpl = DEFAULT_PERSONA_GROUPS.find(g => g.id === activeGroup.id) || DEFAULT_PERSONA_GROUPS[1];
      activeGroup.prompt = tpl.prompt;
      promptInput.value = tpl.prompt;
      persistConfig();
      log(`已为【${activeGroup.name}】注入最新去人机强化模板！`, "success");
    });

    // 新增自定义人格组
    addPersonaBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const newId = "custom_" + Date.now();
      const newGroup = {
        id: newId,
        name: "✨ 新人格组",
        isDefault: false,
        friends: "",
        prompt: DEFAULT_PERSONA_GROUPS[1].prompt
      };
      currentConfig.personaGroups.push(newGroup);
      currentConfig.activePersonaId = newId;
      renderPersonaTabsAndCard(false);
      persistConfig();
      log("已新增人格分组，请填写绑定好友与专属人设", "info");
    });

    // 删除当前人格组
    deletePersonaBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const activeGroup = getActivePersonaGroup();
      if (activeGroup.isDefault) return;
      currentConfig.personaGroups = currentConfig.personaGroups.filter(g => g.id !== activeGroup.id);
      currentConfig.activePersonaId = "default";
      renderPersonaTabsAndCard(false);
      persistConfig();
      log(`已删除分组【${activeGroup.name}】`, "warn");
    });

    testKeyBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const active = getActiveApiProfile();
      if (!active.apiKey) {
        log(`请先输入【${active.name}】的 API Key 再进行测试`, "warn");
        return;
      }

      const originalText = testKeyBtn.innerText;
      testKeyBtn.innerText = "测试中...";
      testKeyBtn.disabled = true;
      log(`正在发起对【${active.name}】(${active.model}) 的连通性测试...`, "info");

      try {
        const res = await sendToBackground({
          action: "TEST_API_PROFILE",
          apiProfile: active
        });
        if (res && res.success) {
          log(`✔ 【${active.name}】(${active.model}) 连通成功！可正常使用`, "success");
        } else {
          log(`❌ 连接失败: ${res ? res.error : "未获取到返回结果"}`, "error");
        }
      } catch (err) {
        log(`❌ 异常: ${err.message}`, "error");
      } finally {
        testKeyBtn.innerText = originalText;
        testKeyBtn.disabled = false;
      }
    });

    diagnoseBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.DySparkUI && window.DySparkUI.runDiagnose) {
        window.DySparkUI.runDiagnose();
      } else {
        log("诊断模块尚未就绪，请按 Ctrl+F5 刷新本网页", "warn");
      }
    });

    testSendBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (window.DySparkUI && window.DySparkUI.forceReplyCurrent) {
        window.DySparkUI.forceReplyCurrent();
      } else {
        log("功能模块未就绪，请刷新页面", "warn");
      }
    });

    // 视频互动操作台事件绑定
    const watchVideoBtn = document.getElementById("dy-spark-watch-video-btn");
    const commentVideoBtn = document.getElementById("dy-spark-comment-video-btn");
    const shareVideoBtn = document.getElementById("dy-spark-share-video-btn");

    if (watchVideoBtn) {
      watchVideoBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (window.DySparkUI && window.DySparkUI.watchCurrentVideo) {
          window.DySparkUI.watchCurrentVideo();
        } else {
          log("视频模块尚未就绪，请按 Ctrl+F5 刷新页面", "warn");
        }
      });
    }

    if (commentVideoBtn) {
      commentVideoBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (window.DySparkUI && window.DySparkUI.commentOnCurrentVideo) {
          window.DySparkUI.commentOnCurrentVideo();
        } else {
          log("视频模块尚未就绪，请按 Ctrl+F5 刷新页面", "warn");
        }
      });
    }

    if (shareVideoBtn) {
      shareVideoBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (window.DySparkUI && window.DySparkUI.shareCurrentVideoToBro) {
          window.DySparkUI.shareCurrentVideoToBro();
        } else {
          log("视频模块尚未就绪，请按 Ctrl+F5 刷新页面", "warn");
        }
      });
    }

    const clearLogBtn = document.getElementById("dy-spark-clear-log-btn");
    if (clearLogBtn) {
      clearLogBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const box = document.getElementById("dy-spark-logs");
        if (box) box.innerHTML = "";
        log("日志已清空", "info");
      });
    }

    // 视觉识别配置
    const visionToggle = document.getElementById("dy-spark-vision-toggle");
    const visionProvider = document.getElementById("dy-spark-vision-provider");
    const visionKey = document.getElementById("dy-spark-vision-key");
    const visionUrl = document.getElementById("dy-spark-vision-url");
    const visionModel = document.getElementById("dy-spark-vision-model");
    const visionTestBtn = document.getElementById("dy-spark-test-vision");

    const saveVisionFields = () => {
      currentConfig.visionEnabled = visionToggle.checked;
      currentConfig.visionProvider = visionProvider.value;
      currentConfig.visionApiKey = visionKey.value.trim();
      const preset = VISION_PRESETS[visionProvider.value] || VISION_PRESETS.custom;
      if (visionProvider.value === "custom") {
        currentConfig.visionBaseUrl = visionUrl.value.trim();
        currentConfig.visionModel = visionModel.value.trim();
      } else {
        currentConfig.visionBaseUrl = preset.baseUrl;
        currentConfig.visionModel = preset.model;
      }
      renderVisionCustomBox();
      persistConfig();
    };

    visionToggle.addEventListener("change", saveVisionFields);
    visionProvider.addEventListener("change", saveVisionFields);
    visionKey.addEventListener("input", saveVisionFields);
    visionUrl.addEventListener("input", saveVisionFields);
    visionModel.addEventListener("input", saveVisionFields);

    visionTestBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      let testVisionCfg = getVisionConfig();
      const activeApi = getActiveApiProfile();
      if (!testVisionCfg.apiKey && activeApi && activeApi.isMultimodal && activeApi.apiKey) {
        testVisionCfg = {
          enabled: true,
          apiKey: activeApi.apiKey,
          baseUrl: activeApi.baseUrl,
          model: activeApi.model
        };
      }
      if (!testVisionCfg.apiKey) {
        log("请先在上方配置支持多模态的主模型 Key，或在下方填写辅助视觉模型 API Key", "warn");
        return;
      }
      visionTestBtn.disabled = true;
      log(`正在测试视觉识图能力（使用模型: ${testVisionCfg.model}）...`, "info");
      try {
        const c = document.createElement("canvas");
        c.width = 160;
        c.height = 80;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ffe14d";
        ctx.fillRect(0, 0, 160, 80);
        ctx.fillStyle = "#222";
        ctx.font = "bold 30px sans-serif";
        ctx.fillText("测试OK", 22, 52);
        const res = await sendToBackground(
          {
            action: "DESCRIBE_MEDIA",
            dataUrl: c.toDataURL("image/png"),
            cacheKey: "vision_test_" + Date.now(),
            vision: testVisionCfg
          },
          20000
        );
        if (res && res.success) {
          log(`✔ 视觉识图可用，识别结果: ${res.desc}`, "success");
        } else {
          log(`❌ 视觉模型失败: ${res ? res.error : "无响应"}`, "error");
        }
      } catch (err) {
        log(`❌ 视觉测试异常: ${err.message}`, "error");
      } finally {
        visionTestBtn.disabled = false;
      }
    });
  }

  function renderVisionCustomBox() {
    const box = document.getElementById("dy-spark-vision-custom-box");
    const provider = document.getElementById("dy-spark-vision-provider");
    if (box && provider) {
      box.style.display = provider.value === "custom" ? "flex" : "none";
    }
  }

  function getVisionConfig() {
    return {
      enabled: currentConfig.visionEnabled !== false,
      apiKey: currentConfig.visionApiKey || "",
      baseUrl: currentConfig.visionBaseUrl || "",
      model: currentConfig.visionModel || ""
    };
  }

  function loadConfig() {
    try {
      chrome.storage.local.get(["dy_spark_config"], (result) => {
        if (chrome.runtime.lastError) {
          log("读取配置提示: " + chrome.runtime.lastError.message, "warn");
          return;
        }
        if (result && result.dy_spark_config) {
          const saved = result.dy_spark_config;
          currentConfig = { ...DEFAULT_CONFIG, ...saved };
          if (!saved.personaGroups || !Array.isArray(saved.personaGroups) || saved.personaGroups.length === 0) {
            currentConfig.personaGroups = JSON.parse(JSON.stringify(DEFAULT_PERSONA_GROUPS));
          } else {
            // 自动将旧版容易引发无故攻击或答非所问的默认模板平滑升级为 v2.0 情绪对等自适应模板（完全保留用户填好的好友名单）
            currentConfig.personaGroups.forEach(g => {
              const newTpl = DEFAULT_PERSONA_GROUPS.find(d => d.id === g.id);
              if (
                newTpl &&
                (!g.prompt ||
                  g.prompt.includes("回复原则：\n1. 极度熟稔接地气") ||
                  g.prompt.includes("回复原则：\n1. 极简口语化") ||
                  g.prompt.includes("对方发啥你都可以阴阳怪气") ||
                  g.prompt.includes("每次回复必须换不同的切入点") ||
                  g.prompt.includes("对方是你的十年铁哥们/死党损友") ||
                  g.prompt.includes("【第一原则：精准听懂人话") ||
                  g.prompt.includes("【情绪对等原则（人不犯我，我不犯人）】"))
              ) {
                g.prompt = newTpl.prompt;
              }
            });
          }

          // 自动平滑迁移或初始化多接口列表
          if (!saved.apiProfiles || !Array.isArray(saved.apiProfiles) || saved.apiProfiles.length === 0) {
            currentConfig.apiProfiles = JSON.parse(JSON.stringify(DEFAULT_API_PROFILES));
            if (saved.apiKey) {
              currentConfig.apiProfiles[0].apiKey = saved.apiKey;
              currentConfig.apiProfiles[1].apiKey = saved.apiKey;
            }
          }
        }

        renderApiProfileSelectorAndCard(false);

        document.getElementById("dy-spark-enable-toggle").checked = currentConfig.enabled;
        document.getElementById("dy-spark-whitelist").value = currentConfig.whitelist;
        document.getElementById("dy-spark-time").value = currentConfig.sparkTime;
        document.getElementById("dy-spark-spark-toggle").checked = currentConfig.sparkEnabled;

        document.getElementById("dy-spark-vision-toggle").checked = currentConfig.visionEnabled !== false;
        document.getElementById("dy-spark-vision-provider").value = currentConfig.visionProvider || "zhipu";
        document.getElementById("dy-spark-vision-key").value = currentConfig.visionApiKey || "";
        document.getElementById("dy-spark-vision-url").value = currentConfig.visionBaseUrl || "";
        document.getElementById("dy-spark-vision-model").value = currentConfig.visionModel || "";
        renderVisionCustomBox();

        renderPersonaTabsAndCard(false);
        updateStatus(currentConfig.enabled);
        log("抖音火花助手 AI 已就绪 (v2.4.0 深度表情包潜台词识别+真人交互版)", "info");
        const activeApi = getActiveApiProfile();
        if (activeApi && !activeApi.apiKey) {
          log(`ℹ 提示：当前选中的【${activeApi.name}】未配置 API Key，请在上方填写`, "warn");
        }
        configChangeCallbacks.forEach(cb => cb(currentConfig));
      });
    } catch (err) {
      log("初始化异常，请按 F5 刷新: " + err.message, "warn");
    }
  }

  function updateStatus(active) {
    const dot = document.getElementById("dy-spark-dot");
    const pill = document.getElementById("dy-spark-status-pill");
    const text = document.getElementById("dy-spark-status-text");
    if (!dot) return;
    if (active) {
      dot.classList.add("active");
      if (pill) pill.classList.add("active");
      if (text) text.textContent = "巡检中";
    } else {
      dot.classList.remove("active");
      if (pill) pill.classList.remove("active");
      if (text) text.textContent = "待机中";
    }
  }

  function log(text, type = "info") {
    const box = document.getElementById("dy-spark-logs");
    if (!box) return;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const div = document.createElement("div");
    div.className = `dy-spark-log-item ${type}`;
    div.textContent = `[${timeStr}] ${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function getPriorityBroInfo() {
    const groups = currentConfig.personaGroups || DEFAULT_PERSONA_GROUPS;
    const broGroup = groups.find(g => g.id === "bro") || groups.find(g => !g.isDefault && g.friends) || groups[0];
    const friendsList = (broGroup.friends || "").split(/[,，\n]/).map(s => normalizeFriendName(s)).filter(Boolean);
    return {
      groupName: broGroup.name || "🔥 死党/损友",
      prompt: broGroup.prompt || DEFAULT_PERSONA_GROUPS[1].prompt,
      friendsList: friendsList,
      firstBro: friendsList[0] || ""
    };
  }

  window.DySparkUI = {
    getConfig: () => {
      const active = getActiveApiProfile();
      return {
        ...currentConfig,
        apiKey: active ? active.apiKey : (currentConfig.apiKey || ""),
        activeApiProfile: active
      };
    },
    getActiveApiProfile: getActiveApiProfile,
    getApiProfiles: () => currentConfig.apiProfiles || DEFAULT_API_PROFILES,
    getVisionConfig: getVisionConfig,
    getPersonaForFriend: getPersonaForFriend,
    getPriorityBroInfo: getPriorityBroInfo,
    log: log,
    updateStatus: updateStatus,
    onConfigChange: (cb) => configChangeCallbacks.push(cb)
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDOM);
  } else {
    initDOM();
  }
})();
