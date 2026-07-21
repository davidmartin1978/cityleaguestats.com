(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", () => {
    const header = document.querySelector(".site-header");
    const navigation = header?.querySelector(".primary-nav");
    const toggle = header?.querySelector(".mobile-nav-toggle");
    if (!header || !navigation || !toggle) return;

    const label = toggle.querySelector(".mobile-nav-label");

    function setOpen(open, returnFocus) {
      navigation.dataset.open = String(open);
      toggle.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      if (label) label.textContent = open ? "Close navigation" : "Open navigation";
      if (!open && returnFocus) toggle.focus();
    }

    toggle.addEventListener("click", () => {
      setOpen(toggle.getAttribute("aria-expanded") !== "true", false);
    });

    navigation.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false, false);
    });

    document.addEventListener("click", (event) => {
      if (toggle.getAttribute("aria-expanded") === "true" && !header.contains(event.target)) {
        setOpen(false, false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false, true);
      }
    });

    const desktopQuery = window.matchMedia("(min-width: 1121px)");
    const closeAtDesktop = (event) => {
      if (event.matches) setOpen(false, false);
    };
    if (desktopQuery.addEventListener) {
      desktopQuery.addEventListener("change", closeAtDesktop);
    } else {
      desktopQuery.addListener(closeAtDesktop);
    }
  });
})();
