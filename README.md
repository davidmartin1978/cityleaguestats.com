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
2. Generate the JSON store:

   ```powershell
   python scripts/parse_emails.py
   ```

3. Regenerate the static player profile pages:

   ```powershell
   python scripts/generate_player_pages.py
   ```

4. Review the validation summary and commit `data/seasons.json` and `players/`.

For each season, the importer keeps the newest email with the largest week count as the season-to-date standings and merges the handicap listed in every available weekly email into each player's `handicapHistory`. The season's `handicapWeeks` array records the source email for each snapshot. Team scores are treated as net. Player scores are treated as gross, and the website subtracts the handicap reported for that week. When a weekly snapshot is missing, the most recent earlier handicap carries forward; a player with no earlier cap has no calculated net for that round.

The importer also creates a `playerProfiles` index. A profile follows the same player name on the same team across seasons, which is the safest available identity in the source emails. A name on a different team remains a separate profile because the emails do not provide a unique league-wide player ID. The generator turns that index into shareable pages under `players/`; edit `templates/player-page.html`, `css/player.css`, or `js/player.js`, then rerun the generator when the roster changes.

## Files

- `index.html` — semantic page structure and controls
- `css/styles.css` — responsive layout and visual system
- `css/player.css` — player reference page layout
- `js/app.js` — filtering, derived statistics, and D3 charts
- `js/player.js` — career summaries, game logs, and player charts
- `data/seasons.json` — static browser data store
- `scripts/parse_emails.py` — offline `.eml` table importer
- `scripts/generate_player_pages.py` — static player page generator
- `templates/player-page.html` — generated profile page template
- `players/` — generated, shareable player pages

No server-side code or build step is required for the website.
