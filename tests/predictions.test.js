"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const predictions = require("../js/predictions.js");

const store = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "seasons.json"), "utf8")
);

function assertProbabilitySums(forecast) {
  for (const week of forecast.weeks) {
    const championship = week.teams.reduce((sum, team) => sum + team.championship, 0);
    const podium = week.teams.reduce((sum, team) => sum + team.podium, 0);
    const dfl = week.teams.reduce((sum, team) => sum + team.dfl, 0);
    assert.ok(Math.abs(championship - 100) < 0.0001);
    assert.ok(Math.abs(podium - 300) < 0.0001);
    assert.ok(Math.abs(dfl - 100) < 0.0001);
    week.teams.forEach((team) => {
      assert.ok(team.championship >= 0 && team.championship <= 100);
      assert.ok(team.podium >= 0 && team.podium <= 100);
      assert.ok(team.dfl >= 0 && team.dfl <= 100);
    });
  }
}

test("projects the current season from the recent historical schedule", () => {
  const forecast = predictions.runSeasonForecasts(store, "2026-jefferson", {
    simulations: 1000,
  });
  assert.equal(forecast.completedWeeks, 8);
  assert.equal(forecast.scheduleLength, 9);
  assert.equal(forecast.weeks.at(-1).weeksRemaining, 1);
  assert.equal(forecast.weeks.at(-1).projectedRounds[0].format, "Pinky");
});

test("allocates exactly one championship, three podium places, and one DFL", () => {
  const forecasts = predictions.runAllSeasonForecasts(store, { simulations: 1000 });
  assert.deepEqual(Object.keys(forecasts).sort(), store.seasons.map((season) => season.id).sort());
  Object.values(forecasts).forEach(assertProbabilitySums);
});

test("resolves completed historical seasons to their recorded final standings", () => {
  for (const season of store.seasons.slice(1)) {
    const forecast = predictions.runSeasonForecasts(store, season.id, {
      simulations: 1000,
    });
    const finalWeek = forecast.weeks.at(-1);
    assert.equal(finalWeek.weeksRemaining, 0);
    const lowestTotal = Math.min(...finalWeek.teams.map((team) => team.total));
    const highestTotal = Math.max(...finalWeek.teams.map((team) => team.total));
    finalWeek.teams.forEach((team) => {
      assert.equal(team.championship > 0, team.total === lowestTotal);
      assert.equal(team.dfl > 0, team.total === highestTotal);
    });
  }
});

test("produces stable seeded probabilities and appropriate early uncertainty", () => {
  const first = predictions.runSeasonForecasts(store, "2026-jefferson", {
    simulations: 2000,
  });
  const second = predictions.runSeasonForecasts(store, "2026-jefferson", {
    simulations: 2000,
  });
  assert.deepEqual(first.weeks, second.weeks);

  const weekOneFavorite = Math.max(...first.weeks[0].teams.map((team) => team.championship));
  const latest = first.weeks.at(-1);
  const latestFavorite = [...latest.teams].sort(
    (a, b) => b.championship - a.championship
  )[0];
  assert.ok(weekOneFavorite < 35);
  assert.equal(latestFavorite.place, 1);
  assert.ok(latestFavorite.championship > weekOneFavorite);
});
