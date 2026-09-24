from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("pi_logs.py")
SPEC = importlib.util.spec_from_file_location("pie_logs_under_test", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
pi_logs = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = pi_logs
SPEC.loader.exec_module(pi_logs)


def write_session(path: Path, cwd: str, entries: list[dict] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [{"type": "session", "version": 3, "id": path.stem, "cwd": cwd}]
    records.extend(entries or [])
    path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")


class PathResolutionTests(unittest.TestCase):
    def test_agent_env_controls_debug_and_settings_paths(self) -> None:
        agent_dir = Path(tempfile.gettempdir()) / "pie-agent-test"
        env = {pi_logs.ENV_AGENT_DIR: str(agent_dir)}

        self.assertEqual(pi_logs.resolve_agent_dir(env), agent_dir)
        self.assertEqual(pi_logs.resolve_debug_log(env), agent_dir / "pi-debug.log")
        self.assertEqual(pi_logs.resolve_settings_file(env), agent_dir / "settings.json")

    def test_tmp_dir_precedence_matches_node(self) -> None:
        self.assertEqual(
            pi_logs.resolve_tmp_dir({"TMPDIR": "/git-bash", "TEMP": "C:/native", "TMP": "C:/tmp"}, platform="nt"),
            Path("C:/native"),
        )
        self.assertEqual(
            pi_logs.resolve_tmp_dir({"TMPDIR": "/preferred", "TMP": "/second", "TEMP": "/third"}, platform="posix"),
            Path("/preferred"),
        )

    def test_session_store_precedence_matches_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            settings = root / "agent" / "settings.json"
            settings.parent.mkdir()
            settings.write_text(json.dumps({"sessionDir": "../from-settings"}), encoding="utf-8")
            explicit = root / "explicit"
            from_env = root / "from-env"
            sdk_default = root / "sdk-default"

            self.assertEqual(
                pi_logs.resolve_sessions_dir(
                    str(explicit),
                    environ={pi_logs.ENV_SESSION_DIR: str(from_env)},
                    settings_file=settings,
                    sdk_default=sdk_default,
                ),
                explicit.resolve(),
            )
            self.assertEqual(
                pi_logs.resolve_sessions_dir(
                    None,
                    environ={pi_logs.ENV_SESSION_DIR: str(from_env)},
                    settings_file=settings,
                    sdk_default=sdk_default,
                ),
                from_env.resolve(),
            )
            self.assertEqual(
                pi_logs.resolve_sessions_dir(
                    None,
                    environ={},
                    settings_file=settings,
                    sdk_default=sdk_default,
                ),
                (root / "from-settings").resolve(),
            )
            settings.write_text("{}", encoding="utf-8")
            self.assertEqual(
                pi_logs.resolve_sessions_dir(
                    None,
                    environ={},
                    settings_file=settings,
                    sdk_default=sdk_default,
                ),
                sdk_default,
            )

            agent_dir = root / "custom-agent"
            agent_dir.mkdir()
            (agent_dir / "settings.json").write_text(
                json.dumps({"sessionDir": "custom-sessions"}),
                encoding="utf-8",
            )
            self.assertEqual(
                pi_logs.resolve_sessions_dir(None, environ={pi_logs.ENV_AGENT_DIR: str(agent_dir)}),
                (agent_dir / "custom-sessions").resolve(),
            )
            (agent_dir / "settings.json").write_text("{}", encoding="utf-8")
            self.assertEqual(
                pi_logs.resolve_sessions_dir(None, environ={pi_logs.ENV_AGENT_DIR: str(agent_dir)}),
                agent_dir / "sessions",
            )


class SessionSelectionTests(unittest.TestCase):
    def test_cwd_matches_normalized_headers_across_store(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            store = Path(raw_root)
            matching = store / "arbitrary-bucket" / "matching.jsonl"
            unrelated = store / "--C--wrong-encoded-name--" / "unrelated.jsonl"
            write_session(matching, r"C:\Users\Example\Project")
            write_session(unrelated, r"C:\Users\Example\Other")

            found = pi_logs.find_sessions("c:/users/example/project/.", sessions_dir=store)

            self.assertEqual(found, [matching])

    def test_cwd_miss_fails_without_unrelated_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            store = Path(raw_root)
            unrelated = store / "bucket" / "unrelated.jsonl"
            write_session(unrelated, "/some/other/project")
            stdout = io.StringIO()
            stderr = io.StringIO()

            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = pi_logs.main([
                    "session",
                    "--cwd",
                    "/requested/project",
                    "--sessions-dir",
                    str(store),
                ])

            self.assertEqual(result, 1)
            self.assertIn("no session with header cwd", stderr.getvalue())
            self.assertNotIn("using session:", stderr.getvalue())
            self.assertNotIn("SESSION:", stdout.getvalue())

    def test_explicit_path_is_opened_even_when_cwd_does_not_match(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            path = Path(raw_root) / "explicit.jsonl"
            write_session(path, "/actual/project")
            stdout = io.StringIO()
            stderr = io.StringIO()

            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = pi_logs.main([
                    "session",
                    str(path),
                    "--cwd",
                    "/different/project",
                    "--summary",
                ])

            self.assertEqual(result, 0)
            self.assertIn(f"SESSION: {path}", stdout.getvalue())
            self.assertEqual(stderr.getvalue(), "")


class ContextEntryTests(unittest.TestCase):
    def test_context_entries_match_latest_compaction_semantics(self) -> None:
        entries = [
            {"type": "message", "id": "old", "parentId": None},
            {"type": "message", "id": "keep-one", "parentId": "old"},
            {"type": "message", "id": "before-first", "parentId": "keep-one"},
            {
                "type": "compaction",
                "id": "compact-one",
                "parentId": "before-first",
                "firstKeptEntryId": "keep-one",
            },
            {"type": "message", "id": "keep-two", "parentId": "compact-one"},
            {
                "type": "compaction",
                "id": "compact-two",
                "parentId": "keep-two",
                "firstKeptEntryId": "keep-two",
            },
            {"type": "message", "id": "other-branch", "parentId": "old"},
            {"type": "message", "id": "current-leaf", "parentId": "compact-two"},
        ]

        context = pi_logs.build_context_entries(entries)

        self.assertEqual(
            [entry["id"] for entry in context],
            ["compact-two", "keep-two", "current-leaf"],
        )

    def test_context_keeps_the_sdk_leaf_when_legacy_entry_has_no_id(self) -> None:
        entry = {"type": "message", "message": {"role": "user", "content": "legacy"}}

        self.assertEqual(pi_logs.build_context_entries([entry]), [entry])

    def test_context_uses_latest_entry_as_sdk_leaf(self) -> None:
        entries = [
            {"type": "message", "id": "root", "parentId": None},
            {"type": "message", "id": "older-leaf", "parentId": "root"},
            {"type": "message", "id": "latest-leaf", "parentId": "root"},
        ]

        context = pi_logs.build_context_entries(entries)

        self.assertEqual([entry["id"] for entry in context], ["root", "latest-leaf"])


class SummaryTests(unittest.TestCase):
    def test_summary_lists_active_and_rotated_persistent_logs(self) -> None:
        with tempfile.TemporaryDirectory() as raw_root:
            root = Path(raw_root)
            sessions = root / "sessions"
            sessions.mkdir()
            persistent_dir = root / "pie-logs"
            persistent_dir.mkdir()
            active = persistent_dir / "pie.log"
            rotated = persistent_dir / "pie.log.1"
            active.write_text("active\n", encoding="utf-8")
            rotated.write_text("rotated\n", encoding="utf-8")
            stdout = io.StringIO()

            with (
                mock.patch.object(pi_logs, "DEBUG_LOG", root / "missing-debug.log"),
                mock.patch.object(pi_logs, "TMP_DIR", root),
                mock.patch.object(pi_logs, "PERSISTENT_LOG_DIR", persistent_dir),
                mock.patch.object(pi_logs, "PERSISTENT_LOGS", (active, rotated)),
                mock.patch.object(pi_logs, "resolve_sessions_dir", return_value=sessions),
                contextlib.redirect_stdout(stdout),
            ):
                result = pi_logs.main([])

            self.assertEqual(result, 0)
            output = stdout.getvalue()
            self.assertIn("pie.log", output)
            self.assertIn("pie.log.1", output)
            self.assertIn("group pie.log", output)
            self.assertIn("group pie.log.1", output)


if __name__ == "__main__":
    unittest.main()
