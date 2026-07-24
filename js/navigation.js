(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", () => {
    const header = document.querySelector(".site-header");
    if (!header) return;

    initMobileNavigation(header);
    initGlobalSearch(header);
  });

  function initMobileNavigation(header) {
    const navigation = header.querySelector(".primary-nav");
    const toggle = header.querySelector(".mobile-nav-toggle");
    if (!navigation || !toggle) return;

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
  }

  function initGlobalSearch(header) {
    const search = header.querySelector(".global-search");
    const input = search?.querySelector("#global-search");
    const results = search?.querySelector("#search-results");
    const homeLink = header.querySelector(".brand");
    if (!search || !input || !results || !homeLink) return;

    const siteRoot = new URL("./", homeLink.href);
    let searchIndex = null;
    let storePromise = null;
    let activeIndex = -1;
    let requestId = 0;

    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");

    async function loadSearchIndex() {
      if (searchIndex) return searchIndex;
      if (window.cityLeagueStore?.seasons?.length) {
        searchIndex = buildSearchIndex(window.cityLeagueStore, siteRoot);
        return searchIndex;
      }
      if (!storePromise) {
        storePromise = fetch(new URL("data/seasons.json", siteRoot))
          .then((response) => {
            if (!response.ok) throw new Error(`Search data request failed: ${response.status}`);
            return response.json();
          })
          .then((store) => {
            window.cityLeagueStore = store;
            return store;
          });
      }
      searchIndex = buildSearchIndex(await storePromise, siteRoot);
      return searchIndex;
    }

    async function renderSearchResults() {
      const query = input.value.trim().toLocaleLowerCase();
      const currentRequest = ++requestId;
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");

      if (!query) {
        closeSearch();
        return;
      }

      renderSearchMessage("Loading teams and players…");
      input.setAttribute("aria-busy", "true");

      try {
        const index = await loadSearchIndex();
        if (currentRequest !== requestId || query !== input.value.trim().toLocaleLowerCase()) return;

        const matches = index
          .filter((item) => item.search.includes(query))
          .sort((a, b) => {
            const aNameStarts = a.nameSearch.startsWith(query) ? 0 : 1;
            const bNameStarts = b.nameSearch.startsWith(query) ? 0 : 1;
            const aSearchStarts = a.search.startsWith(query) ? 0 : 1;
            const bSearchStarts = b.search.startsWith(query) ? 0 : 1;
            return (
              aNameStarts - bNameStarts ||
              aSearchStarts - bSearchStarts ||
              a.name.localeCompare(b.name) ||
              a.subline.localeCompare(b.subline)
            );
          })
          .slice(0, 9);

        if (!matches.length) {
          renderSearchMessage("No teams or players found.");
          return;
        }

        const fragment = document.createDocumentFragment();
        matches.forEach((match, index) => {
          const link = document.createElement("a");
          link.id = `global-search-result-${index}`;
          link.className = "search-result";
          link.href = match.url;
          link.setAttribute("role", "option");
          link.setAttribute("aria-selected", "false");

          const copy = document.createElement("span");
          const name = document.createElement("strong");
          const subline = document.createElement("small");
          const type = document.createElement("span");
          name.textContent = match.name;
          subline.textContent = match.subline;
          type.className = "search-result-type";
          type.textContent = match.type;
          copy.append(name, subline);
          link.append(copy, type);

          link.addEventListener("click", closeSearch);
          fragment.append(link);
        });

        results.replaceChildren(fragment);
        openSearch();
      } catch (error) {
        console.error(error);
        if (currentRequest === requestId) {
          renderSearchMessage("Search is unavailable right now.");
        }
      } finally {
        if (currentRequest === requestId) input.removeAttribute("aria-busy");
      }
    }

    function renderSearchMessage(message) {
      const status = document.createElement("div");
      status.className = "search-empty";
      status.setAttribute("role", "status");
      status.textContent = message;
      results.replaceChildren(status);
      openSearch();
    }

    function openSearch() {
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function closeSearch() {
      requestId += 1;
      activeIndex = -1;
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      results.querySelectorAll('[role="option"]').forEach((option) => {
        option.classList.remove("is-active");
        option.setAttribute("aria-selected", "false");
      });
    }

    function setActiveResult(nextIndex) {
      const options = [...results.querySelectorAll('[role="option"]')];
      if (!options.length) return;
      activeIndex = (nextIndex + options.length) % options.length;
      options.forEach((option, index) => {
        const active = index === activeIndex;
        option.classList.toggle("is-active", active);
        option.setAttribute("aria-selected", String(active));
      });
      input.setAttribute("aria-activedescendant", options[activeIndex].id);
      options[activeIndex].scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("input", renderSearchResults);
    input.addEventListener("focus", () => {
      if (input.value.trim()) renderSearchResults();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSearch();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (results.hidden) return;
        event.preventDefault();
        const optionCount = results.querySelectorAll('[role="option"]').length;
        const nextIndex =
          activeIndex < 0
            ? event.key === "ArrowDown"
              ? 0
              : optionCount - 1
            : activeIndex + (event.key === "ArrowDown" ? 1 : -1);
        setActiveResult(nextIndex);
        return;
      }
      if (event.key === "Enter" && activeIndex >= 0) {
        const option = results.querySelectorAll('[role="option"]')[activeIndex];
        if (option) {
          event.preventDefault();
          option.click();
        }
      }
    });

    document.addEventListener("click", (event) => {
      if (!search.contains(event.target)) closeSearch();
    });
  }

  function buildSearchIndex(store, siteRoot) {
    const seasons = [...(store.seasons || [])].sort(
      (a, b) => b.year - a.year || String(a.league).localeCompare(String(b.league))
    );
    const teamsById = new Map();

    for (const season of seasons) {
      for (const team of season.teams || []) {
        if (teamsById.has(team.id)) continue;
        const params = new URLSearchParams({ season: season.id, team: team.id });
        teamsById.set(team.id, {
          type: "Team",
          name: team.name,
          nameSearch: team.name.toLocaleLowerCase(),
          subline: `${season.league} · ${season.year}`,
          search: `${team.name} ${season.league} ${season.year}`.toLocaleLowerCase(),
          url: new URL(`index.html?${params.toString()}#standings`, siteRoot).href,
        });
      }
    }

    const players = (store.playerProfiles || []).map((profile) => {
      const teamName = profile.teamDisplayName || profile.latestTeam || "City League";
      return {
        type: "Player",
        name: profile.name,
        nameSearch: profile.name.toLocaleLowerCase(),
        subline: teamName,
        search: `${profile.name} ${teamName}`.toLocaleLowerCase(),
        url: new URL(`players/${encodeURIComponent(profile.id)}.html`, siteRoot).href,
      };
    });

    return [...teamsById.values(), ...players];
  }
})();
