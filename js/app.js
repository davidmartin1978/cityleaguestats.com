(function () {
  "use strict";

  const PAR = 36;
  const TEAM_COLORS = [
    "#1b5e4c",
    "#ee7d57",
    "#3d7ca6",
    "#8c5f9e",
    "#9b7439",
    "#297f76",
    "#c65f74",
    "#667c3a",
    "#5262a0",
    "#b15d36",
    "#558da0",
    "#7d6961",
    "#784c78",
    "#838a2f",
    "#2f6c8c",
    "#a64b4b",
  ];

  const state = {
    store: null,
    season: null,
    standingRows: [],
    standingsSort: { key: "placeValue", direction: "asc" },
    teamFilter: "",
    playerRows: [],
    playerTableSort: { key: "averageNet", direction: "asc" },
    playerTableFilter: "",
    selectedTeamId: null,
    selectedPlayerId: null,
    movementFocusId: null,
    rankingMode: "players",
    searchIndex: [],
  };

  const elements = {};
  let resizeTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindStaticEvents();

    if (!window.d3) {
      showLoadError("The D3 chart library did not load. Check your internet connection and refresh.");
      return;
    }

    try {
      state.store = await d3.json("data/seasons.json");
      if (!state.store?.seasons?.length) {
        throw new Error("No seasons were found in data/seasons.json");
      }
      populateSeasonSelect();
      setSeason(state.store.seasons[0].id);
      observeChartSizes();
    } catch (error) {
      console.error(error);
      showLoadError("The season JSON could not be loaded. If you opened index.html directly, use a local web server instead.");
    }
  }

  function cacheElements() {
    const ids = [
      "season-select",
      "global-search",
      "search-results",
      "load-error",
      "standings-updated",
      "standings-table",
      "team-table-search",
      "player-table",
      "player-table-search",
      "movement-team",
      "movement-all",
      "movement-chart",
      "movement-legend",
      "player-team",
      "player-select",
      "player-team-name",
      "player-name",
      "player-cap",
      "player-rounds",
      "player-avg-gross",
      "player-avg-net",
      "player-best-net",
      "distribution-chart",
      "cap-history-chart",
      "cap-history-summary",
      "rounds-chart",
      "rounds-summary",
      "rounds-table",
      "ranking-rounds",
      "ranking-sort",
      "ranking-chart",
      "ranking-list",
      "ranking-list-title",
      "chart-tooltip",
    ];

    for (const id of ids) {
      elements[toCamel(id)] = document.getElementById(id);
    }
  }

  function bindStaticEvents() {
    elements.seasonSelect.addEventListener("change", (event) => setSeason(event.target.value));

    elements.teamTableSearch.addEventListener("input", (event) => {
      state.teamFilter = event.target.value.trim().toLocaleLowerCase();
      renderStandingsBody();
    });

    elements.playerTableSearch.addEventListener("input", (event) => {
      state.playerTableFilter = event.target.value.trim().toLocaleLowerCase();
      renderPlayerTableBody();
    });

    elements.movementTeam.addEventListener("change", (event) => {
      state.movementFocusId = event.target.value;
      renderMovement();
    });

    elements.movementAll.addEventListener("change", renderMovement);

    elements.playerTeam.addEventListener("change", (event) => {
      selectTeam(event.target.value, false, true);
    });

    elements.playerSelect.addEventListener("change", (event) => {
      state.selectedPlayerId = event.target.value;
      renderPlayer();
      renderPlayerTableBody();
    });

    document.querySelectorAll("[data-ranking-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.rankingMode = button.dataset.rankingMode;
        document.querySelectorAll("[data-ranking-mode]").forEach((item) => {
          const active = item === button;
          item.classList.toggle("active", active);
          item.setAttribute("aria-pressed", String(active));
        });
        renderRankings();
      });
    });

    elements.rankingRounds.addEventListener("change", renderRankings);
    elements.rankingSort.addEventListener("change", renderRankings);

    elements.globalSearch.addEventListener("input", renderSearchResults);
    elements.globalSearch.addEventListener("focus", renderSearchResults);
    elements.globalSearch.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSearch();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".global-search")) closeSearch();
    });
  }

  function populateSeasonSelect() {
    elements.seasonSelect.replaceChildren(
      ...state.store.seasons.map((season) => new Option(season.name, season.id))
    );
  }

  function setSeason(seasonId) {
    state.season = state.store.seasons.find((item) => item.id === seasonId) || state.store.seasons[0];
    elements.seasonSelect.value = state.season.id;
    state.teamFilter = "";
    elements.teamTableSearch.value = "";
    state.standingsSort = { key: "placeValue", direction: "asc" };
    state.standingRows = buildStandingRows();
    state.playerTableFilter = "";
    elements.playerTableSearch.value = "";
    state.playerTableSort = { key: "averageNet", direction: "asc" };
    state.playerRows = buildPlayerRows();

    const leader = [...state.season.teams].sort(comparePlace)[0];
    state.selectedTeamId = leader.id;
    state.movementFocusId = leader.id;
    state.selectedPlayerId = bestDefaultPlayer(leader)?.id || leader.players[0]?.id || null;
    state.searchIndex = buildSearchIndex();

    populateTeamControls();
    populatePlayerSelect();
    renderSeasonMeta();
    renderStandings();
    renderMovement();
    renderPlayerTable();
    renderPlayer();
    renderRankings();
  }

  function buildStandingRows() {
    return state.season.teams.map((team) => {
      const playersUsed = team.players.filter((player) => numericPlayerRounds(player).length > 0).length;
      const caps = team.players.map((player) => player.handicap).filter(isNumber);
      const grossScores = team.players.flatMap((player) =>
        player.rounds.map((round) => round.gross).filter(isNumber)
      );
      const netScores = team.players.flatMap((player) =>
        playerRecords(player)
          .map((record) => record.net)
          .filter(isNumber)
      );

      return {
        team,
        id: team.id,
        name: team.name,
        rawPlace: team.place,
        placeValue: placeValue(team),
        total: team.total,
        playersUsed,
        lowCap: minOrNull(caps),
        averageCap: meanOrNull(caps),
        highCap: maxOrNull(caps),
        lowGross: minOrNull(grossScores),
        averageGross: meanOrNull(grossScores),
        highGross: maxOrNull(grossScores),
        lowNet: minOrNull(netScores),
        averageNet: meanOrNull(netScores),
        highNet: maxOrNull(netScores),
      };
    });
  }

  function buildPlayerRows() {
    return state.season.teams
      .flatMap((team) =>
        team.players.map((player) => {
          const records = playerRecords(player);
          const grossScores = records.map((record) => record.gross).filter(isNumber);
          const netScores = records.map((record) => record.net).filter(isNumber);
          const caps = state.season.rounds
            .map((round) => handicapForWeek(player, round.week)?.handicap)
            .filter(isNumber);

          return {
            id: player.id,
            teamId: team.id,
            playerName: player.name,
            teamName: team.name,
            displayName: `${player.name} - ${team.name}`,
            search: `${player.name} ${team.name}`.toLocaleLowerCase(),
            roundsPlayed: grossScores.length,
            lowGross: minOrNull(grossScores),
            averageGross: meanOrNull(grossScores),
            highGross: maxOrNull(grossScores),
            lowNet: minOrNull(netScores),
            averageNet: meanOrNull(netScores),
            highNet: maxOrNull(netScores),
            lowCap: minOrNull(caps),
            averageCap: meanOrNull(caps),
            highCap: maxOrNull(caps),
          };
        })
      )
      .filter((row) => row.roundsPlayed > 0);
  }

  function renderSeasonMeta() {
    elements.standingsUpdated.textContent = `Updated ${formatDate(state.season.asOf)}`;
  }

  function renderStandings() {
    const columns = standingColumns();
    const row = document.createElement("tr");

    for (const column of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.key = column.key;
      th.setAttribute("aria-sort", sortAria(column.key));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = column.label;
      button.title = `Sort by ${column.label}`;
      button.addEventListener("click", () => sortStandings(column.key));
      th.append(button);
      row.append(th);
    }

    elements.standingsTable.tHead.replaceChildren(row);
    renderStandingsBody();
  }

  function standingColumns() {
    return [
      { key: "placeValue", label: "Place", format: (_, row) => formatPlace(row.rawPlace) },
      { key: "name", label: "Team", format: (value) => value },
      { key: "total", label: "Total", format: formatWhole },
      { key: "playersUsed", label: "Players used", format: formatWhole },
      { key: "lowCap", label: "Low cap", format: formatOne },
      { key: "averageCap", label: "Avg cap", format: formatOne },
      { key: "highCap", label: "High cap", format: formatOne },
      { key: "lowGross", label: "Low gross", format: formatWhole },
      { key: "averageGross", label: "Avg gross", format: formatOne },
      { key: "highGross", label: "High gross", format: formatWhole },
      { key: "lowNet", label: "Low net", format: formatWhole },
      { key: "averageNet", label: "Avg net", format: formatOne },
      { key: "highNet", label: "High net", format: formatWhole },
    ];
  }

  function renderStandingsBody() {
    const columns = standingColumns();
    const filtered = state.standingRows
      .filter((row) => row.name.toLocaleLowerCase().includes(state.teamFilter))
      .sort(standingComparator);
    const fragment = document.createDocumentFragment();

    for (const data of filtered) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.teamId = data.id;
      row.classList.toggle("selected", data.id === state.selectedTeamId);
      row.setAttribute("aria-label", `${data.name}, place ${formatPlace(data.rawPlace)}. Open player stats.`);
      row.addEventListener("click", () => selectTeam(data.id, true, true));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectTeam(data.id, true, true);
        }
      });

      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = column.format(data[column.key], data);
        if (column.key === "placeValue") cell.className = "place-cell";
        if (column.key === "name") cell.className = "team-cell";
        if (column.key === "total") cell.className = "total-cell";
        row.append(cell);
      }
      fragment.append(row);
    }

    if (!filtered.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = columns.length;
      cell.textContent = "No teams match that search.";
      cell.style.textAlign = "center";
      cell.style.padding = "28px";
      row.append(cell);
      fragment.append(row);
    }

    elements.standingsTable.tBodies[0].replaceChildren(fragment);
    elements.standingsTable.tHead.querySelectorAll("th").forEach((th) => {
      th.setAttribute("aria-sort", sortAria(th.dataset.key));
    });
  }

  function sortStandings(key) {
    if (state.standingsSort.key === key) {
      state.standingsSort.direction = state.standingsSort.direction === "asc" ? "desc" : "asc";
    } else {
      state.standingsSort = {
        key,
        direction: ["name"].includes(key) ? "asc" : "asc",
      };
    }
    renderStandingsBody();
  }

  function standingComparator(a, b) {
    const key = state.standingsSort.key;
    const direction = state.standingsSort.direction === "asc" ? 1 : -1;
    const aValue = a[key];
    const bValue = b[key];
    if (aValue == null && bValue == null) return a.name.localeCompare(b.name);
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    const comparison = typeof aValue === "string" ? aValue.localeCompare(bValue) : aValue - bValue;
    return comparison * direction || a.name.localeCompare(b.name);
  }

  function sortAria(key) {
    if (state.standingsSort.key !== key) return "none";
    return state.standingsSort.direction === "asc" ? "ascending" : "descending";
  }

  function renderPlayerTable() {
    const columns = playerTableColumns();
    const row = document.createElement("tr");

    for (const column of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.key = column.key;
      th.setAttribute("aria-sort", playerTableSortAria(column.key));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = column.label;
      button.title = `Sort by ${column.label}`;
      button.addEventListener("click", () => sortPlayerTable(column.key));
      th.append(button);
      row.append(th);
    }

    elements.playerTable.tHead.replaceChildren(row);
    renderPlayerTableBody();
  }

  function playerTableColumns() {
    return [
      { key: "displayName", label: "Player - Team", format: (value) => value },
      { key: "roundsPlayed", label: "Rounds played", format: formatWhole },
      { key: "lowGross", label: "Low gross", format: formatWhole },
      { key: "averageGross", label: "Avg gross", format: formatOne },
      { key: "highGross", label: "High gross", format: formatWhole },
      { key: "lowNet", label: "Low net", format: formatWhole },
      { key: "averageNet", label: "Avg net", format: formatOne },
      { key: "highNet", label: "High net", format: formatWhole },
      { key: "lowCap", label: "Low cap", format: formatOne },
      { key: "averageCap", label: "Avg cap", format: formatOne },
      { key: "highCap", label: "High cap", format: formatOne },
    ];
  }

  function renderPlayerTableBody() {
    const columns = playerTableColumns();
    const filtered = state.playerRows
      .filter((row) => row.search.includes(state.playerTableFilter))
      .sort(playerTableComparator);
    const fragment = document.createDocumentFragment();

    for (const data of filtered) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.playerId = data.id;
      row.classList.toggle("selected", data.id === state.selectedPlayerId);
      row.setAttribute("aria-label", `${data.displayName}. Open player stats.`);
      row.addEventListener("click", () => openPlayerFromSearch(data.teamId, data.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPlayerFromSearch(data.teamId, data.id);
        }
      });

      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = column.format(data[column.key], data);
        if (column.key === "displayName") cell.className = "player-team-cell";
        row.append(cell);
      }
      fragment.append(row);
    }

    if (!filtered.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = columns.length;
      cell.textContent = "No players or teams match that search.";
      cell.style.textAlign = "center";
      cell.style.padding = "28px";
      row.append(cell);
      fragment.append(row);
    }

    elements.playerTable.tBodies[0].replaceChildren(fragment);
    elements.playerTable.tHead.querySelectorAll("th").forEach((th) => {
      th.setAttribute("aria-sort", playerTableSortAria(th.dataset.key));
    });
  }

  function sortPlayerTable(key) {
    if (state.playerTableSort.key === key) {
      state.playerTableSort.direction = state.playerTableSort.direction === "asc" ? "desc" : "asc";
    } else {
      state.playerTableSort = { key, direction: "asc" };
    }
    renderPlayerTableBody();
  }

  function playerTableComparator(a, b) {
    const key = state.playerTableSort.key;
    const direction = state.playerTableSort.direction === "asc" ? 1 : -1;
    const aValue = a[key];
    const bValue = b[key];
    if (aValue == null && bValue == null) return a.displayName.localeCompare(b.displayName);
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    const comparison = typeof aValue === "string" ? aValue.localeCompare(bValue) : aValue - bValue;
    return comparison * direction || a.displayName.localeCompare(b.displayName);
  }

  function playerTableSortAria(key) {
    if (state.playerTableSort.key !== key) return "none";
    return state.playerTableSort.direction === "asc" ? "ascending" : "descending";
  }

  function populateTeamControls() {
    const teams = [...state.season.teams].sort(comparePlace);
    elements.movementTeam.replaceChildren(
      ...teams.map((team) => new Option(`${formatPlace(team.place)} · ${team.name}`, team.id))
    );
    elements.playerTeam.replaceChildren(...teams.map((team) => new Option(team.name, team.id)));
    elements.movementTeam.value = state.movementFocusId;
    elements.playerTeam.value = state.selectedTeamId;
  }

  function populatePlayerSelect() {
    const team = selectedTeam();
    if (!team) return;
    const players = [...team.players].sort((a, b) => {
      const roundsDifference = numericPlayerRounds(b).length - numericPlayerRounds(a).length;
      return roundsDifference || a.name.localeCompare(b.name);
    });

    elements.playerSelect.replaceChildren(
      ...players.map((player) => {
        const rounds = numericPlayerRounds(player).length;
        const cap = player.handicap == null ? "no cap" : `cap ${player.handicap}`;
        return new Option(`${player.name} · ${cap} · ${rounds} rd`, player.id);
      })
    );

    if (!players.some((player) => player.id === state.selectedPlayerId)) {
      state.selectedPlayerId = bestDefaultPlayer(team)?.id || players[0]?.id || null;
    }
    elements.playerSelect.value = state.selectedPlayerId;
  }

  function selectTeam(teamId, scrollToPlayers, chooseDefaultPlayer) {
    const team = state.season.teams.find((item) => item.id === teamId);
    if (!team) return;
    state.selectedTeamId = team.id;
    state.movementFocusId = team.id;
    if (chooseDefaultPlayer) {
      state.selectedPlayerId = bestDefaultPlayer(team)?.id || team.players[0]?.id || null;
    }
    elements.playerTeam.value = team.id;
    elements.movementTeam.value = team.id;
    populatePlayerSelect();
    renderPlayer();
    renderMovement();
    renderStandingsBody();
    renderPlayerTableBody();
    if (scrollToPlayers) {
      document.getElementById("players").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function movementSeries() {
    const cumulativeByWeek = state.season.rounds.map((_, weekIndex) => {
      const totals = state.season.teams.map((team) =>
        d3.sum(team.rounds.slice(0, weekIndex + 1), (round) => round.net ?? 0)
      );
      const lead = d3.min(totals);
      return { totals, lead };
    });

    return state.season.teams.map((team, teamIndex) => ({
      id: team.id,
      name: team.name,
      color: teamColor(team.id),
      place: team.place,
      points: state.season.rounds.map((round, weekIndex) => {
        const cumulative = cumulativeByWeek[weekIndex].totals[teamIndex];
        return {
          week: round.week,
          round,
          cumulative,
          shotsBack: cumulative - cumulativeByWeek[weekIndex].lead,
        };
      }),
    }));
  }

  function renderMovement() {
    const container = elements.movementChart;
    container.replaceChildren();
    if (!state.season) return;

    const allSeries = movementSeries();
    const showField = elements.movementAll.checked;
    const visible = showField
      ? allSeries
      : allSeries.filter((series) => series.id === state.movementFocusId);
    const ordered = visible.sort((a, b) => Number(a.id === state.movementFocusId) - Number(b.id === state.movementFocusId));
    const width = Math.max(520, container.clientWidth || 800);
    const height = 450;
    const margin = { top: 22, right: 28, bottom: 58, left: 57 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const maxBack = Math.max(5, d3.max(allSeries, (series) => d3.max(series.points, (point) => point.shotsBack)));
    const x = d3
      .scalePoint()
      .domain(state.season.rounds.map((round) => round.week))
      .range([margin.left, margin.left + plotWidth])
      .padding(0.15);
    const y = d3.scaleLinear().domain([0, Math.ceil(maxBack / 5) * 5]).nice().range([margin.top, margin.top + plotHeight]);
    const line = d3
      .line()
      .x((point) => x(point.week))
      .y((point) => y(point.shotsBack))
      .curve(d3.curveMonotoneX);

    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", "Cumulative shots back of the weekly leader by team");
    svg.append("title").text("Season standings movement in cumulative shots back");

    svg
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).tickSize(-plotWidth).tickFormat("").ticks(7));

    svg
      .append("line")
      .attr("class", "leader-line")
      .attr("x1", margin.left)
      .attr("x2", margin.left + plotWidth)
      .attr("y1", y(0))
      .attr("y2", y(0));

    const yAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(7).tickFormat((value) => (value === 0 ? "Leader" : `+${value}`)));
    yAxis.select(".domain").remove();

    const xAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${margin.top + plotHeight})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat((week) => `W${week}`));
    xAxis.select(".domain").attr("stroke", "#cfd5cd");
    xAxis
      .selectAll(".tick text")
      .append("tspan")
      .attr("x", 0)
      .attr("dy", "1.45em")
      .attr("fill", "#9aa39e")
      .attr("font-size", 8)
      .text((week) => roundByWeek(week).shortName);

    svg
      .append("text")
      .attr("class", "chart-axis-label")
      .attr("x", margin.left)
      .attr("y", 10)
      .text("Shots back");

    const seriesGroup = svg.append("g");
    const groups = seriesGroup
      .selectAll("g")
      .data(ordered)
      .join("g")
      .attr("data-team", (series) => series.id);

    groups
      .append("path")
      .attr("class", "movement-line")
      .attr("d", (series) => line(series.points))
      .attr("stroke", (series) => series.color)
      .attr("stroke-width", (series) => (series.id === state.movementFocusId ? 3.6 : 1.5))
      .attr("opacity", (series) => (series.id === state.movementFocusId ? 1 : 0.42));

    groups
      .selectAll("circle")
      .data((series) => series.points.map((point) => ({ ...point, series })))
      .join("circle")
      .attr("class", "movement-point")
      .attr("cx", (point) => x(point.week))
      .attr("cy", (point) => y(point.shotsBack))
      .attr("r", (point) => (point.series.id === state.movementFocusId ? 4 : 2.8))
      .attr("fill", (point) => point.series.color)
      .attr("opacity", (point) => (point.series.id === state.movementFocusId ? 1 : 0.7))
      .on("pointerenter", function (event, point) {
        d3.select(this).attr("r", 5);
        showTooltip(
          event,
          `<strong>${escapeHtml(point.series.name)}</strong>Week ${point.week} · ${escapeHtml(point.round.format)}<div class="tooltip-values"><span>Shots back</span><span>${point.shotsBack === 0 ? "Leader" : `+${point.shotsBack}`}</span><span>Cumulative</span><span>${point.cumulative}</span></div>`
        );
      })
      .on("pointermove", moveTooltip)
      .on("pointerleave", function (event, point) {
        d3.select(this).attr("r", point.series.id === state.movementFocusId ? 4 : 2.8);
        hideTooltip();
      });

    renderMovementLegend(allSeries);
  }

  function renderMovementLegend(series) {
    const sorted = [...series].sort((a, b) => placeValueByRaw(a.place) - placeValueByRaw(b.place));
    const fragment = document.createDocumentFragment();
    for (const item of sorted) {
      const latest = item.points[item.points.length - 1];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "legend-team";
      button.classList.toggle("active", item.id === state.movementFocusId);
      button.style.setProperty("--team-color", item.color);
      button.innerHTML = `<i aria-hidden="true"></i><span>${escapeHtml(item.name)}</span><small>${latest.shotsBack === 0 ? "Lead" : `+${latest.shotsBack}`}</small>`;
      button.addEventListener("click", () => {
        state.movementFocusId = item.id;
        elements.movementTeam.value = item.id;
        renderMovement();
      });
      fragment.append(button);
    }
    elements.movementLegend.replaceChildren(fragment);
  }

  function renderPlayer() {
    const team = selectedTeam();
    const player = selectedPlayer();
    if (!team || !player) return;
    const records = playerRecords(player).filter((record) => isNumber(record.gross));
    const netRecords = records.filter((record) => isNumber(record.net));

    elements.playerTeamName.textContent = team.name;
    elements.playerName.textContent = player.name;
    elements.playerCap.textContent = player.handicap ?? "—";
    elements.playerRounds.textContent = records.length;
    elements.playerAvgGross.textContent = formatOne(meanOrNull(records.map((record) => record.gross)));
    elements.playerAvgNet.textContent = formatOne(meanOrNull(netRecords.map((record) => record.net)));
    elements.playerBestNet.textContent = formatWhole(minOrNull(netRecords.map((record) => record.net)));
    elements.roundsSummary.textContent = records.length
      ? `${records.length} recorded round${records.length === 1 ? "" : "s"}`
      : "No numeric scores yet";

    renderDistribution(records);
    renderCapHistory(player);
    renderRoundsChart(records);
    renderRoundsTable(player);
  }

  function renderDistribution(records) {
    const container = elements.distributionChart;
    container.replaceChildren();
    if (!records.length) {
      renderEmptyChart(container, "No numeric rounds to chart yet.");
      return;
    }

    const gross = records.map((record) => record.gross);
    const net = records.map((record) => record.net).filter(isNumber);
    const combined = gross.concat(net);
    let low = Math.floor((d3.min(combined) - 2) / 2) * 2;
    let high = Math.ceil((d3.max(combined) + 2) / 2) * 2;
    if (low === high) high += 4;
    const width = Math.max(430, container.clientWidth || 650);
    const height = 285;
    const margin = { top: 15, right: 16, bottom: 36, left: 40 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = d3.scaleLinear().domain([low, high]).range([margin.left, margin.left + plotWidth]);
    const thresholds = x.ticks(Math.min(9, Math.max(4, records.length + 2)));
    const bin = d3.bin().domain(x.domain()).thresholds(thresholds);
    const grossBins = bin(gross);
    const netBins = bin(net);
    const y = d3
      .scaleLinear()
      .domain([0, Math.max(1, d3.max(grossBins.concat(netBins), (item) => item.length))])
      .nice()
      .range([margin.top + plotHeight, margin.top]);
    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", "Histogram comparing gross and net score distributions");

    svg
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-plotWidth).tickFormat(""));

    const binWidth = grossBins.length ? Math.max(5, x(grossBins[0].x1) - x(grossBins[0].x0) - 3) : 10;
    const halfWidth = Math.max(2, binWidth / 2);

    drawHistogramBars(svg, netBins, x, y, halfWidth, 0, "#205746", "Net");
    drawHistogramBars(svg, grossBins, x, y, halfWidth, halfWidth, "#f0835c", "Gross");

    const xAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${margin.top + plotHeight})`)
      .call(d3.axisBottom(x).ticks(7).tickSize(0).tickPadding(10));
    xAxis.select(".domain").attr("stroke", "#cfd5cd");
    const yAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("d")));
    yAxis.select(".domain").remove();
    svg
      .append("text")
      .attr("class", "chart-axis-label")
      .attr("x", margin.left + plotWidth)
      .attr("y", height - 2)
      .attr("text-anchor", "end")
      .text("Score");
  }

  function drawHistogramBars(svg, bins, x, y, width, offset, color, label) {
    svg
      .append("g")
      .selectAll("rect")
      .data(bins)
      .join("rect")
      .attr("x", (item) => x(item.x0) + 1 + offset)
      .attr("y", (item) => y(item.length))
      .attr("width", width)
      .attr("height", (item) => Math.max(0, y(0) - y(item.length)))
      .attr("rx", 2)
      .attr("fill", color)
      .attr("opacity", (item) => (item.length ? 0.9 : 0.1))
      .on("pointerenter", (event, item) => {
        showTooltip(
          event,
          `<strong>${label} scores</strong>${formatRange(item.x0, item.x1)}<div class="tooltip-values"><span>Rounds</span><span>${item.length}</span></div>`
        );
      })
      .on("pointermove", moveTooltip)
      .on("pointerleave", hideTooltip);
  }

  function renderCapHistory(player) {
    const container = elements.capHistoryChart;
    const history = playerHandicapHistory(player);
    container.replaceChildren();

    if (!history.length) {
      elements.capHistorySummary.textContent = "No reported caps";
      renderEmptyChart(container, "No weekly handicap history is available for this player.");
      return;
    }

    const first = history[0].handicap;
    const last = history[history.length - 1].handicap;
    const change = last - first;
    const movement = change === 0 ? "no change" : `${change > 0 ? "↑" : "↓"}${Math.abs(change)}`;
    elements.capHistorySummary.textContent = `${history.length} reported week${history.length === 1 ? "" : "s"} · ${first} → ${last} · ${movement}`;

    const width = Math.max(560, container.clientWidth || 900);
    const height = 260;
    const margin = { top: 18, right: 24, bottom: 42, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = d3
      .scalePoint()
      .domain(state.season.rounds.map((round) => round.week))
      .range([margin.left, margin.left + plotWidth])
      .padding(0.2);
    let low = d3.min(history, (record) => record.handicap);
    let high = d3.max(history, (record) => record.handicap);
    if (low === high) {
      low -= 2;
      high += 2;
    } else {
      low -= 1;
      high += 1;
    }
    const y = d3.scaleLinear().domain([low, high]).nice().range([margin.top + plotHeight, margin.top]);
    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", `${player.name} reported handicap by week`);

    svg
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-plotWidth).tickFormat(""));

    const line = d3
      .line()
      .x((record) => x(record.week))
      .y((record) => y(record.handicap))
      .curve(d3.curveStepAfter);

    svg
      .append("path")
      .datum(history)
      .attr("class", "cap-history-line")
      .attr("d", line);

    svg
      .append("g")
      .selectAll("circle")
      .data(history)
      .join("circle")
      .attr("class", "cap-history-point")
      .attr("cx", (record) => x(record.week))
      .attr("cy", (record) => y(record.handicap))
      .attr("r", 5)
      .on("pointerenter", (event, record) => {
        const source = handicapSourceForWeek(record.week);
        showTooltip(
          event,
          `<strong>Week ${record.week} reported cap</strong>${source ? formatDate(source.asOf) : "Commissioner snapshot"}<div class="tooltip-values"><span>Handicap</span><span>${formatWhole(record.handicap)}</span></div>`
        );
      })
      .on("pointermove", moveTooltip)
      .on("pointerleave", hideTooltip);

    svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${margin.top + plotHeight})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat((week) => `W${week}`));
    const yAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("d")));
    yAxis.select(".domain").remove();
    svg
      .append("text")
      .attr("class", "chart-axis-label")
      .attr("x", margin.left)
      .attr("y", 10)
      .text("Handicap");
  }

  function renderRoundsChart(records) {
    const container = elements.roundsChart;
    container.replaceChildren();
    if (!records.length) {
      renderEmptyChart(container, "This player has no numeric round history yet.");
      return;
    }

    const values = records.flatMap((record) => [record.gross, record.net]).filter(isNumber).concat(PAR);
    const low = Math.floor((d3.min(values) - 3) / 5) * 5;
    const high = Math.ceil((d3.max(values) + 3) / 5) * 5;
    const width = Math.max(560, container.clientWidth || 900);
    const height = 340;
    const margin = { top: 18, right: 24, bottom: 55, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const x = d3
      .scalePoint()
      .domain(state.season.rounds.map((round) => round.week))
      .range([margin.left, margin.left + plotWidth])
      .padding(0.2);
    const y = d3.scaleLinear().domain([low, high]).nice().range([margin.top + plotHeight, margin.top]);
    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", "Selected player gross and calculated net scores by week");

    svg
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(6).tickSize(-plotWidth).tickFormat(""));

    if (PAR >= y.domain()[0] && PAR <= y.domain()[1]) {
      svg
        .append("line")
        .attr("class", "par-line")
        .attr("x1", margin.left)
        .attr("x2", margin.left + plotWidth)
        .attr("y1", y(PAR))
        .attr("y2", y(PAR));
      svg
        .append("text")
        .attr("class", "chart-axis-label")
        .attr("x", margin.left + plotWidth)
        .attr("y", y(PAR) - 6)
        .attr("text-anchor", "end")
        .text("Net par 36");
    }

    const series = [
      { key: "net", label: "Net", color: "#205746" },
      { key: "gross", label: "Gross", color: "#f0835c" },
    ];
    const line = (key) =>
      d3
        .line()
        .defined((record) => isNumber(record[key]))
        .x((record) => x(record.week))
        .y((record) => y(record[key]))
        .curve(d3.curveMonotoneX);

    for (const item of series) {
      svg
        .append("path")
        .datum(records)
        .attr("class", "score-line")
        .attr("stroke", item.color)
        .attr("d", line(item.key));
      svg
        .append("g")
        .selectAll("circle")
        .data(records.filter((record) => isNumber(record[item.key])))
        .join("circle")
        .attr("class", "score-point")
        .attr("cx", (record) => x(record.week))
        .attr("cy", (record) => y(record[item.key]))
        .attr("r", 4)
        .attr("fill", item.color)
        .on("pointerenter", (event, record) => {
          showTooltip(
            event,
            `<strong>Week ${record.week} · ${escapeHtml(record.format)}</strong><div class="tooltip-values"><span>Gross</span><span>${formatWhole(record.gross)}</span><span>Applied cap</span><span>${formatWhole(record.handicap)}</span><span>Cap source</span><span>${escapeHtml(capSourceLabel(record))}</span><span>Net</span><span>${formatWhole(record.net)}</span><span>To par</span><span>${formatToPar(record.toPar)}</span></div>`
          );
        })
        .on("pointermove", moveTooltip)
        .on("pointerleave", hideTooltip);
    }

    const xAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${margin.top + plotHeight})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat((week) => `W${week}`));
    xAxis
      .selectAll(".tick text")
      .append("tspan")
      .attr("x", 0)
      .attr("dy", "1.45em")
      .attr("fill", "#9aa39e")
      .attr("font-size", 8)
      .text((week) => roundByWeek(week).shortName);
    const yAxis = svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(6));
    yAxis.select(".domain").remove();
  }

  function renderRoundsTable(player) {
    const header = document.createElement("tr");
    ["Round", "Format", "Gross", "Applied cap", "Net", "To par"].forEach((label) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      header.append(th);
    });
    elements.roundsTable.tHead.replaceChildren(header);

    const records = playerRecords(player).filter((record) => record.raw != null);
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const row = document.createElement("tr");
      const values = [
        `Week ${record.week}`,
        record.format,
        record.gross == null ? record.raw.toUpperCase() : record.gross,
        formatAppliedCap(record),
        record.net,
        record.toPar,
      ];
      values.forEach((value, index) => {
        const cell = document.createElement("td");
        if (index === 5 && isNumber(value)) {
          cell.textContent = formatToPar(value);
          cell.className = value <= 0 ? "under-par" : "over-par";
        } else {
          cell.textContent = value == null ? "—" : value;
        }
        row.append(cell);
      });
      fragment.append(row);
    }

    if (!records.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.textContent = "No rounds have been recorded for this player.";
      cell.style.textAlign = "center";
      cell.style.padding = "24px";
      row.append(cell);
      fragment.append(row);
    }
    elements.roundsTable.tBodies[0].replaceChildren(fragment);
  }

  function rankingData() {
    if (state.rankingMode === "teams") {
      return state.season.teams.map((team) => {
        const records = team.players.flatMap((player) =>
          playerRecords(player).filter((record) => isNumber(record.gross) && isNumber(record.net))
        );
        return summarizeRankingRecords(records, {
          id: team.id,
          name: team.name,
          displayName: team.name,
          subline: `${records.length} player rounds`,
        });
      });
    }

    return state.season.teams.flatMap((team) =>
      team.players.map((player) => {
        const records = playerRecords(player).filter((record) => isNumber(record.gross) && isNumber(record.net));
        return summarizeRankingRecords(records, {
          id: player.id,
          name: player.name,
          displayName: `${player.name} (${team.name})`,
          subline: team.name,
          teamId: team.id,
        });
      })
    );
  }

  function summarizeRankingRecords(records, identity) {
    const gross = meanOrNull(records.map((record) => record.gross));
    const net = meanOrNull(records.map((record) => record.net));
    const underParRounds = records.filter((record) => record.net < PAR).length;
    const evenParRounds = records.filter((record) => record.net === PAR).length;
    const overParRounds = records.filter((record) => record.net > PAR).length;
    return {
      ...identity,
      rounds: records.length,
      gross,
      net,
      averageToPar: net == null ? null : net - PAR,
      underParRounds,
      evenParRounds,
      overParRounds,
      underParRate: records.length ? underParRounds / records.length : null,
      overParRate: records.length ? overParRounds / records.length : null,
    };
  }

  function renderRankings() {
    if (!state.season) return;
    const minimumRounds = Number(elements.rankingRounds.value);
    const sort = elements.rankingSort.value;
    const data = rankingData()
      .filter((item) => item.rounds >= minimumRounds && isNumber(item.averageToPar))
      .sort((a, b) => rankingComparator(a, b, sort));

    const titleBySort = {
      under: "Most under net par",
      frequency: "Most often under par",
      over: "Most over net par",
    };
    elements.rankingListTitle.textContent = titleBySort[sort];
    renderRankingChart(data.slice(0, 14));
    renderRankingList(data.slice(0, 10), sort);
  }

  function rankingComparator(a, b, sort) {
    if (sort === "frequency") {
      return (
        b.underParRate - a.underParRate ||
        a.averageToPar - b.averageToPar ||
        b.rounds - a.rounds ||
        a.name.localeCompare(b.name)
      );
    }
    if (sort === "over") {
      return (
        b.averageToPar - a.averageToPar ||
        b.overParRate - a.overParRate ||
        b.rounds - a.rounds ||
        a.name.localeCompare(b.name)
      );
    }
    return (
      a.averageToPar - b.averageToPar ||
      b.underParRate - a.underParRate ||
      b.rounds - a.rounds ||
      a.name.localeCompare(b.name)
    );
  }

  function renderRankingChart(data) {
    const container = elements.rankingChart;
    container.replaceChildren();
    if (!data.length) {
      renderEmptyChart(container, "No scores meet the selected round minimum.");
      return;
    }

    const width = Math.max(520, container.clientWidth || 760);
    const rowHeight = 36;
    const height = Math.max(490, data.length * rowHeight + 62);
    const margin = { top: 16, right: 28, bottom: 38, left: width < 650 ? 130 : 205 };
    const plotWidth = width - margin.left - margin.right;
    const furthestFromPar = Math.max(2, d3.max(data, (item) => Math.abs(item.averageToPar)));
    const extent = Math.ceil(furthestFromPar + 1);
    const x = d3
      .scaleLinear()
      .domain([-extent, extent])
      .range([margin.left, margin.left + plotWidth]);
    const y = d3
      .scaleBand()
      .domain(data.map((item) => item.id))
      .range([margin.top, height - margin.bottom])
      .padding(0.42);
    const svg = d3
      .select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", "Ranked chart of average net score relative to nine-hole par 36");

    svg
      .append("rect")
      .attr("x", x(-extent))
      .attr("y", margin.top)
      .attr("width", x(0) - x(-extent))
      .attr("height", height - margin.top - margin.bottom)
      .attr("fill", "#d6ef73")
      .attr("opacity", 0.035);

    svg
      .append("rect")
      .attr("x", x(0))
      .attr("y", margin.top)
      .attr("width", x(extent) - x(0))
      .attr("height", height - margin.top - margin.bottom)
      .attr("fill", "#f0835c")
      .attr("opacity", 0.035);

    svg
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(9).tickSize(-(height - margin.top - margin.bottom)).tickFormat(""));

    svg
      .append("line")
      .attr("class", "net-par-line")
      .attr("x1", x(0))
      .attr("x2", x(0))
      .attr("y1", margin.top)
      .attr("y2", height - margin.bottom);

    svg
      .append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .ticks(9)
          .tickSize(0)
          .tickPadding(10)
          .tickFormat((value) => (value === 0 ? "E" : value > 0 ? `+${value}` : value))
      );

    const rows = svg
      .append("g")
      .selectAll("g")
      .data(data)
      .join("g")
      .attr("transform", (item) => `translate(0,${y(item.id) + y.bandwidth() / 2})`);

    rows
      .append("line")
      .attr("class", "ranking-connector")
      .attr("x1", x(0))
      .attr("x2", (item) => x(item.averageToPar))
      .style("stroke", (item) => rankingColor(item.averageToPar));

    rows
      .append("circle")
      .attr("cx", (item) => x(item.averageToPar))
      .attr("r", 5.5)
      .attr("fill", (item) => rankingColor(item.averageToPar))
      .attr("stroke", "#0e2b23")
      .attr("stroke-width", 1.5);

    rows
      .append("text")
      .attr("class", "ranking-label")
      .attr("x", margin.left - 10)
      .attr("dy", "0.34em")
      .attr("text-anchor", "end")
      .text((item) => truncate(item.displayName, width < 650 ? 19 : 32));

    rows
      .append("rect")
      .attr("x", margin.left)
      .attr("y", -rowHeight / 2)
      .attr("width", plotWidth)
      .attr("height", rowHeight)
      .attr("fill", "transparent")
      .on("pointerenter", (event, item) => {
        showTooltip(
          event,
          `<strong>${escapeHtml(item.displayName)}</strong><div class="tooltip-values"><span>Avg net</span><span>${formatOne(item.net)}</span><span>Avg to par</span><span>${formatAverageToPar(item.averageToPar)}</span><span>Under par</span><span>${item.underParRounds} · ${formatPercent(item.underParRate)}</span><span>Even par</span><span>${item.evenParRounds}</span><span>Over par</span><span>${item.overParRounds}</span><span>Rounds</span><span>${item.rounds}</span></div>`
        );
      })
      .on("pointermove", moveTooltip)
      .on("pointerleave", hideTooltip)
      .on("click", (_, item) => {
        if (state.rankingMode === "players") openPlayer(item.teamId, item.id);
      });
  }

  function renderRankingList(data, sort) {
    const fragment = document.createDocumentFragment();
    for (const item of data) {
      const row = document.createElement("li");
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = item.displayName;
      const subline = document.createElement("small");
      subline.textContent = item.teamId
        ? `${formatPercent(item.underParRate)} under par · ${item.rounds} rd`
        : `${formatPercent(item.underParRate)} under par · ${item.rounds} player rd`;
      identity.append(name, subline);

      const value = document.createElement("div");
      value.className = "ranking-list-value";
      const metric = sort === "frequency" ? formatPercent(item.underParRate) : formatAverageToPar(item.averageToPar);
      const suffix = sort === "frequency" ? "under" : "vs par";
      value.innerHTML = `${metric}<span>${suffix}</span>`;
      row.append(identity, value);
      if (state.rankingMode === "players") {
        row.style.cursor = "pointer";
        row.title = "Open player stats";
        row.addEventListener("click", () => openPlayer(item.teamId, item.id));
      }
      fragment.append(row);
    }
    elements.rankingList.replaceChildren(fragment);
  }

  function rankingColor(averageToPar) {
    if (averageToPar < -0.25) return "#d6ef73";
    if (averageToPar > 0.25) return "#f0835c";
    return "#aeb8b2";
  }

  function buildSearchIndex() {
    const teams = state.season.teams.map((team) => ({
      type: "Team",
      id: team.id,
      teamId: team.id,
      name: team.name,
      subline: `${formatPlace(team.place)} place · ${team.total} total`,
      search: team.name.toLocaleLowerCase(),
    }));
    const players = state.season.teams.flatMap((team) =>
      team.players.map((player) => ({
        type: "Player",
        id: player.id,
        teamId: team.id,
        name: player.name,
        subline: `${team.name} · cap ${player.handicap ?? "—"}`,
        search: `${player.name} ${team.name}`.toLocaleLowerCase(),
      }))
    );
    return teams.concat(players);
  }

  function renderSearchResults() {
    if (!state.season) return;
    const query = elements.globalSearch.value.trim().toLocaleLowerCase();
    if (!query) {
      closeSearch();
      return;
    }

    const results = state.searchIndex
      .filter((item) => item.search.includes(query))
      .sort((a, b) => {
        const aStarts = a.search.startsWith(query) ? 0 : 1;
        const bStarts = b.search.startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 9);
    const fragment = document.createDocumentFragment();

    for (const result of results) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";
      button.setAttribute("role", "option");
      button.innerHTML = `<span><strong>${escapeHtml(result.name)}</strong><small>${escapeHtml(result.subline)}</small></span><span class="search-result-type">${result.type}</span>`;
      button.addEventListener("click", () => {
        if (result.type === "Player") openPlayer(result.teamId, result.id);
        else selectTeam(result.teamId, true, true);
        elements.globalSearch.value = "";
        closeSearch();
      });
      fragment.append(button);
    }

    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "No teams or players found.";
      fragment.append(empty);
    }

    elements.searchResults.replaceChildren(fragment);
    elements.searchResults.hidden = false;
    elements.globalSearch.setAttribute("aria-expanded", "true");
  }

  function closeSearch() {
    elements.searchResults.hidden = true;
    elements.globalSearch.setAttribute("aria-expanded", "false");
  }

  function openPlayer(teamId, playerId) {
    const team = state.season.teams.find((item) => item.id === teamId);
    if (!team || !team.players.some((player) => player.id === playerId)) return;
    state.selectedTeamId = teamId;
    state.movementFocusId = teamId;
    state.selectedPlayerId = playerId;
    elements.playerTeam.value = teamId;
    elements.movementTeam.value = teamId;
    populatePlayerSelect();
    elements.playerSelect.value = playerId;
    renderPlayer();
    renderMovement();
    renderStandingsBody();
    renderPlayerTableBody();
    document.getElementById("players").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function playerHandicapHistory(player) {
    const history = Array.isArray(player.handicapHistory)
      ? player.handicapHistory
          .filter((record) => isNumber(record.week) && isNumber(record.handicap))
          .sort((a, b) => a.week - b.week)
      : [];
    if (history.length || !isNumber(player.handicap)) return history;
    return [{ week: state.season.rounds.at(-1)?.week ?? 1, handicap: player.handicap }];
  }

  function handicapSourceForWeek(week) {
    return state.season.handicapWeeks?.find((source) => source.week === week) || null;
  }

  function handicapForWeek(player, week) {
    if (!Array.isArray(player.handicapHistory)) {
      return isNumber(player.handicap)
        ? { handicap: player.handicap, reportedWeek: null, carried: false }
        : null;
    }

    const exact = player.handicapHistory.find((record) => record.week === week);
    if (exact) {
      return {
        handicap: exact.handicap,
        reportedWeek: exact.week,
        carried: false,
      };
    }

    const previous = [...player.handicapHistory]
      .reverse()
      .find((record) => record.week < week && isNumber(record.handicap));
    return previous
      ? { handicap: previous.handicap, reportedWeek: previous.week, carried: true }
      : null;
  }

  function capSourceLabel(record) {
    if (!isNumber(record.handicap)) return "Unavailable";
    if (record.handicapWeek == null) return "Current cap fallback";
    return record.handicapCarried
      ? `Week ${record.handicapWeek} carried`
      : `Week ${record.handicapWeek}`;
  }

  function formatAppliedCap(record) {
    if (!isNumber(record.handicap)) return "—";
    return record.handicapCarried
      ? `${record.handicap} (W${record.handicapWeek})`
      : String(record.handicap);
  }

  function playerRecords(player) {
    return state.season.rounds.map((round, index) => {
      const score = player.rounds[index] || {};
      const appliedCap = handicapForWeek(player, round.week);
      const handicap = appliedCap?.handicap;
      const net = isNumber(score.gross) && isNumber(handicap) ? score.gross - handicap : null;
      return {
        week: round.week,
        format: round.format,
        shortName: round.shortName,
        gross: score.gross,
        raw: score.raw,
        markers: score.markers || [],
        handicap,
        handicapWeek: appliedCap?.reportedWeek ?? null,
        handicapCarried: appliedCap?.carried ?? false,
        net,
        toPar: isNumber(net) ? net - PAR : null,
      };
    });
  }

  function numericPlayerRounds(player) {
    return player.rounds.filter((round) => isNumber(round.gross));
  }

  function bestDefaultPlayer(team) {
    return [...team.players].sort((a, b) => {
      const difference = numericPlayerRounds(b).length - numericPlayerRounds(a).length;
      return difference || a.name.localeCompare(b.name);
    })[0];
  }

  function selectedTeam() {
    return state.season?.teams.find((team) => team.id === state.selectedTeamId);
  }

  function selectedPlayer() {
    return selectedTeam()?.players.find((player) => player.id === state.selectedPlayerId);
  }

  function roundByWeek(week) {
    return state.season.rounds.find((round) => round.week === week);
  }

  function teamColor(teamId) {
    const index = state.season.teams.findIndex((team) => team.id === teamId);
    return TEAM_COLORS[index % TEAM_COLORS.length];
  }

  function placeValue(team) {
    return placeValueByRaw(team.place);
  }

  function placeValueByRaw(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? number : 999;
  }

  function comparePlace(a, b) {
    return placeValue(a) - placeValue(b) || a.total - b.total || a.name.localeCompare(b.name);
  }

  function formatPlace(value) {
    const numeric = Number.parseInt(value, 10);
    if (!Number.isFinite(numeric)) return value;
    const tied = state.season.teams.filter((team) => Number.parseInt(team.place, 10) === numeric).length > 1;
    return `${tied ? "T" : ""}${numeric}`;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
      new Date(`${value}T12:00:00`)
    );
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

  function formatAverageToPar(value) {
    if (!isNumber(value)) return "—";
    if (Math.abs(value) < 0.05) return "E";
    return value > 0 ? `+${formatOne(value)}` : formatOne(value);
  }

  function formatPercent(value) {
    return isNumber(value) ? d3.format(".0%")(value) : "—";
  }

  function formatRange(start, end) {
    return `${formatOne(start)}–${formatOne(end)}`;
  }

  function meanOrNull(values) {
    return values.length ? d3.mean(values) : null;
  }

  function minOrNull(values) {
    return values.length ? d3.min(values) : null;
  }

  function maxOrNull(values) {
    return values.length ? d3.max(values) : null;
  }

  function isNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function truncate(value, length) {
    return value.length > length ? `${value.slice(0, length - 1)}…` : value;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderEmptyChart(container, message) {
    const empty = document.createElement("div");
    empty.className = "empty-chart";
    empty.textContent = message;
    container.append(empty);
  }

  function showTooltip(event, html) {
    elements.chartTooltip.innerHTML = html;
    elements.chartTooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    if (elements.chartTooltip.hidden) return;
    const gap = 14;
    const rect = elements.chartTooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + rect.width > window.innerWidth - 8) left = event.clientX - rect.width - gap;
    if (top + rect.height > window.innerHeight - 8) top = event.clientY - rect.height - gap;
    elements.chartTooltip.style.left = `${Math.max(8, left)}px`;
    elements.chartTooltip.style.top = `${Math.max(8, top)}px`;
  }

  function hideTooltip() {
    elements.chartTooltip.hidden = true;
  }

  function showLoadError(message) {
    elements.loadError.hidden = false;
    const detail = elements.loadError.querySelector("span");
    if (detail) detail.textContent = message;
  }

  function observeChartSizes() {
    if (!("ResizeObserver" in window)) {
      window.addEventListener("resize", scheduleChartRender);
      return;
    }
    const observer = new ResizeObserver(scheduleChartRender);
    [
      elements.movementChart,
      elements.distributionChart,
      elements.capHistoryChart,
      elements.roundsChart,
      elements.rankingChart,
    ].forEach((element) => observer.observe(element));
  }

  function scheduleChartRender() {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!state.season) return;
      renderMovement();
      renderPlayer();
      renderRankings();
    }, 120);
  }
})();
