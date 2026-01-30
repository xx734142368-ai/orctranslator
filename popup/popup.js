document.addEventListener('DOMContentLoaded', () => {
  const selectBtn = document.getElementById('select-btn');
  const statusDiv = document.getElementById('status');
  const targetLangSelect = document.getElementById('target-lang');
  const sourceLangSelect = document.getElementById('source-lang');
  const verticalToggle = document.getElementById('vertical-toggle');

  // Load saved settings
  chrome.storage.sync.get(['targetLang', 'sourceLang', 'isVertical'], (result) => {
    if (result.targetLang) targetLangSelect.value = result.targetLang;
    if (result.sourceLang) sourceLangSelect.value = result.sourceLang;
    if (result.isVertical !== undefined) verticalToggle.checked = result.isVertical;
  });

  // Save settings on change
  targetLangSelect.addEventListener('change', () => {
    chrome.storage.sync.set({ targetLang: targetLangSelect.value });
  });

  sourceLangSelect.addEventListener('change', () => {
    chrome.storage.sync.set({ sourceLang: sourceLangSelect.value });
  });

  verticalToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ isVertical: verticalToggle.checked });
  });

  selectBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      statusDiv.textContent = 'Error: No active tab found';
      return;
    }

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/tesseract.min.js', 'content/content.js']
    }, () => {
      // Ignore "scripts already injected" error
      if (chrome.runtime.lastError) { }

      const messagePayload = {
        action: 'startSelection',
        targetLang: targetLangSelect.value,
        sourceLang: sourceLangSelect.value,
        isVertical: verticalToggle.checked
      };

      // Wait a tiny bit for script to initialize if it was just injected
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, messagePayload, (response) => {
          if (chrome.runtime.lastError) {
            statusDiv.innerText = 'Please refresh the page first!';
          } else {
            window.close();
          }
        });
      }, 100);
    });
  });

  // Check Local Server Status (via Background Proxy)
  chrome.runtime.sendMessage({ action: 'checkLocalServer' }, (response) => {
    const el = document.getElementById('server-status');
    if (response && response.success) {
      el.textContent = '● Local Server: Connected 🚀';
      el.style.color = 'green';
      el.style.fontWeight = 'bold';
    } else {
      el.textContent = '● Local Server: Not Running (Using Tesseract)';
      el.style.color = '#999';
    }
  });
});
