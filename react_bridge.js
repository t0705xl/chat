// 抖音火花助手 - React Fiber 表情包/梗图/引用消息真实语义提取桥接脚本 (运行于 MAIN World, v2.4.0)
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
    "自定义表情",
    "[自定义表情]",
    "image",
    "sticker",
    "emoji",
    "gif"
  ]);

  function isMeaningfulLabel(str) {
    if (!str || typeof str !== "string") return false;
    const clean = str.trim();
    if (clean.length < 1 || clean.length > 42) return false;
    if (/^https?:\/\//i.test(clean) || /^blob:/i.test(clean) || /^[0-9a-f-]{12,}$/i.test(clean)) return false;
    if (/^\d+$/.test(clean)) return false;
    if (GENERIC_LABELS.has(clean.toLowerCase())) return false;
    return true;
  }

  function extractUrlFromObject(obj, depth = 0, visited = new Set()) {
    if (!obj || typeof obj !== "object" || depth > 4 || visited.has(obj)) return "";
    visited.add(obj);

    const urlArrayKeys = ["url_list", "urlList", "animate_url_list", "static_url_list", "origin_url_list"];
    for (const k of urlArrayKeys) {
      if (Array.isArray(obj[k]) && obj[k].length > 0 && typeof obj[k][0] === "string" && /^https?:\/\//i.test(obj[k][0])) {
        return obj[k][0];
      }
    }

    const urlObjKeys = ["animate_url", "animateUrl", "origin_url", "originUrl", "static_url", "staticUrl", "resource_url", "display_url"];
    for (const uk of urlObjKeys) {
      if (typeof obj[uk] === "string" && /^https?:\/\//i.test(obj[uk])) {
        return obj[uk];
      }
      if (obj[uk] && typeof obj[uk] === "object") {
        const sub = extractUrlFromObject(obj[uk], depth + 1, visited);
        if (sub) return sub;
      }
    }

    return "";
  }

  function searchObjectForStickerMeaning(obj, depth = 0, visited = new Set()) {
    if (!obj || typeof obj !== "object" || depth > 5 || visited.has(obj)) return { meaning: "", url: "" };
    visited.add(obj);

    let foundMeaning = "";
    let foundUrl = extractUrlFromObject(obj, 0, new Set());

    const priorityKeys = [
      "display_name",
      "displayName",
      "sticker_name",
      "stickerName",
      "emoji_name",
      "emojiName",
      "ocr_text",
      "ocrText",
      "keyword",
      "meaning",
      "description",
      "share_title",
      "item_title",
      "title",
      "name",
      "text",
      "hint"
    ];

    for (const k of priorityKeys) {
      if (typeof obj[k] === "string" && isMeaningfulLabel(obj[k])) {
        foundMeaning = obj[k].trim();
        break;
      }
    }

    if (!foundMeaning && obj.ext && typeof obj.ext === "object") {
      for (const ek of Object.keys(obj.ext)) {
        if (/name|text|title|desc|keyword|hint|ocr/i.test(ek) && isMeaningfulLabel(obj.ext[ek])) {
          foundMeaning = obj.ext[ek].trim();
          break;
        }
      }
    }

    if (foundMeaning && foundUrl) {
      return { meaning: foundMeaning, url: foundUrl };
    }

    const containerKeys = [
      "message",
      "msg",
      "item",
      "content",
      "sticker",
      "stickerInfo",
      "emoji",
      "data",
      "rawContent",
      "aweme",
      "share_info"
    ];
    for (const ck of containerKeys) {
      if (obj[ck] && typeof obj[ck] === "object") {
        const res = searchObjectForStickerMeaning(obj[ck], depth + 1, visited);
        if (!foundMeaning && res.meaning) foundMeaning = res.meaning;
        if (!foundUrl && res.url) foundUrl = res.url;
        if (foundMeaning && foundUrl) break;
      } else if (typeof obj[ck] === "string" && (ck === "content" || ck === "rawContent") && obj[ck].trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(obj[ck]);
          const res = searchObjectForStickerMeaning(parsed, depth + 1, visited);
          if (!foundMeaning && res.meaning) foundMeaning = res.meaning;
          if (!foundUrl && res.url) foundUrl = res.url;
          if (foundMeaning && foundUrl) break;
        } catch (e) {}
      }
    }

    return { meaning: foundMeaning, url: foundUrl };
  }

  function extractFromReactFiber(domEl) {
    let curr = domEl;
    let bestMeaning = "";
    let bestUrl = "";

    for (let step = 0; step < 7 && curr && curr !== document.body; step++) {
      const keys = Object.keys(curr);
      for (const k of keys) {
        if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
          let fiber = curr[k];
          for (let fStep = 0; fStep < 9 && fiber; fStep++) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props) {
              const res = searchObjectForStickerMeaning(props);
              if (!bestMeaning && res.meaning) bestMeaning = res.meaning;
              if (!bestUrl && res.url) bestUrl = res.url;
              if (bestMeaning && bestUrl) return { meaning: bestMeaning, url: bestUrl };
            }
            fiber = fiber.return;
          }
        } else if (k.startsWith("__reactProps$")) {
          const res = searchObjectForStickerMeaning(curr[k]);
          if (!bestMeaning && res.meaning) bestMeaning = res.meaning;
          if (!bestUrl && res.url) bestUrl = res.url;
          if (bestMeaning && bestUrl) return { meaning: bestMeaning, url: bestUrl };
        }
      }
      curr = curr.parentElement;
    }
    return { meaning: bestMeaning, url: bestUrl };
  }

  function scanAndTagStickers() {
    try {
      const mediaEls = document.querySelectorAll("img, canvas, video");
      for (const el of mediaEls) {
        if (!el.dataset) continue;
        const curSrc = el.currentSrc || el.src || el.getAttribute("src") || "canvas";
        // 如果 src 未变且已成功提取到含义，则跳过；若虚拟列表复用了节点导致 src 变化，则重新提取！
        if (el.dataset.dyStickerCheckedSrc === curSrc && el.dataset.dyStickerMeaning) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width < 18 || rect.height < 18 || rect.top < 55) continue;

        el.dataset.dyStickerCheckedSrc = curSrc;
        const { meaning, url } = extractFromReactFiber(el);
        if (meaning) {
          el.dataset.dyStickerMeaning = meaning;
        }
        if (url) {
          el.dataset.dyFiberImgUrl = url;
        }
      }
    } catch (e) {}
  }

  setInterval(scanAndTagStickers, 600);
})();
