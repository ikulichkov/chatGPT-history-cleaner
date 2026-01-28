// Chat History Cleaner - Content Script
(function() {
  'use strict';

  if (window.__CHAT_HISTORY_CLEANER_CS_INIT__) {
    return;
  }
  window.__CHAT_HISTORY_CLEANER_CS_INIT__ = true;

  // Конфигурация по умолчанию
  const DEFAULT_CONFIG = {
    enabled: true,
    firstN: 5,  // Количество первых блоков
    lastN: 5   // Количество последних блоков
  };

  let config = { ...DEFAULT_CONFIG };
  let observer = null;
  // Map для хранения удаленных блоков: ключ - индекс, значение - {html, nextSibling, parent}
  let hiddenBlocks = new Map();
  let initialPageSize = null;
  let isCleaning = false; // Флаг для предотвращения повторных запусков

  /** Есть ли в узле разметка ходов чата (а не пустой скролл) */
  function containerHasConversationTurns(el) {
    if (!el) return false;
    return !!el.querySelector(
      '[data-message-author-role], article, [data-message-content], div[class*="text-message"], section.text-token-text-primary'
    );
  }

  /**
   * Контейнер ленты: новый ChatGPT держит сообщения в [data-scroll-root],
   * раньше — main#main > #thread. Без scroll-root иногда выбирали слишком широкий main.
   */
  function getThreadContainer() {
    const legacy =
      document.querySelector('main#main > div#thread') ||
      document.querySelector('div#thread');
    if (legacy) return legacy;

    const scrollRoots = document.querySelectorAll('[data-scroll-root]');
    for (let i = 0; i < scrollRoots.length; i++) {
      const root = scrollRoots[i];
      if (containerHasConversationTurns(root)) return root;
    }

    const mainEl =
      document.querySelector('main#main') ||
      document.querySelector('#main') ||
      document.querySelector('main');
    if (mainEl && containerHasConversationTurns(mainEl)) return mainEl;

    if (scrollRoots.length > 0) return scrollRoots[0];
    return mainEl || null;
  }

  /** Сообщения с data-message-author-role (актуальный ChatGPT) — только «корневые» узлы */
  function getOutermostRoleNodes(container) {
    if (!container) return [];
    const candidates = Array.from(
      container.querySelectorAll('[data-message-author-role]')
    ).filter((el) => {
      const r = el.getAttribute('data-message-author-role');
      return r === 'user' || r === 'assistant';
    });
    return candidates.filter((el) => {
      let parent = el.parentElement;
      while (parent && parent !== container) {
        if (
          parent.matches &&
          parent.matches(
            '[data-message-author-role="user"], [data-message-author-role="assistant"]'
          )
        ) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  /** Группы по ролям: user + следующий assistant в одну группу */
  function buildMessageGroupsFromRoles(container) {
    const nodes = getOutermostRoleNodes(container);
    const groups = [];
    const processed = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (processed.has(node)) continue;
      const role = node.getAttribute('data-message-author-role');
      if (role === 'user') {
        const next = nodes[i + 1];
        const nextRole = next && next.getAttribute('data-message-author-role');
        if (next && nextRole === 'assistant' && !processed.has(next)) {
          groups.push({
            elements: [node, next],
            firstElement: node,
            index: groups.length
          });
          processed.add(node);
          processed.add(next);
          continue;
        }
      }
      groups.push({
        elements: [node],
        firstElement: node,
        index: groups.length
      });
      processed.add(node);
    }
    return groups;
  }

  /**
   * Пузыри сообщений по классу text-message (виртуализация: роль есть не у всех ходов).
   * Берём только «листья» — без вложенных div с тем же классом.
   */
  function getOuterTextMessageDivs(container) {
    if (!container) return [];
    const all = Array.from(
      container.querySelectorAll('div[class*="text-message"]')
    );
    if (all.length === 0) return [];
    return all.filter(
      (el) => !all.some((o) => o !== el && o.contains(el))
    );
  }

  /**
   * Группы из внешних text-message: пары подряд = один ход (user+assistant).
   * Если на узлах есть role — сверяем; иначе полагаемся на порядок в ленте.
   */
  function buildMessageGroupsFromTextMessageBubbles(container) {
    const outer = getOuterTextMessageDivs(container);
    if (outer.length === 0) return [];

    const groups = [];
    let i = 0;
    while (i < outer.length) {
      const cur = outer[i];
      const next = outer[i + 1];
      const rc = cur.getAttribute('data-message-author-role');
      const rn = next && next.getAttribute('data-message-author-role');

      if (rc === 'user' && rn === 'assistant' && next) {
        groups.push({
          elements: [cur, next],
          firstElement: cur,
          index: groups.length
        });
        i += 2;
        continue;
      }
      if (rc === 'assistant') {
        groups.push({
          elements: [cur],
          firstElement: cur,
          index: groups.length
        });
        i += 1;
        continue;
      }
      if (next) {
        groups.push({
          elements: [cur, next],
          firstElement: cur,
          index: groups.length
        });
        i += 2;
        continue;
      }
      groups.push({
        elements: [cur],
        firstElement: cur,
        index: groups.length
      });
      i += 1;
    }
    return groups;
  }

  /**
   * Секции хода в новом UI (section.text-token-text-primary).
   * Иногда в DOM больше секций, чем пар с data-message-author-role (виртуализация).
   */
  function getConversationSections(container) {
    if (!container) return [];
    const all = Array.from(
      container.querySelectorAll('section.text-token-text-primary')
    );
    const withMessage = all.filter((sec) => {
      if (!container.contains(sec)) return false;
      return !!sec.querySelector(
        '[data-message-author-role], div[class*="text-message"]'
      );
    });
    return withMessage.filter((sec) => {
      let parent = sec.parentElement;
      while (parent && parent !== container) {
        if (
          parent.matches &&
          parent.matches('section.text-token-text-primary')
        ) {
          return false;
        }
        parent = parent.parentElement;
      }
      return true;
    });
  }

  function buildMessageGroupsFromSections(container) {
    const sections = getConversationSections(container);
    if (sections.length === 0) return [];
    return sections.map((section, idx) => ({
      elements: [section],
      firstElement: section,
      index: idx
    }));
  }

  /** Старый разбор по article + тексту «You said» / «ChatGPT said» */
  function buildMessageGroupsFromArticles(container) {
    const allArticles = container.querySelectorAll('article');
    if (allArticles.length === 0) return [];

    const messageGroups = [];
    const processed = new Set();
    const articlesArray = Array.from(allArticles);

    articlesArray.forEach((article, index) => {
      if (processed.has(article)) return;

      const text = (article.textContent || '').trim();
      const isUserMessage =
        text.includes('Вы сказали:') ||
        text.includes('You said:') ||
        text.startsWith('Вы сказали:') ||
        text.startsWith('You said:');
      const isAssistantMessage =
        text.includes('ChatGPT сказал:') ||
        text.includes('ChatGPT said:') ||
        text.startsWith('ChatGPT сказал:') ||
        text.startsWith('ChatGPT said:');

      if (isUserMessage) {
        let assistantArticle = null;
        for (let i = index + 1; i < articlesArray.length; i++) {
          if (processed.has(articlesArray[i])) continue;

          const nextText = (articlesArray[i].textContent || '').trim();
          const nextIsAssistant =
            nextText.includes('ChatGPT сказал:') ||
            nextText.includes('ChatGPT said:') ||
            nextText.startsWith('ChatGPT сказал:') ||
            nextText.startsWith('ChatGPT said:');

          if (nextIsAssistant) {
            assistantArticle = articlesArray[i];
            break;
          }

          const nextIsUser =
            nextText.includes('Вы сказали:') ||
            nextText.includes('You said:') ||
            nextText.startsWith('Вы сказали:') ||
            nextText.startsWith('You said:');
          if (nextIsUser) break;
        }

        if (assistantArticle && !processed.has(assistantArticle)) {
          messageGroups.push({
            elements: [article, assistantArticle],
            firstElement: article,
            index: messageGroups.length
          });
          processed.add(article);
          processed.add(assistantArticle);
        } else {
          messageGroups.push({
            elements: [article],
            firstElement: article,
            index: messageGroups.length
          });
          processed.add(article);
        }
      } else if (isAssistantMessage) {
        messageGroups.push({
          elements: [article],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
      } else {
        messageGroups.push({
          elements: [article],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
      }
    });

    return messageGroups;
  }

  /** Пары подряд идущих article (если нет ни ролей, ни меток в тексте) */
  function buildMessageGroupsFromArticlesSequential(container) {
    const allArticles = container.querySelectorAll('article');
    if (allArticles.length === 0) return [];

    const messageGroups = [];
    const processed = new Set();

    Array.from(allArticles).forEach((article, index) => {
      if (processed.has(article)) return;
      const nextArticle = allArticles[index + 1];
      if (nextArticle && !processed.has(nextArticle)) {
        messageGroups.push({
          elements: [article, nextArticle],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
        processed.add(nextArticle);
      } else {
        messageGroups.push({
          elements: [article],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
      }
    });

    return messageGroups;
  }

  /** Ходы по article, найденным через [data-message-content] (роли в DOM могут отсутствовать) */
  function buildMessageGroupsFromContentAnchors(container) {
    const anchors = container.querySelectorAll('[data-message-content]');
    if (!anchors.length) return [];

    const orderedArticles = [];
    const seen = new Set();
    anchors.forEach((anchor) => {
      const article = anchor.closest && anchor.closest('article');
      if (!article || seen.has(article)) return;
      seen.add(article);
      orderedArticles.push(article);
    });

    if (orderedArticles.length === 0) return [];

    const groups = [];
    for (let i = 0; i < orderedArticles.length; i += 2) {
      const a = orderedArticles[i];
      const b = orderedArticles[i + 1];
      if (b) {
        groups.push({
          elements: [a, b],
          firstElement: a,
          index: groups.length
        });
      } else {
        groups.push({
          elements: [a],
          firstElement: a,
          index: groups.length
        });
      }
    }
    return groups;
  }

  function buildMessageGroups(container) {
    if (!container) return [];
    const fromSections = buildMessageGroupsFromSections(container);
    const fromRoles = buildMessageGroupsFromRoles(container);
    const fromBubbles = buildMessageGroupsFromTextMessageBubbles(container);
    const maxLegacy = Math.max(fromRoles.length, fromBubbles.length);

    if (fromSections.length > maxLegacy) {
      return fromSections;
    }
    if (fromBubbles.length > fromRoles.length) {
      return fromBubbles;
    }
    if (fromRoles.length > 0) return fromRoles;

    const fromArticles = buildMessageGroupsFromArticles(container);
    const hasLabeledTurn =
      fromArticles.length > 0 &&
      fromArticles.some((g) => {
        const t = (g.firstElement.textContent || '').trim();
        return (
          t.includes('You said:') ||
          t.includes('Вы сказали:') ||
          t.includes('ChatGPT said:') ||
          t.includes('ChatGPT сказал:')
        );
      });
    if (hasLabeledTurn) return fromArticles;

    const sequential = buildMessageGroupsFromArticlesSequential(container);
    if (sequential.length > 0) return sequential;
    if (fromArticles.length > 0) return fromArticles;

    return buildMessageGroupsFromContentAnchors(container);
  }

  // Загрузка настроек из storage
  async function loadConfig() {
    try {
      const result = await chrome.storage.sync.get(['chatHistoryConfig']);
      if (result.chatHistoryConfig) {
        config = { ...DEFAULT_CONFIG, ...result.chatHistoryConfig };
      }
    } catch (error) {
      console.error('Error loading config:', error);
    }
    applyHistoryCleaner();
  }

  // Сохранение настроек
  async function saveConfig() {
    try {
      await chrome.storage.sync.set({ chatHistoryConfig: config });
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  // Проверка готовности страницы
  function isPageReady() {
    const thread = getThreadContainer();
    if (!thread) return false;

    const blocks = getMessageBlocks();
    if (blocks.length === 0) return false;

    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) return false;
    // Раньше требовали ≥10 символов — короткие ответы («да», «ok») навсегда блокировали очистку
    return lastBlock.textContent.trim().length >= 1;
  }

  // Измерение размера страницы
  function measurePageSize(onlyVisible = false) {
    const thread = getThreadContainer();
    if (!thread) return null;
    
    try {
      let html;
      
      if (onlyVisible) {
        // Измеряем только видимые элементы (те, что остались в DOM)
        const visibleBlocks = getMessageBlocks();
        
        // Собираем HTML только видимых блоков (они уже в DOM, скрытые удалены)
        html = Array.from(visibleBlocks).map(el => el.outerHTML).join('');
      } else {
        // Измеряем все элементы (до очистки)
        html = thread.innerHTML;
      }
      
      const sizeInBytes = new Blob([html]).size;
      
      // Считаем количество элементов
      const elementCount = onlyVisible 
        ? thread.querySelectorAll('*:not(.chat-history-hidden):not([style*="display: none"])').length
        : thread.querySelectorAll('*').length;
      
      // Считаем количество блоков сообщений
      const blocks = getMessageBlocks();
      const visibleBlocks = onlyVisible 
        ? blocks.length // Если onlyVisible, то все блоки в DOM уже видимые (скрытые удалены)
        : blocks.length + hiddenBlocks.size; // До очистки: видимые + скрытые
      
      return {
        sizeBytes: sizeInBytes,
        sizeKB: (sizeInBytes / 1024).toFixed(2),
        sizeMB: (sizeInBytes / (1024 * 1024)).toFixed(2),
        elementCount: elementCount,
        blockCount: visibleBlocks,
        totalBlocks: blocks.length
      };
    } catch (error) {
      console.error('Error measuring page size:', error);
      return null;
    }
  }

  // Сохранение статистики
  async function saveStatistics(before, after) {
    try {
      await chrome.storage.local.set({
        pageStatistics: {
          before: before,
          after: after,
          savedBytes: before ? (before.sizeBytes - (after ? after.sizeBytes : 0)) : 0,
          savedPercent: before && after ? (((before.sizeBytes - after.sizeBytes) / before.sizeBytes) * 100).toFixed(1) : 0,
          timestamp: Date.now()
        }
      });
    } catch (error) {
      console.error('Error saving statistics:', error);
    }
  }

  // Первые элементы групп сообщений (та же логика, что и при очистке)
  function getMessageBlocks() {
    const container = getThreadContainer();
    if (!container) return [];
    const messageGroups = buildMessageGroups(container);
    return messageGroups.map((group) => group.firstElement);
  }

  // Функции для кнопки "Показать ответ" удалены - блоки удаляются без возможности восстановления

  /**
   * Корневой узел хода для удаления: иначе снимается только внутренний text-message,
   * а section / toolbars / обёртки React остаются в DOM.
   */
  function findTurnRemovalRoot(el, threadRoot) {
    if (!el || !threadRoot || !threadRoot.contains(el)) return el;

    const article = el.closest('article');
    if (article && threadRoot.contains(article)) return article;

    const sectionMarked = el.closest('section.text-token-text-primary');
    if (sectionMarked && threadRoot.contains(sectionMarked)) {
      return sectionMarked;
    }

    const turnShell =
      el.closest('[class*="group/turn-message"]') ||
      el.closest('[class*="turn-message"]');
    if (turnShell && threadRoot.contains(turnShell)) return turnShell;

    return el;
  }

  // Удалить группу блоков из DOM (без возможности восстановления)
  function hideBlockGroup(group, index, threadRoot) {
    if (hiddenBlocks.has(index)) return;

    const roots = new Set();
    group.elements.forEach((el) => {
      roots.add(findTurnRemovalRoot(el, threadRoot));
    });
    roots.forEach((node) => {
      if (node && node.parentNode) node.remove();
    });

    hiddenBlocks.set(index, { removed: true });
  }

  // Применение очистки истории
  function applyHistoryCleaner(force = false) {
    // Проверяем готовность страницы перед измерением
    if (!force && !isPageReady()) {
      // Если страница еще не готова, откладываем измерение
      setTimeout(() => {
        if (isPageReady()) {
          applyHistoryCleaner();
        }
      }, 500);
      return;
    }
    
    let beforeSize = null;
    
    // Измеряем размер до очистки (только при первом запуске или если включено)
    if (config.enabled && initialPageSize === null) {
      beforeSize = measurePageSize(false); // Измеряем все элементы
      if (beforeSize) {
        initialPageSize = beforeSize;
      }
    } else if (!config.enabled) {
      initialPageSize = null;
    }
    
    if (!config.enabled) {
      // Блоки уже удалены из DOM, просто очищаем Map
      hiddenBlocks.clear();
      
      // Сохраняем статистику (все показано)
      if (initialPageSize) {
        setTimeout(() => {
          const afterSize = measurePageSize(false);
          if (afterSize) {
            saveStatistics(initialPageSize, afterSize);
          }
        }, 300);
      }
      return;
    }

    // Каждый проход — заново по текущему DOM; старые индексы в Map ломали повторные прогоны
    hiddenBlocks.clear();

    const thread = getThreadContainer();
    if (!thread) {
      console.log('[Chat History Cleaner] Thread container not found');
      return;
    }

    const messageGroups = buildMessageGroups(thread);

    if (messageGroups.length === 0) {
      isCleaning = false;
      return;
    }

    const totalGroups = messageGroups.length;
    const firstN = Math.max(0, (config.firstN !== undefined && config.firstN !== null) ? config.firstN : 5); // Оставляем первые N пар сообщений (минимум 0)
    const lastN = Math.max(1, (config.lastN !== undefined && config.lastN !== null) ? config.lastN : 5);  // Оставляем последние N пар сообщений (минимум 1)
    
    // Если групп меньше или равно (firstN + lastN), ничего не делаем
    if (totalGroups <= (firstN + lastN)) {
      isCleaning = false;
      finishWork(); // Завершаем работу, если нечего удалять
      return;
    }

    // Оставляем первые 5 и последние 5 пар сообщений, удаляем пары в середине
    messageGroups.forEach((group, groupIndex) => {
      // Проверяем, является ли группа одной из первых 5 или последних 5
      const isFirstN = groupIndex < firstN;
      const isLastN = groupIndex >= totalGroups - lastN;
      const shouldKeep = isFirstN || isLastN;
      
      if (shouldKeep) {
        // Это одна из первых 5 или последних 5 пар - ОСТАВЛЯЕМ
        // Ничего не делаем, группа уже видна
      } else {
        // Это группа в середине - УДАЛЯЕМ из DOM
        if (!hiddenBlocks.has(groupIndex)) {
          hideBlockGroup(group, groupIndex, thread);
        }
      }
    });
    
    // Снимаем флаг после завершения
    setTimeout(() => {
      isCleaning = false;
    }, 100);
    
    // Измеряем размер после очистки и сохраняем статистику
    // Используем большую задержку, чтобы DOM успел обновиться
    if (beforeSize || initialPageSize) {
      setTimeout(() => {
        const afterSize = measurePageSize(true); // Измеряем только видимые элементы
        const baseSize = beforeSize || initialPageSize;
        if (baseSize && afterSize && baseSize.sizeBytes > 0) {
          // Проверяем, что размер после действительно меньше
          if (afterSize.sizeBytes < baseSize.sizeBytes) {
            saveStatistics(baseSize, afterSize);
          }
        }
        // Снимаем флаг после завершения
        isCleaning = false;
        // Завершаем работу расширения
        finishWork();
      }, 500);
    } else {
      // Снимаем флаг сразу, если не нужно измерять размер
      setTimeout(() => {
        isCleaning = false;
        // Завершаем работу расширения
        finishWork();
      }, 100);
    }
  }

  // Сброс флага очистки; observer оставляем — при новых репликах снова сработает applyHistoryCleaner
  function finishWork() {
    isCleaning = false;
  }

  // Обработка новых сообщений
  function observeNewMessages() {
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      // Игнорируем изменения, если идет очистка
      if (isCleaning) {
        return;
      }
      
      let shouldUpdate = false;
      
      mutations.forEach((mutation) => {
        // Игнорируем удаления (это мы сами удаляем элементы)
        if (mutation.removedNodes.length > 0) {
          // Все удаления article считаем нашими
          let isOurRemoval = false;
          mutation.removedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.tagName === 'ARTICLE') isOurRemoval = true;
            if (
              node.tagName === 'SECTION' &&
              node.matches &&
              node.matches('section.text-token-text-primary')
            ) {
              isOurRemoval = true;
            }
          });
          if (isOurRemoval) {
            return; // Игнорируем наши удаления
          }
        }
        
        if (mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              if (node.matches && node.matches('article')) {
                shouldUpdate = true;
              } else if (
                node.matches &&
                node.matches('[data-message-author-role]')
              ) {
                shouldUpdate = true;
              } else if (node.querySelector && node.querySelector('article')) {
                shouldUpdate = true;
              } else if (
                node.querySelector &&
                node.querySelector('[data-message-author-role]')
              ) {
                shouldUpdate = true;
              } else if (
                node.matches &&
                node.matches('[data-message-content]')
              ) {
                shouldUpdate = true;
              } else if (
                node.querySelector &&
                node.querySelector('[data-message-content]')
              ) {
                shouldUpdate = true;
              } else if (
                node.matches &&
                node.matches('div[class*="text-message"]')
              ) {
                shouldUpdate = true;
              } else if (
                node.querySelector &&
                node.querySelector('div[class*="text-message"]')
              ) {
                shouldUpdate = true;
              } else if (
                node.matches &&
                node.matches('section.text-token-text-primary')
              ) {
                shouldUpdate = true;
              } else if (
                node.querySelector &&
                node.querySelector('section.text-token-text-primary')
              ) {
                shouldUpdate = true;
              }
            }
          });
        }
      });

      if (shouldUpdate && !isCleaning) {
        // Увеличиваем задержку для завершения рендеринга
        setTimeout(() => {
          if (!isCleaning) {
            applyHistoryCleaner();
          }
        }, 1000); // Увеличиваем задержку до 1 секунды
      }
    });

    const targetNode = getThreadContainer();
    if (targetNode) {
      observer.observe(targetNode, {
        childList: true,
        subtree: true
      });
    }
  }

  // Слушатель изменений настроек
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.chatHistoryConfig) {
      config = { ...DEFAULT_CONFIG, ...changes.chatHistoryConfig.newValue };
      // Если настройки изменились, перезапускаем работу
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      isCleaning = false;
      initialPageSize = null;
      hiddenBlocks.clear();
      observeNewMessages();
      applyHistoryCleaner();
    }
  });

  function describeEl(el, textMax = 160) {
    if (!el || el.nodeType !== 1) return null;
    const cls = el.className ? String(el.className).slice(0, 160) : '';
    return {
      tag: el.tagName,
      id: el.id || null,
      className: cls || null,
      dataScrollRoot: el.getAttribute('data-scroll-root'),
      dataMessageAuthorRole: el.getAttribute('data-message-author-role'),
      childElementCount: el.childElementCount,
      textPreview: (el.textContent || '').trim().slice(0, textMax)
    };
  }

  function collectDebugInfo() {
    const manifest = chrome.runtime.getManifest();
    const thread = getThreadContainer();
    const groups = thread ? buildMessageGroups(thread) : [];
    const firstN = Math.max(
      0,
      config.firstN !== undefined && config.firstN !== null ? config.firstN : 5
    );
    const lastN = Math.max(
      1,
      config.lastN !== undefined && config.lastN !== null ? config.lastN : 5
    );
    const totalGroups = groups.length;
    const keepThreshold = firstN + lastN;
    const wouldSkipCleanup = totalGroups <= keepThreshold;

    const sampleGroups = groups.slice(0, 5).map((g, gi) => ({
      groupIndex: gi,
      elements: g.elements.map((el) => describeEl(el, 120))
    }));

    const scrollRoots = document.querySelectorAll('[data-scroll-root]');
    const roleAll = document.querySelectorAll(
      '[data-message-author-role="user"], [data-message-author-role="assistant"]'
    );
    const outerBubbleCount = thread
      ? getOuterTextMessageDivs(thread).length
      : 0;
    const groupsFromRolesOnly = thread
      ? buildMessageGroupsFromRoles(thread).length
      : 0;
    const groupsFromBubblesOnly = thread
      ? buildMessageGroupsFromTextMessageBubbles(thread).length
      : 0;
    const sectionsTurnCount = thread
      ? getConversationSections(thread).length
      : 0;
    const groupsFromSectionsOnly = thread
      ? buildMessageGroupsFromSections(thread).length
      : 0;

    return {
      collectedAt: new Date().toISOString(),
      extension: {
        version: manifest.version,
        version_name: manifest.version_name
      },
      page: {
        href: location.href,
        title: document.title
      },
      config: { ...config, firstN, lastN },
      readiness: {
        isPageReady: isPageReady(),
        messageBlockCount: getMessageBlocks().length
      },
      threadContainer: describeEl(thread, 240),
      grouping: {
        strategy: (() => {
          const maxLegacy = Math.max(
            groupsFromRolesOnly,
            groupsFromBubblesOnly
          );
          if (groupsFromSectionsOnly > maxLegacy) {
            return 'conversation-sections';
          }
          if (groupsFromBubblesOnly > groupsFromRolesOnly) {
            return 'text-message-bubbles';
          }
          if (groupsFromRolesOnly > 0) {
            return 'data-message-author-role';
          }
          if (totalGroups > 0) return 'articles-or-content';
          return 'none';
        })(),
        groupsFromRoles: groupsFromRolesOnly,
        groupsFromTextMessageBubbles: groupsFromBubblesOnly,
        outerTextMessageDivs: outerBubbleCount,
        conversationSections: sectionsTurnCount,
        groupsFromSections: groupsFromSectionsOnly
      },
      counts: {
        dataScrollRoot: scrollRoots.length,
        articlesInDocument: document.querySelectorAll('article').length,
        articlesInThread: thread
          ? thread.querySelectorAll('article').length
          : 0,
        roleNodesInDocument: roleAll.length,
        roleNodesInThread: thread
          ? thread.querySelectorAll(
              '[data-message-author-role="user"], [data-message-author-role="assistant"]'
            ).length
          : 0,
        dataMessageContentInThread: thread
          ? thread.querySelectorAll('[data-message-content]').length
          : 0,
        messageGroups: totalGroups
      },
      cleanupLogic: {
        keepFirstN: firstN,
        keepLastN: lastN,
        keepThreshold,
        wouldSkipCleanup,
        reasonIfSkipped: wouldSkipCleanup
          ? `Групп (${totalGroups}) не больше порога firstN+lastN (${keepThreshold}) — середина не удаляется`
          : null
      },
      sampleGroups
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return;

    if (message.action === 'getDebugInfo') {
      try {
        const debug = collectDebugInfo();
        sendResponse({ ok: true, debug });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e && e.message ? e.message : String(e)
        });
      }
      return;
    }

    if (message.action === 'forceApplyCleaner') {
      const thread = getThreadContainer();
      if (!thread) {
        sendResponse({ ok: false, reason: 'not_ready' });
        return;
      }
      applyHistoryCleaner(true);
      sendResponse({ ok: true });
    }
  });
  // Инициализация
  function init() {
    loadConfig();
    
    // Ждем загрузки DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        observeNewMessages();
        // Увеличиваем задержку для полной загрузки страницы
        setTimeout(() => {
          if (isPageReady()) {
            applyHistoryCleaner();
          } else {
            // Если страница еще не готова, ждем еще
            setTimeout(applyHistoryCleaner, 1000);
          }
        }, 1000);
      });
    } else {
      observeNewMessages();
      // Увеличиваем задержку для полной загрузки страницы
      setTimeout(() => {
        if (isPageReady()) {
          applyHistoryCleaner();
        } else {
          setTimeout(applyHistoryCleaner, 1000);
        }
      }, 1000);
    }

    // Периодическая проверка отключена - используем только observer
    // setInterval создавал бесконечные циклы, поэтому отключен
  }

  init();
})();
