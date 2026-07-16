#!/usr/bin/env python3
"""Build the static CityLeagueStats JSON store from commissioner emails.

The website never runs this file. It is an offline import helper: add .eml files to
emails/, run this script, and commit the regenerated data/seasons.json file.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Iterable


FORMAT_NAMES = {
    "stbl": "Stableford",
    "2 nets": "Two Nets",
    "4bb": "Four Ball",
    "2bb": "Two Best Balls",
    "mod": "Modified",
    "mat": "Match Play",
    "4 cl": "Four Clubs",
}


@dataclass
class ParsedEmail:
    season: dict[str, Any]
    source_date: datetime


def slugify(value: str) -> str:
    value = value.casefold().replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "item"


def as_number(value: str) -> int | None:
    match = re.search(r"\d+", value)
    return int(match.group()) if match else None


def split_row(line: str, width: int) -> list[str]:
    cells = [cell.strip() for cell in line.split("\t")]
    if len(cells) < width:
        cells.extend([""] * (width - len(cells)))
    return cells[:width]


def locate_table(lines: list[str]) -> tuple[int, list[str]]:
    for index, line in enumerate(lines):
        cells = [cell.strip() for cell in line.split("\t")]
        labels = {cell.upper() for cell in cells}
        if {"HDCP", "TOTAL", "PLACE"}.issubset(labels):
            return index, cells
    raise ValueError("No tab-separated standings table was found")


def extract_course(subject: str) -> str:
    match = re.search(
        r"CityLeague\s+Golf\s+\d{4}\s+(.+?)\s+CityLeague\s+Week",
        subject,
        re.IGNORECASE,
    )
    if match:
        return re.sub(r"\s+", " ", match.group(1)).strip()
    return "City League"


def parse_round(raw: str, week: int) -> dict[str, Any]:
    gross = as_number(raw)
    markers = re.findall(r"[a-z]+", raw.casefold())
    return {
        "week": week,
        "gross": gross,
        "raw": raw or None,
        "markers": markers,
    }


def unique_id(base: str, seen: dict[str, int]) -> str:
    count = seen.get(base, 0) + 1
    seen[base] = count
    return base if count == 1 else f"{base}-{count}"


def parse_email(path: Path) -> ParsedEmail:
    with path.open("rb") as source:
        message = BytesParser(policy=policy.default).parse(source)

    subject = str(message.get("subject", path.stem))
    try:
        source_date = parsedate_to_datetime(str(message.get("date")))
    except (TypeError, ValueError):
        source_date = datetime.fromtimestamp(path.stat().st_mtime)

    body = message.get_body(preferencelist=("plain",))
    if body is None:
        raise ValueError("Email has no text/plain body")

    lines = body.get_content().splitlines()
    header_index, header = locate_table(lines)
    width = len(header)
    handicap_index = next(i for i, value in enumerate(header) if value.upper() == "HDCP")
    total_index = next(i for i, value in enumerate(header) if value.upper() == "TOTAL")
    place_index = next(i for i, value in enumerate(header) if value.upper() == "PLACE")
    round_labels = header[1:handicap_index]

    rounds = [
        {
            "id": f"week-{week}",
            "week": week,
            "shortName": label,
            "format": FORMAT_NAMES.get(label.casefold(), label),
        }
        for week, label in enumerate(round_labels, start=1)
    ]

    teams: list[dict[str, Any]] = []
    current_team: dict[str, Any] | None = None
    team_ids: dict[str, int] = {}
    player_ids: dict[str, int] = {}

    for line in lines[header_index + 1 :]:
        if "\t" not in line:
            if teams and line.strip():
                break
            continue

        cells = split_row(line, width)
        name = cells[0].strip()
        if not name:
            continue

        source_total = as_number(cells[total_index])
        source_place = cells[place_index].strip()
        is_team = source_total is not None and bool(source_place)

        if is_team:
            base_id = slugify(name)
            team_id = unique_id(base_id, team_ids)
            team_scores = [as_number(cells[i]) for i in range(1, handicap_index)]
            current_team = {
                "id": team_id,
                "name": name,
                "place": source_place,
                "total": source_total,
                "rounds": [
                    {"week": week, "net": score}
                    for week, score in enumerate(team_scores, start=1)
                ],
                "players": [],
            }
            teams.append(current_team)
            continue

        if current_team is None:
            continue

        player_base = f"{current_team['id']}-{slugify(name)}"
        player_id = unique_id(player_base, player_ids)
        current_team["players"].append(
            {
                "id": player_id,
                "name": name,
                "handicap": as_number(cells[handicap_index]),
                "rounds": [
                    parse_round(cells[column], week)
                    for week, column in enumerate(range(1, handicap_index), start=1)
                ],
            }
        )

    if not teams:
        raise ValueError("Standings table did not contain any teams")

    warnings: list[str] = []
    for team in teams:
        computed_total = sum(
            item["net"] for item in team["rounds"] if item["net"] is not None
        )
        if computed_total != team["total"]:
            warnings.append(
                f"{team['name']}: weekly total {computed_total} does not match "
                f"source total {team['total']}"
            )

    course = extract_course(subject)
    year = source_date.year
    season_id = f"{year}-{slugify(course)}"
    scored_players = sum(
        1
        for team in teams
        for player in team["players"]
        if any(item["gross"] is not None for item in player["rounds"])
    )
    numeric_rounds = sum(
        1
        for team in teams
        for player in team["players"]
        for item in player["rounds"]
        if item["gross"] is not None
    )

    season = {
        "id": season_id,
        "name": f"{course} · {year}",
        "year": year,
        "league": course,
        "asOf": source_date.date().isoformat(),
        "source": {"file": path.name, "subject": subject},
        "rounds": rounds,
        "teams": teams,
        "validation": {
            "teamCount": len(teams),
            "rosterCount": sum(len(team["players"]) for team in teams),
            "playersUsed": scored_players,
            "playerRounds": numeric_rounds,
            "warnings": warnings,
        },
    }
    return ParsedEmail(season=season, source_date=source_date)


def discover_emails(folder: Path) -> Iterable[Path]:
    return sorted(path for path in folder.glob("*.eml") if path.is_file())


def build_store(email_folder: Path) -> dict[str, Any]:
    latest: dict[str, ParsedEmail] = {}
    failures: list[str] = []

    for path in discover_emails(email_folder):
        try:
            parsed = parse_email(path)
        except (OSError, UnicodeError, ValueError) as error:
            failures.append(f"{path.name}: {error}")
            continue

        season_id = parsed.season["id"]
        current = latest.get(season_id)
        parsed_key = (len(parsed.season["rounds"]), parsed.source_date)
        current_key = (
            (len(current.season["rounds"]), current.source_date)
            if current
            else (-1, datetime.min)
        )
        if parsed_key > current_key:
            latest[season_id] = parsed

    if not latest:
        details = "; ".join(failures) or "No .eml files found"
        raise ValueError(f"No usable season tables found. {details}")

    seasons = [item.season for item in latest.values()]
    seasons.sort(key=lambda season: (season["year"], season["league"]), reverse=True)
    return {
        "schemaVersion": 1,
        "generatedFrom": "emails/*.eml",
        "seasons": seasons,
        "importWarnings": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emails", type=Path, default=Path("emails"))
    parser.add_argument("--output", type=Path, default=Path("data/seasons.json"))
    args = parser.parse_args()

    try:
        store = build_store(args.emails)
    except ValueError as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(store, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    for season in store["seasons"]:
        validation = season["validation"]
        print(
            f"{season['name']}: {validation['teamCount']} teams, "
            f"{validation['playersUsed']} players used, "
            f"{validation['playerRounds']} player rounds"
        )
        for warning in validation["warnings"]:
            print(f"  warning: {warning}")
    for warning in store["importWarnings"]:
        print(f"Skipped {warning}")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
