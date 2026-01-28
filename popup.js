// Popup script для настроек
(function() {
  'use strict';

  const DEFAULT_CONFIG = {
    enabled: true,
    firstN: 5,
    lastN: 5
  };

  const toggleEnabled = document.getElementById('toggleEnabled');
  const firstNInput = document.getElementById('firstN');
  const lastNInput = document.getElementById('lastN');
  const saveBtn = document.getElementById('saveBtn');
  const applyBtn = document.getElementById('applyBtn');
  const debugGatherBtn = document.getElementById('debugGatherBtn');
  const debugCopyBtn = document.getElementById('debugCopyBtn');
  const debugOut = document.getElementById('debugOut');
  const status = document.getElementById('status');
  const statsSection = document.getElementById('statsSection');
  const statBefore = document.getElementById('statBefore');
  const statAfter = document.getElementById('statAfter');
  const statSaved = document.getElementById('statSaved');
  const statSavedValue = document.getElementById('statSavedValue');
  const statsEmpty = document.getElementById('statsEmpty');
  const versionNumber = document.getElementById('versionNumber');
  const versionDate = document.getElementById('versionDate');

  // Форматирование размера
  function formatSize(bytes) {
    if (bytes < 1024) {
      return bytes + ' Б';
    } else if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(2) + ' КБ';
    } else {
      return (bytes / (1024 * 1024)).toFixed(2) + ' МБ';
    }
  }

  // Загрузка статистики
  async function loadStatistics() {
    try {
      const result = await chrome.storage.local.get(['pageStatistics']);
      if (result.pageStatistics && result.pageStatistics.before) {
        const stats = result.pageStatistics;
        
        // Проверяем валидность статистики
        // Статистика валидна, если размер после меньше размера до
        const isValid = stats.after && 
                        stats.before.sizeBytes > 0 && 
                        stats.after.sizeBytes > 0 &&
                        stats.after.sizeBytes < stats.before.sizeBytes;
        
        if (isValid) {
          // Показываем статистику
          statsSection.style.display = 'block';
          statsEmpty.style.display = 'none';
          
          // Размер до
          statBefore.textContent = formatSize(stats.before.sizeBytes);
          
          // Размер после
          statAfter.textContent = formatSize(stats.after.sizeBytes);
          
          // Экономия
          if (stats.savedBytes > 0) {
            statSaved.style.display = 'block';
            const savedFormatted = formatSize(stats.savedBytes);
            const savedPercent = stats.savedPercent || '0';
            statSavedValue.textContent = `${savedFormatted} (${savedPercent}%)`;
          } else {
            statSaved.style.display = 'none';
          }
        } else {
          // Статистика невалидна или еще не готова
          statsSection.style.display = 'block';
          statsEmpty.style.display = 'block';
          statBefore.textContent = '-';
          statAfter.textContent = '-';
          statSaved.style.display = 'none';
        }
      } else {
        // Нет статистики
        statsSection.style.display = 'block';
        statsEmpty.style.display = 'block';
        statBefore.textContent = '-';
        statAfter.textContent = '-';
        statSaved.style.display = 'none';
      }
    } catch (error) {
      console.error('Error loading statistics:', error);
    }
  }

  // Загрузка версии расширения
  function loadVersion() {
    try {
      const manifest = chrome.runtime.getManifest();
      versionNumber.textContent = manifest.version || '1.0.1';
      versionDate.textContent = manifest.version_name || manifest.version + ' - 2025-01-28 15:30';
    } catch (error) {
      // Fallback
      versionNumber.textContent = '1.0.1';
      versionDate.textContent = '2025-01-28 15:30';
    }
  }

  // Загрузка текущих настроек
  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(['chatHistoryConfig']);
      const config = result.chatHistoryConfig || DEFAULT_CONFIG;
      
      toggleEnabled.classList.toggle('active', config.enabled);
      firstNInput.value = (config.firstN !== undefined && config.firstN !== null) ? config.firstN : 5;
      lastNInput.value = (config.lastN !== undefined && config.lastN !== null) ? config.lastN : 5;
      firstNInput.disabled = !config.enabled;
      lastNInput.disabled = !config.enabled;
      
      // Загружаем статистику
      loadStatistics();
      
      // Загружаем версию
      loadVersion();
    } catch (error) {
      console.error('Error loading settings:', error);
    }
  }

  // Сохранение настроек
  async function saveSettings() {
    const firstNValue = parseInt(firstNInput.value);
    const lastNValue = parseInt(lastNInput.value);
    const firstN = Math.max(0, isNaN(firstNValue) ? 5 : firstNValue); // Минимум 0
    const lastN = Math.max(1, isNaN(lastNValue) ? 5 : lastNValue);   // Минимум 1
    
    const config = {
      enabled: toggleEnabled.classList.contains('active'),
      firstN: firstN,
      lastN: lastN
    };

    try {
      await chrome.storage.sync.set({ chatHistoryConfig: config });
      showStatus();
      
      // Обновляем значения в полях (на случай если было меньше 1)
      firstNInput.value = firstN;
      lastNInput.value = lastN;
      
      // Обновляем статистику через небольшую задержку
      setTimeout(loadStatistics, 500);
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Ошибка при сохранении настроек');
    }
  }

  // Показать статус сохранения
  function showStatus(message = 'Настройки сохранены!', isError = false) {
    status.textContent = message;
    status.style.color = isError ? '#f44336' : '#4caf50';
    status.classList.add('show');
    setTimeout(() => {
      status.classList.remove('show');
    }, 2000);
  }

  function isNoContentScriptError(msg) {
    return (
      typeof msg === 'string' &&
      msg.indexOf('Receiving end does not exist') !== -1
    );
  }

  /**
   * Сообщение в content script; при «нет получателя» — программная инъекция и повтор.
   */
  function sendToTabContentScript(tabId, message, done) {
    const run = (alreadyInjected) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (!chrome.runtime.lastError) {
          done(null, response);
          return;
        }
        const errText = chrome.runtime.lastError.message;
        if (!alreadyInjected && isNoContentScriptError(errText)) {
          chrome.scripting.executeScript(
            {
              target: { tabId },
              files: ['content.js']
            },
            () => {
              if (chrome.runtime.lastError) {
                done(chrome.runtime.lastError.message, null);
                return;
              }
              chrome.scripting.insertCSS(
                {
                  target: { tabId },
                  files: ['styles.css']
                },
                () => {
                  setTimeout(() => run(true), 100);
                }
              );
            }
          );
          return;
        }
        done(errText, null);
      });
    };
    run(false);
  }

  function gatherDebugInfo() {
    debugGatherBtn.disabled = true;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        debugOut.value = JSON.stringify(
          { error: 'Нет активной вкладки' },
          null,
          2
        );
        showStatus('Откройте вкладку с ChatGPT', true);
        debugGatherBtn.disabled = false;
        return;
      }

      sendToTabContentScript(tab.id, { action: 'getDebugInfo' }, (err, response) => {
        debugGatherBtn.disabled = false;
        if (err) {
          debugOut.value = JSON.stringify(
            {
              error: err,
              tabUrl: tab.url || null,
              hint:
                'Откройте вкладку с чатом (chatgpt.com / openai.com), обновите страницу (F5) после установки расширения. Страницы chrome:// и магазин расширений не поддерживаются.'
            },
            null,
            2
          );
          showStatus('Не удалось собрать отладку', true);
          return;
        }
        if (!response || !response.ok) {
          debugOut.value = JSON.stringify(
            response || { error: 'Пустой ответ' },
            null,
            2
          );
          showStatus('Ошибка сбора', true);
          return;
        }
        debugOut.value = JSON.stringify(response.debug, null, 2);
        showStatus('Данные собраны', false);
      });
    });
  }

  function copyDebugOut() {
    const text = debugOut.value.trim();
    if (!text) {
      showStatus('Сначала соберите данные', true);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => showStatus('Скопировано в буфер', false),
      () => {
        debugOut.focus();
        debugOut.select();
        try {
          document.execCommand('copy');
          showStatus('Скопировано', false);
        } catch (e) {
          showStatus('Копирование не удалось', true);
        }
      }
    );
  }

  function forceApplyCleaner() {
    applyBtn.disabled = true;
    showStatus('Запускаю очистку...', false);

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab || !activeTab.id) {
        showStatus('Откройте вкладку с ChatGPT', true);
        applyBtn.disabled = false;
        return;
      }

      sendToTabContentScript(
        activeTab.id,
        { action: 'forceApplyCleaner' },
        (err, response) => {
          if (err) {
            console.warn('Force apply error:', err);
            showStatus('Не удалось запустить очистку', true);
            applyBtn.disabled = false;
            return;
          }

          if (response && response.ok) {
            showStatus('Очистка запущена', false);
          } else if (response && response.reason === 'not_ready') {
            showStatus('Страница еще загружается', true);
          } else {
            showStatus('Не удалось запустить очистку', true);
          }
          applyBtn.disabled = false;
        }
      );
    });
  }
  // Переключение включено/выключено
  toggleEnabled.addEventListener('click', () => {
    toggleEnabled.classList.toggle('active');
    const isEnabled = toggleEnabled.classList.contains('active');
    firstNInput.disabled = !isEnabled;
    lastNInput.disabled = !isEnabled;
    // Автоматически сохраняем при переключении
    setTimeout(saveSettings, 100);
  });

  // Валидация ввода для firstN (минимум 0)
  firstNInput.addEventListener('input', (e) => {
    let value = parseInt(e.target.value);
    if (isNaN(value) || value < 0) {
      value = 0;
    }
    e.target.value = value;
  });

  // Валидация ввода для lastN (минимум 1)
  lastNInput.addEventListener('input', (e) => {
    let value = parseInt(e.target.value);
    if (isNaN(value) || value < 1) {
      value = 1;
    }
    e.target.value = value;
  });

  // Сохранение при нажатии кнопки
  saveBtn.addEventListener('click', saveSettings);

  // Принудительное применение очистки
  applyBtn.addEventListener('click', forceApplyCleaner);

  debugGatherBtn.addEventListener('click', gatherDebugInfo);
  debugCopyBtn.addEventListener('click', copyDebugOut);
  
  // Сохранение при изменении значений
  firstNInput.addEventListener('change', saveSettings);
  lastNInput.addEventListener('change', saveSettings);

  // Обновление статистики при изменении storage
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.pageStatistics) {
      loadStatistics();
    }
  });

  // Загрузка настроек при открытии popup
  loadSettings();
  
  // Периодическое обновление статистики
  setInterval(loadStatistics, 1000);
})();
