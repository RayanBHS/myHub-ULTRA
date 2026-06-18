document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('open-chatbot').addEventListener('click', function() {
        chrome.tabs.create({ url: chrome.runtime.getURL("page/chatbot.html") });
    });
});