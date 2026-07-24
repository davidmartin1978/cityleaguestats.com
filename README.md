# CityLeagueStats.com

A framework-free, client-side dashboard for City League golf standings and player statistics. The browser reads static JSON from `data/seasons.json` and renders the tables and charts with D3.js.

## View the site locally

Browsers block JSON requests from `file://` pages, so serve the folder locally:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000`. The deployed site needs only the repository's static files and works on GitHub Pages.

## Refresh data from emails

1. Add commissioner `.eml` files to `emails/`.
2. If a team changed names, add its names to `data/team-name-history.json`, newest
   first. The site displays that history with slashes, such as
   `What's a Foursome? / ZJ's`.
3. Generate the JSON store:

   ```powershell
   python scripts/parse_emails.py
   ```

4. Regenerate the static player profile pages:

   ```powershell
   python scripts/generate_player_pages.py
   ```

5. Review the validation summary and commit `data/seasons.json` and `players/`.

For each season, the importer uses the highest-week email as the authoritative standings and individual-score table. Earlier emails never overwrite those scores; they supply commissioner handicaps and score-consistency checks only. The importer accepts HTML tables, tab-delimited plain text, quoted replies, and common Apple Mail wrapping differences. The season's `handicapWeeks` array records each usable snapshot. When a weekly snapshot or player cap is missing, the most recent earlier handicap carries forward; a player with no earlier cap has no calculated net for that round.

Team scores are treated as net. Numeric player scores are treated as gross, and the website subtracts the handicap reported or carried into that week. An `X` means the golfer played but omitted an individual score: it counts toward rounds played and players used, but is excluded from gross, net, distribution, ranking, and other scorable-round statistics.

The separate `format-analytics.html` page derives team-net benchmarks directly in the browser. For each format, it presents the best-quartile cutoff as a good day, the median as typical, and the worst-quartile cutoff as a setback. No server-side data processing is required on GitHub Pages.

The standings page also runs a deterministic Monte Carlo forecast after every completed
week. `js/predictions.js` converts each team score to a field-relative result, estimates
format-specific weekly volatility and persistent team strength from the other seasons,
and simulates the remaining schedule. It reports championship, podium, and last-place
probabilities, splitting probability evenly when simulated teams tie. For the newest
in-progress season, any unrecorded finale is projected from the modal schedule length
and round format in the three most recent seasons. Run `node --test
tests/predictions.test.js` to verify probability totals, seeded stability, schedule
projection, and final-standings resolution.

The importer also creates a `playerProfiles` index. A profile follows the same player name on the same team identity across seasons, including team names connected in `data/team-name-history.json`. A name on an unrelated team remains a separate profile because the emails do not provide a unique league-wide player ID. The generator turns that index into shareable pages under `players/` and keeps redirect pages for profile URLs based on prior team names. Edit `templates/player-page.html`, `css/player.css`, or `js/player.js`, then rerun the generator when the roster changes.

## Files

- `index.html` — season standings and weekly movement
- `player-stats.html` — venue-and-season player details and stats
- `handicap-analysis.html` — Sandbag Rankings handicap analysis
- `format-analytics.html` — cross-season format score targets
- `css/styles.css` — responsive layout and visual system
- `css/formats.css` — format analytics page styles
- `css/player.css` — player reference page layout
- `js/app.js` — filtering, derived statistics, and D3 charts
- `js/predictions.js` — weekly championship, podium, and DFL probability model
- `js/formats.js` — client-side format benchmarks and range charts
- `js/navigation.js` — shared responsive navigation behavior
- `js/player.js` — career summaries, game logs, and player charts
- `data/seasons.json` — static browser data store
- `data/team-name-history.json` — small newest-to-oldest registry of team renames
- `scripts/parse_emails.py` — offline `.eml` table importer
- `scripts/generate_player_pages.py` — static player page generator
- `templates/player-page.html` — generated profile page template
- `players/` — generated, shareable player pages

No server-side code or build step is required for the website.
