(function() {
  "use strict";

  function initUI() {
    const swcPanel = document.getElementById("swc-panel") || document.getElementById("device-list");
    if (swcPanel) {
      swcPanel.style.display = "block";
      swcPanel.style.visibility = "visible";
      swcPanel.style.opacity = "1";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUI);
  } else {
    initUI();
  }
})();
