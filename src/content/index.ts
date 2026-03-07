/**
 * Content script — runs in the page context (isolated world).
 *
 * 1. Injects the inpage script into the page's JS context
 * 2. Sets up the provider bridge (inpage ↔ background relay)
 */

import { setupProviderBridge } from "./provider-bridge";

// Inject inpage script into the page's JavaScript context
const script = document.createElement("script");
script.src = chrome.runtime.getURL("src/inpage/index.js");
script.type = "module";
script.onload = () => script.remove();
(document.head ?? document.documentElement).appendChild(script);

// Set up the message bridge between inpage and background
setupProviderBridge();
