"""Validation of persisted study state; never repair counters by guessing."""
import math
from datetime import datetime


class InvalidSession(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidSession(f"Saved session needs recovery: {message}. The save was not reset.")


def integer(value):
    return type(value) is int


def timestamp(value):
    if value is None:
        return True
    try:
        return isinstance(value, str) and datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


def validate_session(data, session_id):
    require(isinstance(data, dict), "expected a session object")
    required = {"schema_version", "session_id", "mode", "round", "total_rounds", "pot", "bank",
                "pending", "events", "dialogue", "rounds", "typing_text", "typing_updated_at", "last_activity_at"}
    require(required <= data.keys(), "missing required fields")
    require(type(data["schema_version"]) is int and data["schema_version"] == 2, "unsupported schema")
    require(data["session_id"] == session_id, "participant ID mismatch")
    require(data["mode"] in ("ai", "human", "unknown"), "invalid route")
    require(integer(data["total_rounds"]) and data["total_rounds"] == 7, "invalid round limit")
    require(integer(data["pot"]) and data["pot"] == 100, "invalid pot")
    require(integer(data["round"]) and 1 <= data["round"] <= 8, "invalid current round")
    require(integer(data["bank"]) and 0 <= data["bank"] <= (data["round"] - 1) * 100
            and data["bank"] % 50 == 0, "invalid bank")
    require(data.get("avatar") in (None, "male", "female"), "invalid assigned avatar")
    require(isinstance(data["pending"], dict), "invalid request collection")
    require(all(isinstance(data[key], list) and all(isinstance(row, dict) for row in data[key])
                for key in ("events", "dialogue", "rounds")), "invalid history collection")
    require(isinstance(data["typing_text"], str), "invalid typing text")
    require(timestamp(data["last_activity_at"]) and timestamp(data["typing_updated_at"]), "invalid activity timestamp")
    for turn in data["dialogue"]:
        require(turn.get("role") in ("user", "assistant") and isinstance(turn.get("content"), str), "invalid dialogue turn")

    # Legacy sessions can have earlier runs under the same participant ID. The
    # explicit upgrade checkpoint is the boundary after which counters agree.
    boundary = -1
    for index, event in enumerate(data["events"]):
        if event.get("type") == "server_upgrade_checkpoint":
            boundary = index
    current_ids = {event.get("request_id") for event in data["events"][boundary + 1:]
                   if event.get("type") == "split_steal" and event.get("schema_version") == 2}
    current_rounds = [row for row in data["rounds"] if row.get("schema_version") == 2
                      and (boundary < 0 or row.get("request_id") in current_ids)]
    previous = None
    round_ids = set()
    for row in current_rounds:
        require(isinstance(row.get("request_id"), str) and row["request_id"] not in round_ids, "duplicate round request")
        round_ids.add(row["request_id"])
        require(integer(row.get("round")) and 1 <= row["round"] <= 7, "invalid recorded round")
        choices = (row.get("participant_choice"), row.get("assistant_choice"))
        outcomes = {("split", "split"): ("tie", 50), ("steal", "split"): ("user_wins", 100),
                    ("split", "steal"): ("assistant_wins", 0), ("steal", "steal"): ("no_one_wins", 0)}
        require(all(isinstance(choice, str) for choice in choices) and choices in outcomes, "invalid recorded choices")
        require(integer(row.get("payout")) and (row.get("outcome"), row.get("payout")) == outcomes[choices], "inconsistent payout")
        require(integer(row.get("bank")) and row["bank"] >= row["payout"], "invalid recorded bank")
        if previous is not None:
            require(row["round"] == previous["round"] + 1 and row["bank"] == previous["bank"] + row["payout"],
                    "round history is not sequential")
        require(row["request_id"] in data["pending"], "recorded round has no request")
        previous = row
    if previous:
        require(data["round"] == previous["round"] + 1 and data["bank"] == previous["bank"],
                "counters disagree with recorded rounds")
    for request_id, item in data["pending"].items():
        require(isinstance(item, dict) and item.get("id") == request_id and item.get("session_id") == session_id,
                "invalid request identity")
        require(item.get("kind") in ("message", "choice") and item.get("engine") in ("human", "ai"), "invalid request type")
        require(item.get("mode") in ("human", "ai", "unknown"), "invalid request route")
        require(item.get("avatar") in ("male", "female"), "invalid request avatar")
        require(item.get("status") in ("waiting", "processing", "interrupted", "ready", "cancelled"), "invalid request status")
        require(type(item.get("acknowledged")) is bool, "invalid acknowledgement")
        require(isinstance(item.get("participant_text"), str), "invalid request text")
        require(timestamp(item.get("created_at")), "invalid request timestamp")
        ready_at = item.get("ready_at")
        require(ready_at is None or (type(ready_at) in (int, float) and math.isfinite(ready_at) and ready_at >= 0),
                "invalid response time")
        response = item.get("response")
        if item.get("status") == "cancelled":
            require(item["acknowledged"] and response is None, "invalid cancelled request")
        elif response is None:
            require(item["status"] != "ready" and not item["acknowledged"], "missing committed response")
        else:
            require(isinstance(response, dict) and isinstance(response.get("reply"), str) and ready_at is not None,
                    "invalid committed response")
            require(item["status"] == "ready", "response status mismatch")
        # Older journal records have a different response shape; they remain
        # explicitly identifiable and are not rewritten as modern requests.
        if item.get("type") in ("human_message_pending", "human_choice_pending"):
            continue
        require(integer(item.get("round")) and 1 <= item["round"] <= 7, "invalid request round")
        require(isinstance(item.get("fingerprint"), list) and len(item["fingerprint"]) == 6, "missing request fingerprint")
        if response is not None:
            require(response.get("message_id") == request_id and response.get("session_id") == session_id,
                    "response identity mismatch")
            if item["kind"] == "choice":
                matches = [row for row in data["rounds"] if row.get("request_id") == request_id]
                require(len(matches) == 1, "committed choice has no unique round")
                require(all(response.get(key) == matches[0].get(key)
                            for key in ("round", "bank", "payout", "outcome", "participant_choice", "assistant_choice")),
                        "response disagrees with round")
