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
    "alt": "Alternate Shot",
    "pinky": "Pinky",
}


@dataclass
class ParsedEmail:
    season: dict[str, Any]
    source_date: datetime
    result_week: int


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
        if {"HDCP", "TOTAL"}.issubset(labels):
            return index, cells
    raise ValueError("No tab-separated standings table was found")


def extract_course(subject: str, path: Path) -> str:
    filename_match = re.match(
        r"\d{4}[_ -]+(.+?)[_ -]+week[_ -]+\d+",
        path.stem,
        re.IGNORECASE,
    )
    if filename_match:
        return re.sub(r"[_ -]+", " ", filename_match.group(1)).strip().title()

    match = re.search(
        r"CityLeague\s+Golf\s+\d{4}\s+(.+?)\s+CityLeague\s+Week",
        subject,
        re.IGNORECASE,
    )
    if match:
        return re.sub(r"\s+", " ", match.group(1)).strip()
    return "City League"


def extract_result_week(subject: str, path: Path) -> int:
    for value in (subject, path.stem.replace("_", " ")):
        match = re.search(r"\bweek\s*[- ]?\s*(\d{1,2})\b", value, re.IGNORECASE)
        if match:
            return int(match.group(1))
    raise ValueError("Could not determine the result week from the subject or filename")


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

    filename_week = extract_result_week(subject, path)
    lines = body.get_content().splitlines()
    header_index, header = locate_table(lines)
    width = len(header)
    handicap_index = next(i for i, value in enumerate(header) if value.upper() == "HDCP")
    total_index = next(i for i, value in enumerate(header) if value.upper() == "TOTAL")
    place_index = next(
        (i for i, value in enumerate(header) if value.upper() == "PLACE"),
        None,
    )
    completed_columns = [
        column
        for line in lines[header_index + 1 :]
        if "\t" in line
        for cells in [split_row(line, width)]
        if as_number(cells[total_index]) is not None
        for column in range(1, handicap_index)
        if as_number(cells[column]) is not None
    ]
    result_week = max(
        completed_columns,
        default=min(filename_week, max(1, handicap_index - 1)),
    )
    round_labels = header[1:handicap_index][:result_week]
    round_columns = range(1, 1 + len(round_labels))

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
        source_place = cells[place_index].strip() if place_index is not None else ""
        is_team = source_total is not None and (
            place_index is None or bool(source_place)
        )

        if is_team:
            base_id = slugify(name)
            team_id = unique_id(base_id, team_ids)
            team_scores = [as_number(cells[i]) for i in round_columns]
            current_team = {
                "id": team_id,
                "name": name,
                "place": source_place or str(len(teams) + 1),
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
                    for week, column in enumerate(round_columns, start=1)
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

    course = extract_course(subject, path)
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
        "source": {"file": path.name, "subject": subject, "resultWeek": result_week},
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
    return ParsedEmail(season=season, source_date=source_date, result_week=result_week)


def discover_emails(folder: Path) -> Iterable[Path]:
    return sorted(path for path in folder.glob("*.eml") if path.is_file())


def names_are_aliases(left: str, right: str) -> bool:
    left_parts = re.findall(r"[a-z0-9]+", left.casefold())
    right_parts = re.findall(r"[a-z0-9]+", right.casefold())
    if not left_parts or not right_parts:
        return False
    shorter, longer = sorted((left_parts, right_parts), key=len)
    return len(shorter) == 1 and longer[0] == shorter[0]


def match_historical_player(
    current_team: dict[str, Any], historical_player: dict[str, Any]
) -> dict[str, Any] | None:
    exact = next(
        (
            player
            for player in current_team["players"]
            if player["id"] == historical_player["id"]
        ),
        None,
    )
    if exact:
        return exact

    name_candidates = [
        player
        for player in current_team["players"]
        if player["name"].casefold() == historical_player["name"].casefold()
    ]
    if len(name_candidates) == 1:
        return name_candidates[0]
    cap_matches = [
        player
        for player in name_candidates
        if player["handicap"] == historical_player["handicap"]
    ]
    if len(cap_matches) == 1:
        return cap_matches[0]

    alias_candidates = [
        player
        for player in current_team["players"]
        if names_are_aliases(player["name"], historical_player["name"])
        and player["handicap"] == historical_player["handicap"]
    ]
    return alias_candidates[0] if len(alias_candidates) == 1 else None


def match_historical_team(
    current_teams: dict[str, dict[str, Any]], historical_team: dict[str, Any]
) -> dict[str, Any] | None:
    exact = current_teams.get(historical_team["id"])
    if exact:
        return exact

    historical_roster = {
        slugify(player["name"]) for player in historical_team["players"]
    }
    candidates: list[tuple[float, dict[str, Any]]] = []
    for current_team in current_teams.values():
        current_roster = {
            slugify(player["name"]) for player in current_team["players"]
        }
        union = historical_roster | current_roster
        score = len(historical_roster & current_roster) / len(union) if union else 0
        candidates.append((score, current_team))
    candidates.sort(key=lambda item: item[0], reverse=True)
    if not candidates or candidates[0][0] < 0.7:
        return None
    if len(candidates) > 1 and candidates[0][0] == candidates[1][0]:
        return None
    return candidates[0][1]


def attach_handicap_histories(
    season: dict[str, Any], snapshots: list[ParsedEmail]
) -> None:
    current_teams = {team["id"]: team for team in season["teams"]}
    histories: dict[str, dict[int, int | None]] = {
        player["id"]: {}
        for team in season["teams"]
        for player in team["players"]
    }
    sources_by_week: dict[int, dict[str, Any]] = {}
    warnings: list[str] = []

    for snapshot in sorted(snapshots, key=lambda item: (item.result_week, item.source_date)):
        sources_by_week[snapshot.result_week] = {
            "week": snapshot.result_week,
            "asOf": snapshot.source_date.date().isoformat(),
            "file": snapshot.season["source"]["file"],
        }
        for historical_team in snapshot.season["teams"]:
            current_team = match_historical_team(current_teams, historical_team)
            if current_team is None:
                warnings.append(
                    f"Week {snapshot.result_week}: no current team match for "
                    f"{historical_team['name']}"
                )
                continue
            for historical_player in historical_team["players"]:
                current_player = match_historical_player(current_team, historical_player)
                if current_player is None:
                    warnings.append(
                        f"Week {snapshot.result_week}: no current player match for "
                        f"{historical_player['name']} ({historical_team['name']})"
                    )
                    continue
                histories[current_player["id"]][snapshot.result_week] = historical_player[
                    "handicap"
                ]

    history_count = 0
    players_with_history = 0
    for team in season["teams"]:
        for player in team["players"]:
            player["handicapHistory"] = [
                {"week": week, "handicap": handicap}
                for week, handicap in sorted(histories[player["id"]].items())
            ]
            history_count += len(player["handicapHistory"])
            if player["handicapHistory"]:
                players_with_history += 1

    season["handicapWeeks"] = [sources_by_week[week] for week in sorted(sources_by_week)]
    season["validation"]["handicapSnapshots"] = history_count
    season["validation"]["playersWithHandicapHistory"] = players_with_history
    season["validation"]["handicapHistoryWarnings"] = warnings


def build_player_profiles(seasons: list[dict[str, Any]]) -> list[dict[str, Any]]:
    profiles: dict[str, dict[str, Any]] = {}
    for season in seasons:
        for team in season["teams"]:
            for player in team["players"]:
                profile_id = player["id"]
                player["profileId"] = profile_id
                profile = profiles.setdefault(
                    profile_id,
                    {
                        "id": profile_id,
                        "name": player["name"],
                        "latestTeam": team["name"],
                        "appearances": [],
                    },
                )
                profile["appearances"].append(
                    {
                        "seasonId": season["id"],
                        "year": season["year"],
                        "league": season["league"],
                        "teamId": team["id"],
                        "teamName": team["name"],
                        "playerId": player["id"],
                    }
                )
    return sorted(
        profiles.values(),
        key=lambda profile: (profile["name"].casefold(), profile["id"]),
    )


def build_store(email_folder: Path) -> dict[str, Any]:
    latest: dict[str, ParsedEmail] = {}
    snapshots: dict[str, list[ParsedEmail]] = {}
    failures: list[str] = []

    for path in discover_emails(email_folder):
        try:
            parsed = parse_email(path)
        except (OSError, UnicodeError, ValueError) as error:
            failures.append(f"{path.name}: {error}")
            continue

        season_id = parsed.season["id"]
        snapshots.setdefault(season_id, []).append(parsed)
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

    seasons = []
    for season_id, item in latest.items():
        attach_handicap_histories(item.season, snapshots[season_id])
        seasons.append(item.season)
    seasons.sort(key=lambda season: (season["year"], season["league"]), reverse=True)
    player_profiles = build_player_profiles(seasons)
    return {
        "schemaVersion": 3,
        "generatedFrom": "emails/*.eml",
        "seasons": seasons,
        "playerProfiles": player_profiles,
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
            f"{validation['playerRounds']} player rounds, "
            f"{validation['handicapSnapshots']} cap snapshots from "
            f"{len(season['handicapWeeks'])} result weeks"
        )
        for warning in validation["warnings"]:
            print(f"  warning: {warning}")
        for warning in validation["handicapHistoryWarnings"]:
            print(f"  warning: {warning}")
    for warning in store["importWarnings"]:
        print(f"Skipped {warning}")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
