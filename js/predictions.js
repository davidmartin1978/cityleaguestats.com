(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CityLeaguePredictions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_SIMULATIONS = 30000;
  const MIN_VARIANCE = 1;
  const MIN_FORMAT_SAMPLE = 20;

  function runSeasonForecasts(store, seasonId, options = {}) {
    const season = store?.seasons?.find((item) => item.id === seasonId);
    if (!season) throw new Error(`Season not found: ${seasonId}`);

    const schedule = projectedSchedule(store, season);
    const completedWeeks = completedRoundCount(season);
    const calibration = buildCalibration(store, season);
    const simulations = normalizeSimulationCount(options.simulations);
    const weeks = [];

    for (let cutoff = 1; cutoff <= completedWeeks; cutoff += 1) {
      weeks.push(
        forecastWeek({
          season,
          schedule,
          cutoff,
          calibration,
          simulations,
          seed: `${options.seed || "city-league"}|${season.id}|${cutoff}`,
        })
      );
    }

    return {
      seasonId: season.id,
      scheduleLength: schedule.length,
      completedWeeks,
      simulations,
      calibration: {
        trainingSeasons: calibration.trainingSeasonCount,
        trainingRounds: calibration.trainingRoundCount,
        observations: calibration.observationCount,
        teamStrengthSd: Math.sqrt(calibration.teamVariance),
        weeklyVolatilitySd: Math.sqrt(calibration.noiseVariance),
        formatVolatility: Object.fromEntries(
          [...calibration.formatVariances].map(([format, variance]) => [
            format,
            Math.sqrt(variance),
          ])
        ),
      },
      weeks,
    };
  }

  function runAllSeasonForecasts(store, options = {}) {
    if (!store?.seasons?.length) return {};
    return Object.fromEntries(
      store.seasons.map((season) => [
        season.id,
        runSeasonForecasts(store, season.id, options),
      ])
    );
  }

  function forecastWeek({ season, schedule, cutoff, calibration, simulations, seed }) {
    const teams = season.teams || [];
    const currentTotals = cumulativeTotals(season, cutoff);
    const completedRounds = season.rounds.slice(0, cutoff);
    const remainingRounds = schedule.slice(cutoff);
    const leaderTotal = Math.min(...currentTotals);
    const orderedTotals = [...currentTotals].sort((a, b) => a - b);
    const podiumLine = orderedTotals[Math.min(2, orderedTotals.length - 1)];
    const lastTotal = Math.max(...currentTotals);
    const posterior = teamPosteriors(season, cutoff, calibration);
    const resultShares = teams.map(() => ({ championship: 0, podium: 0, dfl: 0 }));

    if (!remainingRounds.length) {
      allocateFinishShares(currentTotals, resultShares);
    } else {
      const random = mulberry32(hashString(seed));
      const normal = normalSampler(random);
      const futureTotals = new Array(teams.length);
      const strengths = new Array(teams.length);

      for (let simulation = 0; simulation < simulations; simulation += 1) {
        let strengthMean = 0;
        for (let teamIndex = 0; teamIndex < teams.length; teamIndex += 1) {
          const estimate = posterior[teamIndex];
          const strength =
            estimate.mean + Math.sqrt(estimate.variance) * normal();
          strengths[teamIndex] = strength;
          strengthMean += strength;
          futureTotals[teamIndex] = currentTotals[teamIndex];
        }
        strengthMean /= teams.length;

        for (const round of remainingRounds) {
          const pool = calibration.formatPools.get(round.format) || calibration.noisePool;
          for (let teamIndex = 0; teamIndex < teams.length; teamIndex += 1) {
            const noise = pool[Math.floor(random() * pool.length)];
            const relativeScore = strengths[teamIndex] - strengthMean + noise;
            futureTotals[teamIndex] += Math.round(relativeScore);
          }
        }

        allocateFinishShares(futureTotals, resultShares);
      }
    }

    const denominator = remainingRounds.length ? simulations : 1;
    const week = completedRounds.at(-1)?.week ?? cutoff;
    return {
      week,
      cutoff,
      weeksRemaining: remainingRounds.length,
      projectedRounds: remainingRounds.map((round) => ({
        week: round.week,
        format: round.format,
        projected: Boolean(round.projected),
      })),
      teams: teams.map((team, teamIndex) => ({
        id: team.id,
        name: team.name,
        place: competitionPlace(currentTotals, teamIndex),
        total: currentTotals[teamIndex],
        shotsBack: currentTotals[teamIndex] - leaderTotal,
        shotsFromPodium: currentTotals[teamIndex] - podiumLine,
        shotsFromLast: lastTotal - currentTotals[teamIndex],
        form: posterior[teamIndex].mean,
        championship: (resultShares[teamIndex].championship / denominator) * 100,
        podium: (resultShares[teamIndex].podium / denominator) * 100,
        dfl: (resultShares[teamIndex].dfl / denominator) * 100,
      })),
    };
  }

  function projectedSchedule(store, season) {
    const recorded = (season.rounds || []).map((round) => ({ ...round, projected: false }));
    const sameLeague = (store.seasons || [])
      .filter((item) => item.league === season.league)
      .sort((a, b) => b.year - a.year);
    const newestYear = Math.max(...sameLeague.map((item) => item.year));
    if (season.year !== newestYear) return recorded;

    const priorSeasons = sameLeague.filter((item) => item.id !== season.id).slice(0, 3);
    const typicalLength = mode(priorSeasons.map((item) => item.rounds?.length || 0));
    const projectedLength = Math.max(recorded.length, typicalLength);
    if (projectedLength <= recorded.length) return recorded;

    const reference =
      priorSeasons.find((item) => (item.rounds?.length || 0) >= projectedLength) ||
      priorSeasons[0];
    const schedule = [...recorded];
    for (let index = recorded.length; index < projectedLength; index += 1) {
      const referenceRound = reference?.rounds?.[index];
      schedule.push({
        week: referenceRound?.week ?? index + 1,
        format: referenceRound?.format || "League round",
        shortName: referenceRound?.shortName || `W${index + 1}`,
        projected: true,
      });
    }
    return schedule;
  }

  function buildCalibration(store, targetSeason) {
    let trainingSeasons = (store.seasons || []).filter(
      (season) => season.id !== targetSeason.id && season.league === targetSeason.league
    );
    if (!trainingSeasons.length) {
      trainingSeasons = (store.seasons || []).filter((season) => season.id !== targetSeason.id);
    }

    const groups = [];
    let trainingRoundCount = 0;

    for (const season of trainingSeasons) {
      const teamObservations = (season.teams || []).map(() => []);
      for (let roundIndex = 0; roundIndex < (season.rounds || []).length; roundIndex += 1) {
        const values = season.teams
          .map((team) => numeric(team.rounds?.[roundIndex]?.net))
          .filter((value) => value != null);
        if (values.length < 2) continue;
        trainingRoundCount += 1;
        const fieldMean = mean(values);
        season.teams.forEach((team, teamIndex) => {
          const score = numeric(team.rounds?.[roundIndex]?.net);
          if (score == null) return;
          teamObservations[teamIndex].push({
            format: season.rounds[roundIndex].format || "League round",
            residual: score - fieldMean,
          });
        });
      }

      for (const observations of teamObservations) {
        if (observations.length) groups.push(observations);
      }
    }

    const allResiduals = groups.flatMap((group) => group.map((item) => item.residual));
    const fallbackVariance = Math.max(MIN_VARIANCE, sampleVariance(allResiduals));
    const effects = randomEffectsVariance(groups, fallbackVariance);
    const noisePool = [];
    const pools = new Map();

    for (const group of groups) {
      const groupMean = mean(group.map((item) => item.residual));
      for (const observation of group) {
        const noise = observation.residual - groupMean;
        noisePool.push(noise);
        if (!pools.has(observation.format)) pools.set(observation.format, []);
        pools.get(observation.format).push(noise);
      }
    }

    if (!noisePool.length) noisePool.push(-8, -4, 0, 4, 8);
    centerInPlace(noisePool);

    const formatPools = new Map();
    const formatVariances = new Map();
    for (const [format, pool] of pools) {
      const selected = pool.length >= MIN_FORMAT_SAMPLE ? [...pool] : [...noisePool];
      centerInPlace(selected);
      formatPools.set(format, selected);
      formatVariances.set(format, Math.max(MIN_VARIANCE, sampleVariance(selected)));
    }

    return {
      trainingSeasonCount: trainingSeasons.length,
      trainingRoundCount,
      observationCount: allResiduals.length,
      teamVariance: Math.max(MIN_VARIANCE, effects.teamVariance),
      noiseVariance: Math.max(MIN_VARIANCE, sampleVariance(noisePool)),
      noisePool,
      formatPools,
      formatVariances,
    };
  }

  function teamPosteriors(season, cutoff, calibration) {
    const observations = (season.teams || []).map(() => []);

    for (let roundIndex = 0; roundIndex < cutoff; roundIndex += 1) {
      const scores = season.teams
        .map((team) => numeric(team.rounds?.[roundIndex]?.net))
        .filter((value) => value != null);
      if (scores.length < 2) continue;
      const fieldMean = mean(scores);
      season.teams.forEach((team, teamIndex) => {
        const score = numeric(team.rounds?.[roundIndex]?.net);
        if (score == null) return;
        const format = season.rounds[roundIndex]?.format || "League round";
        const variance =
          calibration.formatVariances.get(format) || calibration.noiseVariance;
        observations[teamIndex].push({ residual: score - fieldMean, variance });
      });
    }

    const priorPrecision = 1 / calibration.teamVariance;
    const estimates = observations.map((teamObservations) => {
      let precision = priorPrecision;
      let weightedResidual = 0;
      for (const observation of teamObservations) {
        const observationPrecision = 1 / observation.variance;
        precision += observationPrecision;
        weightedResidual += observation.residual * observationPrecision;
      }
      return {
        mean: weightedResidual / precision,
        variance: 1 / precision,
      };
    });

    const posteriorMean = mean(estimates.map((estimate) => estimate.mean));
    estimates.forEach((estimate) => {
      estimate.mean -= posteriorMean;
    });
    return estimates;
  }

  function cumulativeTotals(season, cutoff) {
    return season.teams.map((team) => {
      let total = 0;
      for (let roundIndex = 0; roundIndex < cutoff; roundIndex += 1) {
        const score = numeric(team.rounds?.[roundIndex]?.net);
        if (score == null) {
          throw new Error(
            `Missing team score for ${team.name}, week ${season.rounds[roundIndex]?.week}`
          );
        }
        total += score;
      }
      return total;
    });
  }

  function allocateFinishShares(totals, shares) {
    const groups = new Map();
    totals.forEach((total, teamIndex) => {
      if (!groups.has(total)) groups.set(total, []);
      groups.get(total).push(teamIndex);
    });
    const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    let position = 0;

    ordered.forEach(([, teamIndexes], groupIndex) => {
      const groupSize = teamIndexes.length;
      if (groupIndex === 0) {
        const championshipShare = 1 / groupSize;
        teamIndexes.forEach((teamIndex) => {
          shares[teamIndex].championship += championshipShare;
        });
      }

      const podiumSlots = Math.max(0, Math.min(groupSize, 3 - position));
      if (podiumSlots > 0) {
        const podiumShare = podiumSlots / groupSize;
        teamIndexes.forEach((teamIndex) => {
          shares[teamIndex].podium += podiumShare;
        });
      }

      if (groupIndex === ordered.length - 1) {
        const dflShare = 1 / groupSize;
        teamIndexes.forEach((teamIndex) => {
          shares[teamIndex].dfl += dflShare;
        });
      }
      position += groupSize;
    });
  }

  function randomEffectsVariance(groups, fallbackVariance) {
    const usable = groups.filter((group) => group.length > 1);
    const observationCount = usable.reduce((sum, group) => sum + group.length, 0);
    if (usable.length < 2 || observationCount <= usable.length) {
      return { teamVariance: fallbackVariance * 0.25, noiseVariance: fallbackVariance };
    }

    const groupMeans = usable.map((group) => mean(group.map((item) => item.residual)));
    const overallMean =
      usable.reduce((sum, group, index) => sum + group.length * groupMeans[index], 0) /
      observationCount;
    const withinSum = usable.reduce(
      (sum, group, index) =>
        sum +
        group.reduce(
          (groupSum, item) => groupSum + (item.residual - groupMeans[index]) ** 2,
          0
        ),
      0
    );
    const betweenSum = usable.reduce(
      (sum, group, index) =>
        sum + group.length * (groupMeans[index] - overallMean) ** 2,
      0
    );
    const meanWithin = withinSum / (observationCount - usable.length);
    const meanBetween = betweenSum / (usable.length - 1);
    const squaredSizes = usable.reduce((sum, group) => sum + group.length ** 2, 0);
    const effectiveSize =
      (observationCount - squaredSizes / observationCount) / (usable.length - 1);
    return {
      teamVariance: Math.max(0, (meanBetween - meanWithin) / effectiveSize),
      noiseVariance: meanWithin,
    };
  }

  function competitionPlace(totals, teamIndex) {
    return 1 + totals.filter((total) => total < totals[teamIndex]).length;
  }

  function completedRoundCount(season) {
    let completed = 0;
    (season.rounds || []).forEach((_, roundIndex) => {
      const scoreCount = season.teams.filter(
        (team) => numeric(team.rounds?.[roundIndex]?.net) != null
      ).length;
      if (scoreCount >= Math.max(2, Math.ceil(season.teams.length / 2))) {
        completed = roundIndex + 1;
      }
    });
    return completed;
  }

  function mode(values) {
    const counts = new Map();
    let selected = 0;
    let selectedCount = 0;
    for (const value of values) {
      if (!value) continue;
      const count = (counts.get(value) || 0) + 1;
      counts.set(value, count);
      if (count > selectedCount) {
        selected = value;
        selectedCount = count;
      }
    }
    return selected;
  }

  function centerInPlace(values) {
    const center = mean(values);
    for (let index = 0; index < values.length; index += 1) {
      values[index] -= center;
    }
  }

  function mean(values) {
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  }

  function sampleVariance(values) {
    if (values.length < 2) return MIN_VARIANCE;
    const center = mean(values);
    return (
      values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      (values.length - 1)
    );
  }

  function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function normalizeSimulationCount(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_SIMULATIONS;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    return function () {
      let value = (seed += 0x6d2b79f5);
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function normalSampler(random) {
    let spare = null;
    return function () {
      if (spare != null) {
        const value = spare;
        spare = null;
        return value;
      }
      let first = 0;
      let second = 0;
      while (first === 0) first = random();
      while (second === 0) second = random();
      const magnitude = Math.sqrt(-2 * Math.log(first));
      spare = magnitude * Math.sin(2 * Math.PI * second);
      return magnitude * Math.cos(2 * Math.PI * second);
    };
  }

  return {
    DEFAULT_SIMULATIONS,
    runSeasonForecasts,
    runAllSeasonForecasts,
  };
});
