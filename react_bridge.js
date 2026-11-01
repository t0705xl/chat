// 抖音火花助手 - React Fiber 表情包真实语义提取桥接脚本 (运行于 MAIN World, v2.0.0)
(function () {
  if (window.__dySparkReactBridgeInstalled) return;
  window.__dySparkReactBridgeInstalled = true;

  const GENERIC_LABELS = new Set([
    "表情",
    "[表情]",
    "动画表情",
    "[动画表情]",
    "贴纸",
    "[贴纸]",
    "图片",
    "[图片]",
    "头像",
    "image",
    "sticker",
    "emoji"
  ]);

  function isMeaningfulLabel(str) {
    if (!str || typeof str !== "string") return false;
    const clean = str.trim();
    if (clean.length < 1 || clean.length > 28) return false;
    if (/^https?:\/\//i.test(clean) || /^[0-9a-f-]{12,}$/i.test(clean)) return false;
    if (GENERIC_LABELS.has(clean.toLowerCase())) return false;
    return true;
  }

  function searchObjectForStickerMeaning(obj, depth = 0, visited = new Set()) {
    if (!obj || typeof obj !== "object" || depth > 4 || visited.has(obj)) return "";
    visited.add(obj);

    const priorityKeys = [
      "display_name",
      "displayName",
      "sticker_name",
      "stickerName",
      "emoji_name",
      "emojiName",
      "keyword",
      "meaning",
      "description",
      "title",
      "name",
      "text",
      "hint"
    ];

    for (const k of priorityKeys) {
      if (typeof obj[k] === "string" && isMeaningfulLabel(obj[k])) {
        return obj[k].trim();
      }
    }

    if (obj.ext && typeof obj.ext === "object") {
      for (const ek of Object.keys(obj.ext)) {
        if (/name|text|title|desc|keyword|hint/i.test(ek) && isMeaningfulLabel(obj.ext[ek])) {
          return obj.ext[ek].trim();
        }
      }
    }

    const containerKeys = ["message", "msg", "item", "content", "sticker", "stickerInfo", "emoji", "data", "rawContent"];
    for (const ck of containerKeys) {
      if (obj[ck] && typeof obj[ck] === "object") {
        const res = searchObjectForStickerMeaning(obj[ck], depth + 1, visited);
        if (res) return res;
      } else if (typeof obj[ck] === "string" && ck === "content" && obj[ck].startsWith("{")) {
        try {
          const parsed = JSON.parse(obj[ck]);
          const res = searchObjectForStickerMeaning(parsed, depth + 1, visited);
          if (res) return res;
        } catch (e) {}
      }
    }

    return "";
  }

  function extractFromReactFiber(domEl) {
    let curr = domEl;
    for (let step = 0; step < 6 && curr && curr !== document.body; step++) {
      const keys = Object.keys(curr);
      for (const k of keys) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
          let fiber = curr[k];
          for (let fStep = 0; fStep < 8 && fiber; fStep++) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props) {
              const found = searchObjectForStickerMeaning(props);
              if (found) return found;
            }
            fiber = fiber.return;
          }
        } else if (k.startsWith("__reactProps$")) {
          const found = searchObjectForStickerMeaning(curr[k]);
          if (found) return found;
        }
      }
      curr = curr.parentElement;
    }
    return "";
  }

  function scanAndTagStickers() {
    try {
      const imgs = document.querySelectorAll("img, canvas");
      for (const img of imgs) {
        if (img.dataset && img.dataset.dyStickerChecked === "1") continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 18 || rect.height < 18 || rect.top < 60) continue;

        if (img.dataset) img.dataset.dyStickerChecked = "1";
        const meaning = extractFromReactFiber(img);
        if (meaning && img.dataset) {
          img.dataset.dyStickerMeaning = meaning;
        }
      }
    } catch (e) {}
  }

  setInterval(scanAndTagStickers, 700);
})();
