// MyEfrei ULTRA - Chat | Background Service Worker
// Handles cross-origin requests to bypass CORS limitations in content scripts

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetch') {
        const { url, options } = message;
        
        fetch(url, options)
            .then(async (response) => {
                const contentType = response.headers.get('content-type') || '';
                let data;
                
                if (contentType.includes('application/json')) {
                    data = await response.json();
                } else {
                    data = await response.text();
                }
                
                sendResponse({
                    success: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    data: data
                });
            })
            .catch((error) => {
                sendResponse({
                    success: false,
                    error: error.message || 'Network error occurred'
                });
            });
            
        return true; // Keep the message channel open for asynchronous sendResponse
    }
});
