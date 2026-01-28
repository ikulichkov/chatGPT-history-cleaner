// Chat History Cleaner - Content Script
(function() {
  'use strict';

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
    const thread = document.querySelector('main#main > div#thread');
    if (!thread) return false;
    
    const blocks = getMessageBlocks();
    // Страница готова, если есть хотя бы несколько блоков и они полностью загружены
    if (blocks.length === 0) return false;
    
    // Проверяем, что последний блок не пустой (не загружается)
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock || lastBlock.textContent.trim().length < 10) return false;
    
    return true;
  }

  // Измерение размера страницы
  function measurePageSize(onlyVisible = false) {
    const thread = document.querySelector('main#main > div#thread');
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

  // Получение всех блоков сообщений
  // Ищем контейнеры сообщений, а не отдельные article
  function getMessageBlocks() {
    // В ChatGPT сообщения обычно находятся в контейнерах с определенной структурой
    // Пробуем найти контейнеры пар сообщений (пользователь + ассистент)
    const thread = document.querySelector('main#main > div#thread');
    if (!thread) return [];
    
    // Ищем все article элементы в потоке
    const allArticles = thread.querySelectorAll('article');
    if (allArticles.length === 0) return [];
    
    // Группируем article элементы по парам (пользователь + ассистент)
    // Обычно они идут последовательно
    const messageGroups = [];
    const processed = new Set();
    
    Array.from(allArticles).forEach((article, index) => {
      if (processed.has(article)) return;
      
      // Проверяем, есть ли следующий article рядом
      // Если да, считаем их парой (пользователь + ассистент)
      const nextArticle = allArticles[index + 1];
      
      if (nextArticle && !processed.has(nextArticle)) {
        // Это пара сообщений
        messageGroups.push({
          elements: [article, nextArticle],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
        processed.add(nextArticle);
      } else {
        // Одиночное сообщение
        messageGroups.push({
          elements: [article],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
      }
    });
    
    // Возвращаем массив первых элементов каждой группы (для удобства работы)
    return messageGroups.map(group => group.firstElement);
  }

  // Функции для кнопки "Показать ответ" удалены - блоки удаляются без возможности восстановления

  // Удалить группу блоков из DOM (без возможности восстановления)
  function hideBlockGroup(group, index) {
    if (hiddenBlocks.has(index)) return;
    
    // Просто удаляем все элементы группы из DOM
    group.elements.forEach(el => el.remove());
    
    // Отмечаем как удаленную (для статистики)
    hiddenBlocks.set(index, { removed: true });
  }

  // Применение очистки истории
  function applyHistoryCleaner() {
    // Проверяем готовность страницы перед измерением
    if (!isPageReady()) {
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

    // Получаем все группы сообщений (пары пользователь + ассистент)
    const thread = document.querySelector('main#main > div#thread');
    if (!thread) {
      console.log('[Chat History Cleaner] Thread not found');
      return;
    }
    
    // Пробуем разные селекторы для поиска блоков сообщений
    let allArticles = thread.querySelectorAll('article');
    
    // Если не нашли через article, пробуем другие селекторы
    if (allArticles.length === 0) {
      // Пробуем найти по структуре с текстом "You said:" и "ChatGPT said:"
      // Если не нашли через article, возвращаемся
      return;
    }
    
    if (allArticles.length === 0) {
      isCleaning = false;
      return;
    }
    
    // Группируем элементы по парам (пользователь + ассистент)
    // Проверяем содержимое, чтобы понять, где пользователь, а где ассистент
    const messageGroups = [];
    const processed = new Set();
    const articlesArray = Array.from(allArticles);
    
    articlesArray.forEach((article, index) => {
      if (processed.has(article)) return;
      
      const text = (article.textContent || '').trim();
      const isUserMessage = text.includes('Вы сказали:') || text.includes('You said:') || text.startsWith('Вы сказали:') || text.startsWith('You said:');
      const isAssistantMessage = text.includes('ChatGPT сказал:') || text.includes('ChatGPT said:') || text.startsWith('ChatGPT сказал:') || text.startsWith('ChatGPT said:');
      
      // Если это сообщение от пользователя, ищем следующий ответ от ассистента
      if (isUserMessage) {
        // Ищем следующее сообщение от ассистента
        let assistantArticle = null;
        for (let i = index + 1; i < articlesArray.length; i++) {
          if (processed.has(articlesArray[i])) continue;
          
          const nextText = (articlesArray[i].textContent || '').trim();
          const nextIsAssistant = nextText.includes('ChatGPT сказал:') || nextText.includes('ChatGPT said:') || nextText.startsWith('ChatGPT сказал:') || nextText.startsWith('ChatGPT said:');
          
          if (nextIsAssistant) {
            assistantArticle = articlesArray[i];
            break;
          }
          
          // Если встретили еще одно сообщение пользователя, останавливаемся
          const nextIsUser = nextText.includes('Вы сказали:') || nextText.includes('You said:') || nextText.startsWith('Вы сказали:') || nextText.startsWith('You said:');
          if (nextIsUser) break;
        }
        
        if (assistantArticle && !processed.has(assistantArticle)) {
          // Пара: пользователь + ассистент
          messageGroups.push({
            elements: [article, assistantArticle],
            firstElement: article,
            index: messageGroups.length
          });
          processed.add(article);
          processed.add(assistantArticle);
        } else {
          // Одиночное сообщение пользователя
          messageGroups.push({
            elements: [article],
            firstElement: article,
            index: messageGroups.length
          });
          processed.add(article);
        }
      } else if (isAssistantMessage) {
        // Сообщение от ассистента без предшествующего сообщения пользователя - одиночное
        messageGroups.push({
          elements: [article],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
      } else {
        // Неизвестный тип - одиночное
        messageGroups.push({
          elements: [article],
          firstElement: article,
          index: messageGroups.length
        });
        processed.add(article);
      }
    });
    
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
          hideBlockGroup(group, groupIndex);
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

  // Завершение работы расширения после очистки
  function finishWork() {
    // Отключаем observer
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    
    // Очищаем флаги
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
            if (node.nodeType === 1 && node.tagName === 'ARTICLE') {
              isOurRemoval = true;
            }
          });
          if (isOurRemoval) {
            return; // Игнорируем наши удаления
          }
        }
        
        if (mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) { // Element node
              // Проверяем, является ли это новым блоком сообщения
              if (node.matches && node.matches('article')) {
                shouldUpdate = true;
              } else if (node.querySelector && node.querySelector('article')) {
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

    const targetNode = document.querySelector('main#main > div#thread');
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
