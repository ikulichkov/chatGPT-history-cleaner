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
  function showStatus() {
    status.classList.add('show');
    setTimeout(() => {
      status.classList.remove('show');
    }, 2000);
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
