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

3. Review the validation summary and commit the updated `data/seasons.json`.

For each season, the importer keeps the newest email with the largest week count because the commissioner table is season-to-date. Team scores are treated as net. Player scores are treated as gross, and the website subtracts each player's current listed handicap to calculate net scores for all weeks.

## Files

- `index.html` — semantic page structure and controls
- `css/styles.css` — responsive layout and visual system
- `js/app.js` — filtering, derived statistics, and D3 charts
- `data/seasons.json` — static browser data store
- `scripts/parse_emails.py` — offline `.eml` table importer

No server-side code or build step is required for the website.
