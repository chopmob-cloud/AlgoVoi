/**
 * DevTools entry point — creates the AlgoVoi panel inside Chrome DevTools.
 */

chrome.devtools.panels.create(
  "AlgoVoi",
  "icons/icon16.png",
  "src/devtools/panel.html",
  () => {
    console.log("[AlgoVoi] DevTools panel created");
  }
);
