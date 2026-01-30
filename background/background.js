// Helper to inject scripts if missing
async function ensureContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['lib/tesseract.min.js', 'content/content.js']
        });
        await chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: ['content/styles.css']
        });
        return true;
    } catch (e) {
        console.error("Failed to inject script:", e);
        return false;
    }
}

// Listen for keyboard commands
chrome.commands.onCommand.addListener((command) => {
    if (command === "toggle-selection") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (tab) {
                // Get settings
                chrome.storage.sync.get(['targetLang', 'sourceLang'], (result) => {
                    const targetLang = result.targetLang || 'zh-CN';
                    const sourceLang = result.sourceLang || 'eng';

                    // Try sending message
                    chrome.tabs.sendMessage(tab.id, {
                        action: 'startSelection',
                        targetLang: targetLang,
                        sourceLang: sourceLang
                    }, (response) => {
                        // If error (content script not ready), inject and retry
                        if (chrome.runtime.lastError) {
                            console.log("Content script missing, injecting now...");
                            ensureContentScript(tab.id).then((success) => {
                                if (success) {
                                    // Retry message after short delay to let script init
                                    setTimeout(() => {
                                        chrome.tabs.sendMessage(tab.id, {
                                            action: 'startSelection',
                                            targetLang: targetLang,
                                            sourceLang: sourceLang
                                        });
                                    }, 200);
                                }
                            });
                        }
                    });
                });
            }
        });
    }
});

// Existing message listener for capture
// Existing message listener for capture
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'captureTab') {
        chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
                    sendResponse({ dataUrl: dataUrl });
                } else {
                    sendResponse({ error: "Capture failed or restricted" });
                }
            }
        });
        return true;
    }

    // Proxy Local Server Requests (Bypasses Mixed Content)
    if (request.action === 'performLocalOCR') {
        fetch('http://127.0.0.1:8000/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.payload)
        })
            .then(response => response.json())
            .then(data => sendResponse({ success: true, data: data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Async response
    }

    if (request.action === 'checkLocalServer') {
        fetch('http://127.0.0.1:8000/')
            .then(r => {
                if (r.ok) sendResponse({ success: true });
                else sendResponse({ success: false });
            })
            .catch(e => sendResponse({ success: false }));
        return true;
    }
});
