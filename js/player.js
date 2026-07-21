(function () {
  "use strict";

  const PAR = 36;
  const SERIES_COLORS = [
    "#1b5e4c",
    "#ee7d57",
    "#3d7ca6",
    "#8c5f9e",
    "#9b7439",
    "#297f76",
  ];

  const state = {
    store: null,
    profile: null,
    seasons: [],
    records: [],
    filter: "all",
    renderFrame: null,
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", initialize);

  async function initialize() {
    cacheElements();

    try {
      const response = await fetch("../data/seasons.json");
      if (!response.ok) throw new Error(`Data request failed (${response.status})`);
      state.store = await response.json();
      const profileId = document.body.dataset.profileId;
      state.profile = state.store.playerProfiles?.find((profile) => profile.id === profileId);
      if (!state.profile) throw new Error("This player is not present in the current data store.");

      state.seasons = resolveProfileSeasons(state.profile);
      state.records = state.seasons.flatMap((entry) => entry.records);
      renderPage();
      observeChartSizes();
    } catch (error) {
      showLoadError(error.message || "The player data could not be loaded.");
    }
  }

  function cacheElements() {
    [
      "profile-load-error",
      "profile-name",
      "profile-team-list",
      "profile-summary",
      "career-seasons",
      "career-rounds",
      "career-avg-gross",
      "career-avg-net",
      "career-best-gross",
      "career-best-net",
      "career-distribution-chart",
      "career-trend-chart",
      "career-cap-chart",
      "trend-legend",
      "cap-legend",
      "profile-season-table",
      "profile-season-filter",
      "profile-rounds-table",
      "profile-tooltip",
    ].forEach((id) => {
      elements[toCamel(id)] = document.getElementById(id);
    });
  }

  function resolveProfileSeasons(profile) {
    return profile.appearances
      .map((appearance) => {
        const season = state.store.seasons.find((candidate) => candidate.id === appearance.seasonId);
        const team = season?.teams.find((candidate) => candidate.id === appearance.teamId);
        const player = team?.players.find((candidate) => candidate.id === appearance.playerId);
        if (!season || !team || !player) return null;

        const records = season.rounds.map((round, index) => {
          const score = player.rounds.find((candidate) => candidate.week === round.week) || player.rounds[index] || {};
          const appliedCap = handicapForWeek(player, round.week);
          const handicap = appliedCap?.handicap;
          const gross = isNumber(score.gross) ? score.gross : null;
          const net = isNumber(gross) && isNumber(handicap) ? gross - handicap : null;
          return {
            seasonId: season.id,
            year: season.year,
            league: season.league,
            teamId: team.id,
            teamName: team.name,
            playerId: player.id,
            week: round.week,
            format: round.format,
            shortName: round.shortName,
            gross,
            raw: score.raw,
            played: isPlayedRound(score),
            omitted: score.omitted === true,
            handicap,
            handicapWeek: appliedCap?.reportedWeek ?? null,
            handicapCarried: appliedCap?.carried ?? false,
            net,
            toPar: isNumber(net) ? net - PAR : null,
          };
        });

        return {
          season,
          team,
          player,
          id: season.id,
          year: season.year,
          league: season.league,
          teamName: team.name,
          records,
          playedRecords: records.filter((record) => record.played),
          numericRecords: records.filter((record) => isNumber(record.gross)),
          capHistory: normalizedCapHistory(player, season),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.year - a.year || a.league.localeCompare(b.league));
  }

  function handicapForWeek(player, week) {
    if (!Array.isArray(player.handicapHistory)) {
      return isNumber(player.handicap)
        ? { handicap: player.handicap, reportedWeek: null, carried: false }
        : null;
    }

    const history = [...player.handicapHistory].sort((a, b) => a.week - b.week);
    const exact = history.find((record) => record.week === week);
    if (exact) {
      return {
        handicap: exact.handicap,
        reportedWeek: exact.week,
        carried: false,
      };
    }

    const previous = history
      .filter((record) => record.week < week && isNumber(record.handicap))
      .at(-1);
    return previous
      ? { handicap: previous.handicap, reportedWeek: previous.week, carried: true }
      : null;
  }

  function normalizedCapHistory(player, season) {
    const history = Array.isArray(player.handicapHistory)
      ? player.handicapHistory
          .filter((record) => isNumber(record.week) && isNumber(record.handicap))
          .map((record) => ({ week: record.week, handicap: record.handicap }))
          .sort((a, b) => a.week - b.week)
      : [];
    if (history.length || !isNumber(player.handicap)) return history;
    return [{ week: season.rounds.at(-1)?.week ?? 1, handicap: player.handicap }];
  }

  function renderPage() {
    renderIdentity();
    renderCareerStats();
    renderSeasonTable();
    renderRoundFilter();
    renderRoundTable();
    renderLegends();
    renderCharts();

    elements.profileSeasonFilter.addEventListener("change", (event) => {
      state.filter = event.target.value;
      renderRoundTable();
    });
  }

  function renderIdentity() {
    elements.profileName.textContent = state.profile.name;
    document.title = `${state.profile.name} Golf Stats | City League`;

    const uniqueTeams = [];
    for (const entry of state.seasons) {
      const key = `${entry.teamName}|${entry.league}`;
      if (!uniqueTeams.some((team) => team.key === key)) {
        uniqueTeams.push({ key, name: entry.teamName, league: entry.league });
      }
    }

    const chips = uniqueTeams.map((team) => {
      const chip = document.createElement("span");
      chip.className = "profile-team-chip";
      chip.textContent = `${team.name} · ${team.league}`;
      return chip;
    });
    elements.profileTeamList.replaceChildren(...chips);

    const years = state.seasons.map((entry) => entry.year);
    const range = years.length
      ? Math.min(...years) === Math.max(...years)
        ? String(years[0])
        : `${Math.min(...years)}–${Math.max(...years)}`
      : "No seasons";
    const seasonWord = state.seasons.length === 1 ? "season" : "seasons";
    const roundCount = state.records.filter((record) => record.played).length;
    const roundWord = roundCount === 1 ? "round played" : "rounds played";
    elements.profileSummary.textContent = `${state.seasons.length} ${seasonWord} (${range}) · ${roundCount} ${roundWord} · Latest team: ${state.profile.latestTeam}`;
  }

  function renderCareerStats() {
    const playedRounds = state.records.filter((record) => record.played);
    const scoredRounds = state.records.filter((record) => isNumber(record.gross));
    const gross = scoredRounds.map((record) => record.gross);
    const net = scoredRounds.map((record) => record.net).filter(isNumber);

    elements.careerSeasons.textContent = formatWhole(state.seasons.length);
    elements.careerRounds.textContent = formatWhole(playedRounds.length);
    elements.careerAvgGross.textContent = formatOne(meanOrNull(gross));
    elements.careerAvgNet.textContent = formatOne(meanOrNull(net));
    elements.careerBestGross.textContent = formatWhole(minOrNull(gross));
    elements.careerBestNet.textContent = formatWhole(minOrNull(net));
  }

  function renderSeasonTable() {
    const columns = [
      { key: "year", label: "Year" },
      { key: "league", label: "League" },
      { key: "team", label: "Team" },
      { key: "rounds", label: "Rounds" },
      { key: "avgGross", label: "Avg gross" },
      { key: "avgNet", label: "Avg net" },
      { key: "bestGross", label: "Best gross" },
      { key: "bestNet", label: "Best net" },
      { key: "capRange", label: "Cap range" },
    ];
    renderHeader(elements.profileSeasonTable, columns);

    const fragment = document.createDocumentFragment();
    for (const entry of state.seasons) {
      const gross = entry.numericRecords.map((record) => record.gross);
      const net = entry.numericRecords.map((record) => record.net).filter(isNumber);
      const caps = entry.capHistory.map((record) => record.handicap);
      const values = {
        year: entry.year,
        league: entry.league,
        team: entry.teamName,
        rounds: formatWhole(entry.playedRecords.length),
        avgGross: formatOne(meanOrNull(gross)),
        avgNet: formatOne(meanOrNull(net)),
        bestGross: formatWhole(minOrNull(gross)),
        bestNet: formatWhole(minOrNull(net)),
        capRange: formatCapRange(caps),
      };
      const row = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = values[column.key];
        row.append(cell);
      }
      fragment.append(row);
    }
    if (!state.seasons.length) fragment.append(emptyTableRow(columns.length, "No season appearances found."));
    elements.profileSeasonTable.tBodies[0].replaceChildren(fragment);
  }

  function renderRoundFilter() {
    const options = [new Option("All seasons", "all")];
    for (const entry of state.seasons) {
      options.push(new Option(`${entry.year} ${entry.league}`, entry.id));
    }
    elements.profileSeasonFilter.replaceChildren(...options);
  }

  function renderRoundTable() {
    const columns = [
      { key: "year", label: "Year" },
      { key: "week", label: "Week" },
      { key: "format", label: "Format" },
      { key: "teamName", label: "Team" },
      { key: "gross", label: "Gross" },
      { key: "handicap", label: "Cap" },
      { key: "net", label: "Net" },
      { key: "toPar", label: "To par" },
    ];
    renderHeader(elements.profileRoundsTable, columns);

    const records = state.records
      .filter((record) => record.played)
      .filter((record) => state.filter === "all" || record.seasonId === state.filter)
      .sort((a, b) => b.year - a.year || b.week - a.week);
    const careerBestGross = minOrNull(state.records.map((record) => record.gross).filter(isNumber));
    const careerBestNet = minOrNull(state.records.map((record) => record.net).filter(isNumber));
    const fragment = document.createDocumentFragment();

    for (const record of records) {
      const row = document.createElement("tr");
      const values = {
        year: record.year,
        week: `Week ${record.week}`,
        format: record.format || record.shortName || "—",
        teamName: record.teamName,
        gross: record.omitted ? "X" : formatWhole(record.gross),
        handicap: formatAppliedCap(record),
        net: formatWhole(record.net),
        toPar: formatToPar(record.toPar),
      };
      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = values[column.key];
        if (column.key === "gross" && record.gross === careerBestGross) cell.classList.add("score-best");
        if (column.key === "net" && record.net === careerBestNet) cell.classList.add("score-best");
        if (column.key === "handicap" && record.handicapCarried) {
          cell.classList.add("cap-carried");
          cell.title = `Cap reported in Week ${record.handicapWeek} and carried forward`;
        }
        row.append(cell);
      }
      fragment.append(row);
    }

    if (!records.length) fragment.append(emptyTableRow(columns.length, "No recorded rounds for this selection."));
    elements.profileRoundsTable.tBodies[0].replaceChildren(fragment);
  }

  function renderHeader(table, columns) {
    const row = document.createElement("tr");
    for (const column of columns) {
      const header = document.createElement("th");
      header.scope = "col";
      header.textContent = column.label;
      row.append(header);
    }
    table.tHead.replaceChildren(row);
  }

  function emptyTableRow(columnCount, message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = columnCount;
    cell.className = "empty-row";
    cell.textContent = message;
    row.append(cell);
    return row;
  }

  function renderLegends() {
    renderLegend(elements.trendLegend, state.seasons.filter((entry) => entry.numericRecords.some((record) => isNumber(record.net))));
    renderLegend(elements.capLegend, state.seasons.filter((entry) => entry.capHistory.length));
  }

  function renderLegend(container, entries) {
    const items = entries.map((entry, index) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.setProperty("--series-color", SERIES_COLORS[index % SERIES_COLORS.length]);
      item.append(swatch, `${entry.year} ${entry.league}`);
      return item;
    });
    container.replaceChildren(...items);
  }

  function renderCharts() {
    renderDistributionChart();
    renderTrendChart();
    renderCapChart();
  }

  function renderDistributionChart() {
    const container = elements.careerDistributionChart;
    container.replaceChildren();
    const gross = state.records.map((record) => record.gross).filter(isNumber);
    const net = state.records.map((record) => record.net).filter(isNumber);
    const combined = [...gross, ...net];
    if (!combined.length) return renderEmptyChart(container, "No scoring rounds are available yet.");

    const width = Math.max(container.clientWidth, 320);
    const height = 315;
    const margin = { top: 18, right: 18, bottom: 44, left: 40 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const extent = d3.extent(combined);
    const domain = [Math.floor(extent[0] - 1), Math.ceil(extent[1] + 1)];
    const thresholdCount = Math.min(14, Math.max(5, domain[1] - domain[0]));
    const bins = d3.bin().domain(domain).thresholds(thresholdCount);
    const grossBins = bins(gross);
    const netBins = bins(net);
    const maxCount = d3.max([...grossBins, ...netBins], (bin) => bin.length) || 1;

    const x = d3.scaleLinear().domain(domain).range([0, plotWidth]);
    const y = d3.scaleLinear().domain([0, maxCount]).nice().range([plotHeight, 0]);
    const svg = chartSvg(container, width, height, margin);
    svg.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-plotWidth).tickFormat(""));
    const layer = svg.append("g");

    drawHistogram(layer, grossBins, x, y, "#205746", "Gross");
    drawHistogram(layer, netBins, x, y, "#f0835c", "Net");

    svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${plotHeight})`)
      .call(d3.axisBottom(x).ticks(Math.min(8, thresholdCount)).tickSize(0).tickPadding(10).tickFormat(d3.format("d")));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("d")));
    svg
      .append("text")
      .attr("class", "chart-axis-label")
      .attr("x", plotWidth)
      .attr("y", plotHeight + 38)
      .attr("text-anchor", "end")
      .text("9-hole score");
  }

  function drawHistogram(layer, bins, x, y, color, label) {
    layer
      .selectAll(`rect.${label.toLowerCase()}-bar`)
      .data(bins)
      .join("rect")
      .attr("class", `${label.toLowerCase()}-bar`)
      .attr("x", (bin) => x(bin.x0) + 1)
      .attr("y", (bin) => y(bin.length))
      .attr("width", (bin) => Math.max(0, x(bin.x1) - x(bin.x0) - 2))
      .attr("height", (bin) => Math.max(0, y(0) - y(bin.length)))
      .attr("fill", color)
      .attr("fill-opacity", label === "Gross" ? 0.7 : 0.62)
      .on("mouseenter", (event, bin) => {
        showTooltip(
          event,
          `<strong>${label} ${formatBin(bin)}</strong><span>${bin.length} ${bin.length === 1 ? "round" : "rounds"}</span>`
        );
      })
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip);
  }

  function renderTrendChart() {
    const container = elements.careerTrendChart;
    container.replaceChildren();
    const groups = state.seasons
      .map((entry) => ({ ...entry, points: entry.records.filter((record) => isNumber(record.net)) }))
      .filter((entry) => entry.points.length);
    const allPoints = groups.flatMap((entry) => entry.points);
    if (!allPoints.length) return renderEmptyChart(container, "Net scoring needs a weekly cap before it can be charted.");

    const width = Math.max(container.clientWidth, 320);
    const height = 315;
    const margin = { top: 18, right: 18, bottom: 44, left: 42 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const maxWeek = d3.max(allPoints, (record) => record.week) || 1;
    const scoreExtent = d3.extent(allPoints, (record) => record.net);
    const scorePadding = Math.max(2, Math.round((scoreExtent[1] - scoreExtent[0]) * 0.15));
    const x = d3.scaleLinear().domain([1, Math.max(2, maxWeek)]).range([0, plotWidth]);
    const y = d3
      .scaleLinear()
      .domain([Math.min(scoreExtent[0] - scorePadding, PAR - 1), Math.max(scoreExtent[1] + scorePadding, PAR + 1)])
      .nice()
      .range([plotHeight, 0]);
    const svg = chartSvg(container, width, height, margin);
    svg.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(6).tickSize(-plotWidth).tickFormat(""));
    svg
      .append("line")
      .attr("class", "reference-line")
      .attr("x1", 0)
      .attr("x2", plotWidth)
      .attr("y1", y(PAR))
      .attr("y2", y(PAR));
    svg
      .append("text")
      .attr("x", plotWidth - 3)
      .attr("y", y(PAR) - 6)
      .attr("text-anchor", "end")
      .attr("fill", "#7f8a84")
      .attr("font-size", 9)
      .text("NET PAR 36");

    groups.forEach((entry, index) => {
      const color = SERIES_COLORS[index % SERIES_COLORS.length];
      const line = d3
        .line()
        .x((record) => x(record.week))
        .y((record) => y(record.net));
      svg
        .append("path")
        .datum(entry.points)
        .attr("class", "series-line")
        .attr("d", line)
        .attr("stroke", color)
        .attr("stroke-width", 2.5);
      svg
        .append("g")
        .selectAll("circle")
        .data(entry.points)
        .join("circle")
        .attr("class", "series-point")
        .attr("cx", (record) => x(record.week))
        .attr("cy", (record) => y(record.net))
        .attr("r", 4.2)
        .attr("fill", color)
        .on("mouseenter", (event, record) => showRoundTooltip(event, record))
        .on("mousemove", moveTooltip)
        .on("mouseleave", hideTooltip);
    });

    svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${plotHeight})`)
      .call(d3.axisBottom(x).ticks(Math.min(maxWeek, 9)).tickSize(0).tickPadding(10).tickFormat((week) => `W${week}`));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickFormat(d3.format("d")));
  }

  function renderCapChart() {
    const container = elements.careerCapChart;
    container.replaceChildren();
    const groups = state.seasons.filter((entry) => entry.capHistory.length);
    const allPoints = groups.flatMap((entry) => entry.capHistory);
    if (!allPoints.length) return renderEmptyChart(container, "No commissioner cap history is available for this player.");

    const width = Math.max(container.clientWidth, 320);
    const height = 275;
    const margin = { top: 18, right: 18, bottom: 44, left: 42 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const maxWeek = d3.max(allPoints, (record) => record.week) || 1;
    const capExtent = d3.extent(allPoints, (record) => record.handicap);
    const x = d3.scaleLinear().domain([1, Math.max(2, maxWeek)]).range([0, plotWidth]);
    const y = d3
      .scaleLinear()
      .domain([Math.max(0, capExtent[0] - 1), capExtent[1] + 1])
      .nice()
      .range([plotHeight, 0]);
    const svg = chartSvg(container, width, height, margin);
    svg.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(6).tickSize(-plotWidth).tickFormat(""));

    groups.forEach((entry, index) => {
      const color = SERIES_COLORS[index % SERIES_COLORS.length];
      const line = d3
        .line()
        .curve(d3.curveStepAfter)
        .x((record) => x(record.week))
        .y((record) => y(record.handicap));
      svg
        .append("path")
        .datum(entry.capHistory)
        .attr("class", "series-line")
        .attr("d", line)
        .attr("stroke", color)
        .attr("stroke-width", 2.6);
      svg
        .append("g")
        .selectAll("circle")
        .data(entry.capHistory)
        .join("circle")
        .attr("class", "series-point")
        .attr("cx", (record) => x(record.week))
        .attr("cy", (record) => y(record.handicap))
        .attr("r", 4.2)
        .attr("fill", color)
        .on("mouseenter", (event, record) => {
          showTooltip(
            event,
            `<strong>${entry.year} ${escapeHtml(entry.league)} · Week ${record.week}</strong><span>Commissioner cap: ${record.handicap}</span>`
          );
        })
        .on("mousemove", moveTooltip)
        .on("mouseleave", hideTooltip);
    });

    svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${plotHeight})`)
      .call(d3.axisBottom(x).ticks(Math.min(maxWeek, 10)).tickSize(0).tickPadding(10).tickFormat((week) => `W${week}`));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickFormat(d3.format("d")));
  }

  function chartSvg(container, width, height, margin) {
    return d3
      .select(container)
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", container.previousElementSibling?.innerText || "Player chart")
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);
  }

  function showRoundTooltip(event, record) {
    showTooltip(
      event,
      `<strong>${record.year} ${escapeHtml(record.league)} · Week ${record.week}</strong>
       <span>${escapeHtml(record.format || record.shortName || "Round")}</span>
       <div class="tooltip-values">
         <span>Gross</span><span>${formatWhole(record.gross)}</span>
         <span>Cap</span><span>${formatAppliedCap(record)}</span>
         <span>Net</span><span>${formatWhole(record.net)}</span>
         <span>To par</span><span>${formatToPar(record.toPar)}</span>
       </div>`
    );
  }

  function showTooltip(event, html) {
    elements.profileTooltip.innerHTML = html;
    elements.profileTooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    if (elements.profileTooltip.hidden) return;
    const gap = 14;
    const rect = elements.profileTooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - gap;
    if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - gap;
    elements.profileTooltip.style.left = `${Math.max(8, left)}px`;
    elements.profileTooltip.style.top = `${Math.max(8, top)}px`;
  }

  function hideTooltip() {
    elements.profileTooltip.hidden = true;
  }

  function renderEmptyChart(container, message) {
    const empty = document.createElement("div");
    empty.className = "empty-chart";
    empty.textContent = message;
    container.append(empty);
  }

  function observeChartSizes() {
    const schedule = () => {
      if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
      state.renderFrame = requestAnimationFrame(() => {
        state.renderFrame = null;
        renderCharts();
      });
    };
    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(schedule);
      [elements.careerDistributionChart, elements.careerTrendChart, elements.careerCapChart].forEach((chart) =>
        observer.observe(chart)
      );
    } else {
      window.addEventListener("resize", schedule);
    }
  }

  function formatAppliedCap(record) {
    if (!isNumber(record.handicap)) return "—";
    return record.handicapCarried && record.handicapWeek != null
      ? `${record.handicap} (W${record.handicapWeek})`
      : String(record.handicap);
  }

  function formatCapRange(values) {
    if (!values.length) return "—";
    const low = d3.min(values);
    const high = d3.max(values);
    return low === high ? String(low) : `${low}–${high}`;
  }

  function formatBin(bin) {
    const start = Math.round(bin.x0);
    const end = Math.round(bin.x1);
    return end - start <= 1 ? String(start) : `${start}–${end - 1}`;
  }

  function formatWhole(value) {
    return isNumber(value) ? d3.format(".0f")(value) : "—";
  }

  function formatOne(value) {
    return isNumber(value) ? d3.format(".1f")(value) : "—";
  }

  function formatToPar(value) {
    if (!isNumber(value)) return "—";
    if (value === 0) return "E";
    return value > 0 ? `+${value}` : String(value);
  }

  function meanOrNull(values) {
    return values.length ? d3.mean(values) : null;
  }

  function minOrNull(values) {
    return values.length ? d3.min(values) : null;
  }

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function isPlayedRound(round) {
    return (
      round?.played === true ||
      isNumber(round?.gross) ||
      round?.omitted === true ||
      round?.markers?.some((marker) => marker.toLocaleLowerCase() === "x") ||
      (typeof round?.raw === "string" && round.raw.trim().toLocaleLowerCase() === "x")
    );
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
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
    elements.profileLoadError.hidden = false;
    const detail = elements.profileLoadError.querySelector("span");
    if (detail) detail.textContent = message;
  }
})();
