(function () {
  "use strict";

  const FORMAT_ORDER = [
    "Stableford",
    "Two Nets",
    "Four Ball",
    "Two Best Balls",
    "Modified",
    "Match Play",
    "Four Clubs",
    "Alternate Shot",
    "Pinky",
  ];

  const state = {
    store: null,
    scope: "all",
    stats: [],
  };

  const elements = {};
  let resizeFrame = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    if (!window.d3) {
      showLoadError("The D3 chart library did not load. Check your internet connection and refresh.");
      return;
    }

    try {
      state.store = await d3.json("data/seasons.json");
      if (!state.store?.seasons?.length) throw new Error("No season data was found");
      populateSeasonSelect();
      elements.formatSeasonSelect.addEventListener("change", (event) => {
        state.scope = event.target.value;
        render();
      });
      window.addEventListener("resize", scheduleChartRender);
      render();
    } catch (error) {
      console.error(error);
      showLoadError("The season JSON could not be loaded. If you opened this file directly, use a local web server instead.");
    }
  }

  function cacheElements() {
    [
      "format-load-error",
      "format-season-select",
      "format-scope-note",
      "format-season-count",
      "format-count",
      "format-score-count",
      "format-card-grid",
      "format-table",
    ].forEach((id) => {
      elements[toCamel(id)] = document.getElementById(id);
    });
  }

  function populateSeasonSelect() {
    const seasons = [...state.store.seasons].sort((a, b) => b.year - a.year || a.league.localeCompare(b.league));
    const options = [new Option("All available seasons", "all")];
    for (const season of seasons) {
      options.push(new Option(`${season.year} · ${season.league}`, season.id));
    }
    elements.formatSeasonSelect.replaceChildren(...options);
    elements.formatSeasonSelect.value = state.scope;
  }

  function render() {
    const seasons = selectedSeasons();
    const records = collectTeamScores(seasons);
    state.stats = summarizeFormats(records);
    renderScopeNote(seasons, records);
    renderOverview(seasons, records);
    renderCards();
    renderTable();
  }

  function selectedSeasons() {
    return state.scope === "all"
      ? state.store.seasons
      : state.store.seasons.filter((season) => season.id === state.scope);
  }

  function collectTeamScores(seasons) {
    return seasons.flatMap((season) =>
      season.rounds.flatMap((round, index) =>
        season.teams
          .map((team) => {
            const result = team.rounds.find((candidate) => candidate.week === round.week) || team.rounds[index];
            return {
              seasonId: season.id,
              year: season.year,
              teamId: team.id,
              teamName: team.name,
              week: round.week,
              format: round.format || round.shortName || `Week ${round.week}`,
              score: result?.net,
            };
          })
          .filter((record) => isNumber(record.score))
      )
    );
  }

  function summarizeFormats(records) {
    const groups = d3.group(records, (record) => record.format);
    return [...groups].map(([format, entries]) => {
      const scores = entries.map((entry) => entry.score).sort(d3.ascending);
      const q25 = d3.quantileSorted(scores, 0.25);
      const median = d3.quantileSorted(scores, 0.5);
      const q75 = d3.quantileSorted(scores, 0.75);
      return {
        id: slugify(format),
        format,
        scores,
        samples: scores.length,
        seasonCount: new Set(entries.map((entry) => entry.seasonId)).size,
        q25,
        median,
        q75,
        good: Math.floor(q25),
        poor: Math.ceil(q75),
        average: d3.mean(scores),
        best: d3.min(scores),
        worst: d3.max(scores),
      };
    }).sort((a, b) => {
      const left = FORMAT_ORDER.indexOf(a.format);
      const right = FORMAT_ORDER.indexOf(b.format);
      const leftOrder = left === -1 ? FORMAT_ORDER.length : left;
      const rightOrder = right === -1 ? FORMAT_ORDER.length : right;
      return leftOrder - rightOrder || a.format.localeCompare(b.format);
    });
  }

  function renderScopeNote(seasons, records) {
    if (!records.length) {
      elements.formatScopeNote.textContent = "No team scores are available for this selection.";
      return;
    }
    const years = seasons.map((season) => season.year);
    const range = Math.min(...years) === Math.max(...years)
      ? String(years[0])
      : `${Math.min(...years)}–${Math.max(...years)}`;
    elements.formatScopeNote.textContent = `${range} · ${seasons.length} ${seasons.length === 1 ? "season" : "seasons"} · final tables only`;
  }

  function renderOverview(seasons, records) {
    elements.formatSeasonCount.textContent = d3.format(",d")(seasons.length);
    elements.formatCount.textContent = d3.format(",d")(state.stats.length);
    elements.formatScoreCount.textContent = d3.format(",d")(records.length);
  }

  function renderCards() {
    if (!state.stats.length) {
      const empty = document.createElement("p");
      empty.className = "format-empty";
      empty.textContent = "No format results are available for this selection.";
      elements.formatCardGrid.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    state.stats.forEach((stat, index) => {
      const card = document.createElement("article");
      card.className = "format-card";
      card.innerHTML = `
        <div class="format-card-heading">
          <div>
            <span class="mini-label">${stat.samples} team scores · ${stat.seasonCount} ${stat.seasonCount === 1 ? "season" : "seasons"}</span>
            <h3>${escapeHtml(stat.format)}</h3>
          </div>
          <div class="format-average"><span>Average</span><strong>${formatScore(stat.average)}</strong></div>
        </div>
        <div class="format-targets">
          <div class="format-target good"><span>Good day</span><strong>${stat.good} or better</strong></div>
          <div class="format-target typical"><span>Typical</span><strong>${formatScore(stat.median)}</strong></div>
          <div class="format-target poor"><span>Setback</span><strong>${stat.poor} or higher</strong></div>
        </div>
        <div class="format-range-chart" data-stat-index="${index}"></div>
        <p class="format-range-note">Observed range: <strong>${stat.best}–${stat.worst}</strong></p>
      `;
      fragment.append(card);
    });
    elements.formatCardGrid.replaceChildren(fragment);
    renderCharts();
  }

  function renderCharts() {
    elements.formatCardGrid.querySelectorAll(".format-range-chart").forEach((container) => {
      const stat = state.stats[Number(container.dataset.statIndex)];
      if (stat) renderRangeChart(container, stat);
    });
  }

  function renderRangeChart(container, stat) {
    container.replaceChildren();
    const width = Math.max(container.clientWidth, 260);
    const height = 88;
    const margin = { top: 12, right: 14, bottom: 28, left: 14 };
    const plotWidth = width - margin.left - margin.right;
    const domainPadding = Math.max(1, Math.round((stat.worst - stat.best) * 0.05));
    const x = d3
      .scaleLinear()
      .domain([stat.best - domainPadding, stat.worst + domainPadding])
      .nice()
      .range([0, plotWidth]);
    const svg = d3
      .select(container)
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr(
        "aria-label",
        `${stat.format}: good at ${stat.good} or lower, median ${formatScore(stat.median)}, setback at ${stat.poor} or higher`
      )
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    svg
      .append("line")
      .attr("class", "format-whisker")
      .attr("x1", x(stat.best))
      .attr("x2", x(stat.worst))
      .attr("y1", 18)
      .attr("y2", 18);
    svg
      .append("rect")
      .attr("class", "format-iqr")
      .attr("x", x(stat.q25))
      .attr("y", 7)
      .attr("width", Math.max(2, x(stat.q75) - x(stat.q25)))
      .attr("height", 22)
      .attr("rx", 4);
    svg
      .append("line")
      .attr("class", "format-median")
      .attr("x1", x(stat.median))
      .attr("x2", x(stat.median))
      .attr("y1", 4)
      .attr("y2", 32);
    svg
      .append("circle")
      .attr("class", "format-mean")
      .attr("cx", x(stat.average))
      .attr("cy", 18)
      .attr("r", 5);
    svg
      .append("g")
      .attr("class", "axis format-axis")
      .attr("transform", "translate(0,40)")
      .call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(7).tickFormat(d3.format("d")));
  }

  function renderTable() {
    const columns = [
      ["format", "Format"],
      ["good", "Good day"],
      ["median", "Median"],
      ["average", "Average"],
      ["poor", "Setback"],
      ["best", "Best"],
      ["worst", "Worst"],
      ["samples", "Team scores"],
    ];
    const header = document.createElement("tr");
    for (const [, label] of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      header.append(cell);
    }
    elements.formatTable.tHead.replaceChildren(header);

    const fragment = document.createDocumentFragment();
    for (const stat of state.stats) {
      const row = document.createElement("tr");
      const values = {
        format: stat.format,
        good: `${stat.good} or better`,
        median: formatScore(stat.median),
        average: formatScore(stat.average),
        poor: `${stat.poor} or higher`,
        best: stat.best,
        worst: stat.worst,
        samples: stat.samples,
      };
      for (const [key] of columns) {
        const cell = document.createElement("td");
        cell.textContent = values[key];
        if (key === "good") cell.className = "score-good";
        if (key === "poor") cell.className = "score-poor";
        row.append(cell);
      }
      fragment.append(row);
    }
    elements.formatTable.tBodies[0].replaceChildren(fragment);
  }

  function scheduleChartRender() {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      renderCharts();
    });
  }

  function formatScore(value) {
    if (!isNumber(value)) return "—";
    return Number.isInteger(value) ? d3.format("d")(value) : d3.format(".1f")(value);
  }

  function slugify(value) {
    return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showLoadError(message) {
    elements.formatLoadError.hidden = false;
    const detail = elements.formatLoadError.querySelector("span");
    if (detail) detail.textContent = message;
  }
})();
