# AGENTS.md

## Purpose
This is a fun website that uses client-side scripts, JSON data stores, and D3.js to allow users to visualize stats from a golf league. Users of the site should be able to view stats by season, teams, and players. The data source for the site comes from the emails folder. Currently the manager of the league manually tabulates the scores, as submitted on physical cards, and then sends and email with results. This site aims to aggregate stats to make it interesting and easy to visualize.

## General Agent Rules
Any interactivity with this site must be client-side only. The site will be hosted on GitHub pages, which allows only static content. When scraping emails for updated stats and scores, you must create JSON objects that can be stored in the repo and used on the client side. No server side execution allowed.