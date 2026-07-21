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
from email.message import Message
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
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


class HTMLTableExtractor(HTMLParser):
    """Collect visible cell text from every top-level HTML table."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table_depth = 0
        self._rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        del attrs
        tag = tag.casefold()
        if tag == "table":
            if self._table_depth == 0:
                self._rows = []
            self._table_depth += 1
            return
        if self._table_depth != 1:
            return
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell_parts = []
        elif tag == "br" and self._cell_parts is not None:
            self._cell_parts.append(" ")

    def handle_data(self, data: str) -> None:
        if self._table_depth == 1 and self._cell_parts is not None:
            self._cell_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if self._table_depth == 1 and tag in {"td", "th"}:
            if self._row is not None and self._cell_parts is not None:
                self._row.append(clean_cell("".join(self._cell_parts)))
            self._cell_parts = None
        elif self._table_depth == 1 and tag == "tr":
            if self._row and any(self._row):
                self._rows.append(self._row)
            self._row = None
        if tag == "table" and self._table_depth:
            self._table_depth -= 1
            if self._table_depth == 0 and self._rows:
                self.tables.append(self._rows)
                self._rows = []


def slugify(value: str) -> str:
    value = value.casefold().replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "item"


def as_number(value: str) -> int | None:
    match = re.search(r"\d+", value)
    return int(match.group()) if match else None


def clean_cell(value: str) -> str:
    value = value.replace("\xa0", " ")
    value = re.sub(r"^\s*(?:>\s*)+", "", value)
    return re.sub(r"\s+", " ", value).strip()


def header_key(value: str) -> str:
    return re.sub(r"[^A-Z]", "", clean_cell(value).upper())


def split_row(cells: list[str], width: int) -> list[str]:
    cells = [clean_cell(cell) for cell in cells]
    if len(cells) < width:
        cells.extend([""] * (width - len(cells)))
    return cells[:width]


def is_standings_header(row: list[str]) -> bool:
    labels = {header_key(cell) for cell in row}
    return {"HDCP", "TOTAL"}.issubset(labels)


def normalize_table(rows: list[list[str]]) -> list[list[str]]:
    header_index = next(
        (index for index, row in enumerate(rows) if is_standings_header(row)),
        None,
    )
    if header_index is None:
        raise ValueError("Table has no HDCP/TOTAL header")

    rows = [[clean_cell(cell) for cell in row] for row in rows[header_index:]]
    header = rows[0]
    maximum_width = max((len(row) for row in rows[1:]), default=len(header))
    first_label = header[0].casefold() if header else ""
    missing_name_header = first_label in FORMAT_NAMES or (
        bool(first_label) and maximum_width > len(header)
    )
    if missing_name_header:
        header.insert(0, "")

    width = len(header)
    return [split_row(row, width) for row in rows]


def extract_email_tables(message: Message) -> list[list[list[str]]]:
    """Extract score-table candidates from HTML and tab-delimited plain text."""

    candidates: list[list[list[str]]] = []
    for part in message.walk():
        if part.get_content_type() == "text/html":
            try:
                content = part.get_content()
            except (LookupError, UnicodeError):
                continue
            extractor = HTMLTableExtractor()
            extractor.feed(str(content))
            candidates.extend(extractor.tables)

    for part in message.walk():
        if part.get_content_type() != "text/plain":
            continue
        try:
            lines = str(part.get_content()).splitlines()
        except (LookupError, UnicodeError):
            continue
        for index, line in enumerate(lines):
            header = [clean_cell(cell) for cell in line.split("\t")]
            if "\t" not in line or not is_standings_header(header):
                continue
            rows = [header]
            for following in lines[index + 1 :]:
                if "\t" in following:
                    rows.append([clean_cell(cell) for cell in following.split("\t")])
                elif following.strip():
                    break
            candidates.append(rows)

    return candidates


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
    raw = clean_cell(raw)
    gross = as_number(raw)
    markers = re.findall(r"[a-z]+", raw.casefold())
    omitted = gross is None and bool(re.search(r"\bx\b", raw, re.IGNORECASE))
    return {
        "week": week,
        "gross": gross,
        "raw": raw or None,
        "markers": markers,
        "played": gross is not None or omitted,
        "omitted": omitted,
    }


def unique_id(base: str, seen: dict[str, int]) -> str:
    count = seen.get(base, 0) + 1
    seen[base] = count
    return base if count == 1 else f"{base}-{count}"


def parse_standings_table(
    source_rows: list[list[str]], result_week: int
) -> dict[str, Any]:
    rows = normalize_table(source_rows)
    header = rows[0]
    width = len(header)
    handicap_index = next(
        i for i, value in enumerate(header) if header_key(value) == "HDCP"
    )
    total_index = next(
        i for i, value in enumerate(header) if header_key(value) == "TOTAL"
    )
    place_index = next(
        (i for i, value in enumerate(header) if header_key(value) == "PLACE"),
        None,
    )
    round_count = min(result_week, max(0, handicap_index - 1))
    if round_count < 1:
        raise ValueError("Standings table has no round columns")

    round_labels = header[1 : 1 + round_count]
    round_columns = range(1, 1 + round_count)
    rounds = [
        {
            "id": f"week-{week}",
            "week": week,
            "shortName": label or f"W{week}",
            "format": FORMAT_NAMES.get(label.casefold(), label or f"Week {week}"),
        }
        for week, label in enumerate(round_labels, start=1)
    ]

    teams: list[dict[str, Any]] = []
    current_team: dict[str, Any] | None = None
    team_ids: dict[str, int] = {}
    player_ids: dict[str, int] = {}

    for source_row in rows[1:]:
        cells = split_row(source_row, width)
        name = cells[0]
        if not name or is_standings_header(cells):
            continue

        source_total = as_number(cells[total_index])
        source_place = cells[place_index] if place_index is not None else ""
        team_scores = [as_number(cells[index]) for index in round_columns]
        is_team = source_total is not None and (
            bool(source_place) or any(score is not None for score in team_scores)
        )

        if is_team:
            base_id = slugify(name)
            team_id = unique_id(base_id, team_ids)
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

    completed_rounds = sum(
        1
        for week in range(1, round_count + 1)
        if any(team["rounds"][week - 1]["net"] is not None for team in teams)
    )
    return {
        "rounds": rounds,
        "teams": teams,
        "warnings": warnings,
        "completedRounds": completed_rounds,
    }


def parse_email(path: Path) -> ParsedEmail:
    with path.open("rb") as source:
        message = BytesParser(policy=policy.default).parse(source)

    subject = str(message.get("subject", path.stem))
    try:
        source_date = parsedate_to_datetime(str(message.get("date")))
        if source_date is None:
            raise ValueError("No usable Date header")
    except (TypeError, ValueError):
        source_date = datetime.fromtimestamp(path.stat().st_mtime)

    result_week = extract_result_week(subject, path)
    parsed_tables: list[tuple[int, dict[str, Any]]] = []
    table_errors: list[str] = []
    for index, source_rows in enumerate(extract_email_tables(message)):
        if not any(is_standings_header(row) for row in source_rows):
            continue
        try:
            parsed_tables.append(
                (index, parse_standings_table(source_rows, result_week))
            )
        except (StopIteration, ValueError) as error:
            table_errors.append(str(error))

    if not parsed_tables:
        detail = f" ({'; '.join(table_errors)})" if table_errors else ""
        raise ValueError(f"No usable standings table was found{detail}")

    _, standings = max(
        parsed_tables,
        key=lambda item: (
            item[1]["completedRounds"],
            len(item[1]["teams"]),
            sum(len(team["players"]) for team in item[1]["teams"]),
            -item[0],
        ),
    )
    rounds = standings["rounds"]
    teams = standings["teams"]
    warnings = standings["warnings"]
    if len(rounds) < result_week:
        warnings.append(
            f"Result email is Week {result_week}, but its table exposes only "
            f"{len(rounds)} round columns"
        )

    course = extract_course(subject, path)
    filename_year = re.match(r"(20\d{2})", path.name)
    year = int(filename_year.group(1)) if filename_year else source_date.year
    season_id = f"{year}-{slugify(course)}"
    scored_players = sum(
        1
        for team in teams
        for player in team["players"]
        if any(item["gross"] is not None for item in player["rounds"])
    )
    players_used = sum(
        1
        for team in teams
        for player in team["players"]
        if any(item["played"] for item in player["rounds"])
    )
    scorable_rounds = sum(
        1
        for team in teams
        for player in team["players"]
        for item in player["rounds"]
        if item["gross"] is not None
    )
    played_rounds = sum(
        1
        for team in teams
        for player in team["players"]
        for item in player["rounds"]
        if item["played"]
    )
    omitted_rounds = played_rounds - scorable_rounds

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
            "playersUsed": players_used,
            "playersScored": scored_players,
            "playerRounds": played_rounds,
            "scorablePlayerRounds": scorable_rounds,
            "omittedScoreRounds": omitted_rounds,
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
    ]
    if len(alias_candidates) == 1:
        return alias_candidates[0]
    alias_cap_matches = [
        player
        for player in alias_candidates
        if player["handicap"] == historical_player["handicap"]
    ]
    return alias_cap_matches[0] if len(alias_cap_matches) == 1 else None


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
    histories: dict[str, dict[int, int]] = {
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
                handicap = historical_player["handicap"]
                if handicap is not None:
                    histories[current_player["id"]][snapshot.result_week] = handicap

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


def attach_score_consistency(
    season: dict[str, Any], snapshots: list[ParsedEmail]
) -> None:
    """Compare earlier tables without allowing them to overwrite final scores."""

    current_teams = {team["id"]: team for team in season["teams"]}
    final_file = season["source"]["file"]
    compared_rounds = 0
    compared_files: set[str] = set()
    conflicts: list[str] = []

    for snapshot in snapshots:
        snapshot_file = snapshot.season["source"]["file"]
        if snapshot_file == final_file:
            continue
        compared_files.add(snapshot_file)
        for historical_team in snapshot.season["teams"]:
            current_team = match_historical_team(current_teams, historical_team)
            if current_team is None:
                continue
            for historical_player in historical_team["players"]:
                current_player = match_historical_player(current_team, historical_player)
                if current_player is None:
                    continue
                final_by_week = {
                    item["week"]: item for item in current_player["rounds"]
                }
                for historical_round in historical_player["rounds"]:
                    if not historical_round["played"]:
                        continue
                    final_round = final_by_week.get(historical_round["week"])
                    if final_round is None:
                        continue
                    compared_rounds += 1
                    historical_value = (
                        historical_round["gross"]
                        if historical_round["gross"] is not None
                        else "X"
                    )
                    final_value = (
                        final_round["gross"]
                        if final_round["gross"] is not None
                        else "X" if final_round["omitted"] else "blank"
                    )
                    if historical_value != final_value:
                        conflicts.append(
                            f"{snapshot_file}: {current_team['name']} / "
                            f"{current_player['name']} Week {historical_round['week']} "
                            f"was {historical_value}; final table says {final_value}"
                        )

    season["validation"]["scoreConsistency"] = {
        "authoritativeFile": final_file,
        "filesCompared": len(compared_files),
        "roundsCompared": compared_rounds,
        "conflictCount": len(conflicts),
        "conflicts": conflicts,
    }


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
        parsed_key = (parsed.result_week, parsed.source_date)
        current_key = (
            (current.result_week, current.source_date)
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
        attach_score_consistency(item.season, snapshots[season_id])
        seasons.append(item.season)
    seasons.sort(key=lambda season: (season["year"], season["league"]), reverse=True)
    player_profiles = build_player_profiles(seasons)
    return {
        "schemaVersion": 4,
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
            f"{validation['playerRounds']} rounds played "
            f"({validation['scorablePlayerRounds']} scorable, "
            f"{validation['omittedScoreRounds']} marked X), "
            f"{validation['handicapSnapshots']} cap snapshots from "
            f"{len(season['handicapWeeks'])} result weeks"
        )
        for warning in validation["warnings"]:
            print(f"  warning: {warning}")
        for warning in validation["handicapHistoryWarnings"]:
            print(f"  warning: {warning}")
        consistency = validation["scoreConsistency"]
        print(
            f"  checked {consistency['roundsCompared']} earlier-table scores; "
            f"{consistency['conflictCount']} differ from final source-of-truth table"
        )
    for warning in store["importWarnings"]:
        print(f"Skipped {warning}")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
