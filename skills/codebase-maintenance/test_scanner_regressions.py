#!/usr/bin/env python3
"""Fast regression tests for the maintenance scanner wrappers."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"maintenance_{name}", HERE / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


large = load("find_large_files")
duplicates = load("find_duplicates")
complexity = load("analyze_complexity")
smells = load("detect_smells")
dead = load("find_dead_code")


class IgnoreTests(unittest.TestCase):
    def test_global_ignore_keeps_production_and_adds_generated_noise(self):
        patterns, _contexts = large.load_ignore_patterns(HERE)
        self.assertIn(".cache/", patterns)
        self.assertIn("analysis/site/dist/", patterns)
        self.assertIn("*.egg-info/", patterns)
        self.assertNotIn("scripts/", patterns)
        self.assertNotIn("analysis/site/app.ts", patterns)
        self.assertNotIn("extension/src/webview/panel/panel.tsx", patterns)

    def test_egg_info_directory_glob_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "package.egg-info" / "generated.py"
            target.parent.mkdir()
            target.write_text("x\n", encoding="utf-8")
            self.assertTrue(large.is_skipped(target, root))


class TraversalPolicyDriftTests(unittest.TestCase):
    """Drift check: the canonical protected-directory policy
    (shared/traversal-policy.ts, STABILITY-ARCHITECTURE-PLAN §7.7) must be
    covered by this skill's .ignore so maintenance scans and shell traversal
    stay aligned. The policy module is parsed directly so the check follows
    the source of truth instead of a mirrored copy."""

    POLICY_PATH = HERE.parent.parent / "shared" / "traversal-policy.ts"

    def _protected_dirs(self) -> list[str]:
        text = self.POLICY_PATH.read_text(encoding="utf-8")
        declaration = re.search(
            r"PROTECTED_DIRECTORIES[^=]*=\s*\[([\s\S]*?)\n\s*\];",
            text,
        )
        self.assertIsNotNone(
            declaration,
            f"cannot locate PROTECTED_DIRECTORIES in {self.POLICY_PATH}",
        )
        body = re.sub(r"/\*[\s\S]*?\*/", "", declaration.group(1))
        body = re.sub(r"//[^\n]*", "", body)
        entry_pattern = re.compile(
            r"\{\s*dir:\s*(['\"])([^'\"]+)\1\s*,\s*"
            r"className:\s*(['\"])([^'\"]+)\3\s*\}"
        )
        entries = list(entry_pattern.finditer(body))
        residue = entry_pattern.sub("", body)
        residue = re.sub(r"[\s,]", "", residue)
        self.assertFalse(
            residue,
            f"unparsed canonical traversal-policy entry: {residue}",
        )
        dirs = [entry.group(2) for entry in entries]
        self.assertTrue(dirs, f"no protected directories parsed from {self.POLICY_PATH}")
        self.assertEqual(len(dirs), len(set(dirs)), "duplicate canonical protected directory")
        return dirs

    @staticmethod
    def _ignore_covers(patterns: list[str], name: str) -> bool:
        for pattern in patterns:
            base = pattern.rstrip("/")
            if base == name or base.endswith(name):
                return True
        return False

    def test_ignore_covers_every_canonical_protected_directory(self):
        patterns, _contexts = large.load_ignore_patterns(HERE)
        missing = [
            name
            for name in self._protected_dirs()
            if not self._ignore_covers(patterns, name)
        ]
        self.assertEqual(
            missing,
            [],
            ".ignore is missing entries for canonical protected directories; "
            "add them (see shared/traversal-policy.ts)",
        )


class DuplicateTests(unittest.TestCase):
    def test_jscpd_uses_file_ignore_globs(self):
        translated = duplicates._ignore_patterns_for_jscpd(
            ["node_modules/", "analysis/site/dist/", "*.min.js"]
        )
        self.assertEqual(
            translated,
            ["**/node_modules/**", "analysis/site/dist/**", "**/*.min.js"],
        )

    def test_jscpd_preserves_root_relative_directory_patterns(self):
        self.assertEqual(
            duplicates._ignore_patterns_for_jscpd(
                ["analysis/data/", "data/", "*.egg-info/"],
            ),
            ["analysis/data/**", "**/data/**", "**/*.egg-info/**"],
        )

    def test_relative_report_path_resolves_from_scan_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            (root / "src").mkdir(parents=True)
            self.assertEqual(duplicates.to_rel_posix("src/app.ts", root), "src/app.ts")
            self.assertEqual(
                duplicates.to_rel_posix("project/src/app.ts", root), "src/app.ts"
            )

    def test_run_jscpd_passes_ignore_not_ignore_pattern(self):
        captured: list[str] = []

        def fake_run(cmd, **_kwargs):
            captured.extend(cmd)
            output = Path(cmd[cmd.index("--output") + 1])
            (output / "jscpd-report.json").write_text(
                json.dumps({"duplicates": []}), encoding="utf-8"
            )
            return types.SimpleNamespace(returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            duplicates.subprocess, "run", side_effect=fake_run
        ):
            duplicates.run_jscpd(Path(tmp), ["jscpd"], 8, 70, ["**/.cache/**"])
        self.assertIn("--ignore", captured)
        self.assertNotIn("--ignore-pattern", captured)

    def test_nonzero_jscpd_fails_even_if_partial_report_exists(self):
        partial_report = {"duplicates": [{"partial": True}]}

        def fake_run(cmd, **_kwargs):
            output = Path(cmd[cmd.index("--output") + 1])
            (output / "jscpd-report.json").write_text(
                json.dumps(partial_report), encoding="utf-8"
            )
            return types.SimpleNamespace(
                returncode=1, stdout="", stderr="scanner failed"
            )

        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            duplicates.subprocess, "run", side_effect=fake_run
        ), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                duplicates.run_jscpd(Path(tmp), ["jscpd"], 8, 70, [])

        self.assertEqual(raised.exception.code, 1)
        self.assertIn("scanner failed", stderr.getvalue())
        self.assertIn("partial report contains 1 duplicate(s)", stderr.getvalue())

    def test_parse_annotation_includes_exclude_test_flag(self):
        annotation = duplicates.parse_args.__annotations__["return"]
        self.assertEqual(len(annotation.__args__), 6)


class QualitasTests(unittest.TestCase):
    def test_filtered_scan_tree_prunes_nested_data_egg_info_and_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            files = {
                "src/app.ts": "export {};\n",
                "src/nested/data/generated.ts": "export {};\n",
                "src/nested/package.egg-info/generated.py": "x = 1\n",
                "src/nested/drop.py": "x = 1\n",
            }
            for rel_path, content in files.items():
                path = root / rel_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")

            with complexity._stage_filtered_scan_tree(
                root, ["data/", "*.egg-info/", "src/nested/drop.py"]
            ) as (stage, staged_files):
                stage_path = stage
                visible = sorted(
                    path.relative_to(stage).as_posix()
                    for path in stage.rglob("*") if path.is_file()
                )
                self.assertEqual(staged_files, ["src/app.ts"])
                self.assertEqual(visible, ["src/app.ts"])
            self.assertFalse(stage_path.exists())

    @unittest.skipUnless(shutil.which("npx"), "npx is not installed")
    def test_real_qualitas_scans_only_the_filtered_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            for rel_path in (
                "src/kept.js",
                "src/nested/data/ignored.js",
                "src/nested/package.egg-info/ignored.py",
            ):
                path = root / rel_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    "function probe(value) { return value ? value + 1 : 0; }\n",
                    encoding="utf-8",
                )
            with complexity._stage_filtered_scan_tree(
                root, ["data/", "*.egg-info/"]
            ) as (stage, staged_files):
                self.assertEqual(staged_files, ["src/kept.js"])
                report = complexity.run_qualitas(stage, [stage])

        reported = {entry["filePath"] for entry in report["files"]}
        self.assertIn("src/kept.js", reported)
        self.assertFalse(any("data" in path or "egg-info" in path for path in reported))

    def fake_result(self, returncode=0, stdout="", stderr=""):
        return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)

    def test_nonzero_qualitas_fails_even_if_report_exists(self):
        def fake_run(cmd, **_kwargs):
            Path(cmd[cmd.index("-o") + 1]).write_text(
                json.dumps({"files": []}), encoding="utf-8"
            )
            return self.fake_result(3, stderr="parser failed")

        with mock.patch.object(complexity.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(complexity.QualitasExecutionError, "exit 3"):
                complexity._run_qualitas_on_dir(Path("src"), "npx")

    def test_missing_and_invalid_qualitas_reports_fail(self):
        with mock.patch.object(
            complexity.subprocess, "run", return_value=self.fake_result()
        ):
            with self.assertRaisesRegex(complexity.QualitasExecutionError, "no report"):
                complexity._run_qualitas_on_dir(Path("src"), "npx")

        def invalid(cmd, **_kwargs):
            Path(cmd[cmd.index("-o") + 1]).write_text("not json", encoding="utf-8")
            return self.fake_result()

        with mock.patch.object(complexity.subprocess, "run", side_effect=invalid):
            with self.assertRaisesRegex(complexity.QualitasExecutionError, "invalid JSON"):
                complexity._run_qualitas_on_dir(Path("src"), "npx")

    def test_qualitas_timeout_fails(self):
        with mock.patch.object(
            complexity.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["qualitas"], 60),
        ):
            with self.assertRaisesRegex(complexity.QualitasExecutionError, "timed out"):
                complexity._run_qualitas_on_dir(Path("src"), "npx")


class SemgrepTests(unittest.TestCase):
    def test_partial_results_retain_nonzero_execution_status_and_diagnostics(self):
        payload = {"results": [{"path": "src/a.py"}], "errors": []}
        result = types.SimpleNamespace(
            returncode=7, stdout=json.dumps(payload), stderr="engine crashed"
        )
        stderr = io.StringIO()
        with mock.patch.object(smells.shutil, "which", return_value="semgrep"), mock.patch.object(
            smells.subprocess, "run", return_value=result
        ), contextlib.redirect_stderr(stderr):
            data = smells.run_semgrep(Path("."), "rules", [".cache/"])
        self.assertEqual(data["_execution_exit_code"], 7)
        self.assertIn("engine crashed", stderr.getvalue())

    def test_main_propagates_structured_semgrep_errors(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            smells, "run_semgrep", return_value={"results": [], "errors": [{"message": "bad parse"}]}
        ), mock.patch.object(sys, "argv", ["detect_smells.py", tmp]):
            with self.assertRaises(SystemExit) as raised:
                smells.main()
        self.assertEqual(raised.exception.code, 2)

    def test_semgrep_native_excludes_use_windows_safe_root_and_any_depth_forms(self):
        self.assertEqual(
            smells._exclude_patterns_for_semgrep(
                [
                    "data/", ".cache/", "analysis/data/", "*.min.js", "*.egg-info/",
                    "**/cache/**", "**/*.generated.py", "src/**",
                    "src/**/generated/*.py", "src/generated/**",
                ],
            ),
            [
                "data", ".cache", "analysis/data", "*.min.js", "*.egg-info",
                "cache", "*.generated.py", "src/generated",
            ],
        )

    def test_run_semgrep_passes_safe_excludes_without_globstars(self):
        captured: list[str] = []

        def fake_run(cmd, **_kwargs):
            captured.extend(cmd)
            return types.SimpleNamespace(
                returncode=0, stdout=json.dumps({"results": [], "errors": []}), stderr=""
            )

        with mock.patch.object(smells.shutil, "which", return_value="semgrep"), mock.patch.object(
            smells.subprocess, "run", side_effect=fake_run
        ):
            smells.run_semgrep(Path("."), "rules.yml", ["**/cache/**", "src/**/generated/*.py"])

        exclude_values = [
            captured[index + 1]
            for index, value in enumerate(captured)
            if value == "--exclude"
        ]
        self.assertEqual(exclude_values, ["cache"])
        self.assertFalse(any("**" in value for value in exclude_values))

    @unittest.skipUnless(shutil.which("semgrep"), "semgrep is not installed")
    def test_real_semgrep_excludes_preserve_root_and_any_depth_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "project"
            for rel_path in (
                "data/root.py",
                "nested/data/deep.py",
                "config/generated/root.py",
                "nested/config/generated/kept.py",
                "package.egg-info/generated.py",
                "src/kept.py",
            ):
                path = root / rel_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('eval("probe")\n', encoding="utf-8")
            rules = base / "rules.yml"
            rules.write_text(
                "rules:\n"
                "  - id: exclude-probe\n"
                "    languages: [python]\n"
                "    severity: WARNING\n"
                "    message: probe\n"
                "    pattern: eval(...)\n",
                encoding="utf-8",
            )
            report = smells.run_semgrep(
                root, str(rules), ["data/", "config/generated/", "*.egg-info/"]
            )
            paths = {
                Path(result["path"]).resolve().relative_to(root.resolve()).as_posix()
                for result in report["results"]
            }

        self.assertEqual(paths, {"nested/config/generated/kept.py", "src/kept.py"})


class DeadCodeTests(unittest.TestCase):
    def test_unparseable_finding_is_unverified_not_verified(self):
        verified, false_positives, unverified = dead._verify_dead_code(
            ["unexpected skylos output"], Path("."), []
        )
        self.assertEqual(verified, [])
        self.assertEqual(false_positives, [])
        self.assertEqual(unverified, ["unexpected skylos output"])

    def test_pinned_dart_limitation_is_documented(self):
        self.assertIn("predates Dart support", dead.__doc__)
        self.assertIn("SKYLOS_VERSION`` to 4.13.0 or", dead.__doc__)
        source = (HERE / "find_dead_code.py").read_text(encoding="utf-8")
        self.assertIn("skylos >=4.13.0 pulls in ``tree-sitter-dart-orchard``", source)
        self.assertNotIn("skylos >=4.11 pulls in", source)


class NegativeMaxFindingsTests(unittest.TestCase):
    def test_each_scanner_rejects_negative_max_findings(self):
        scripts = [
            "find_duplicates.py",
            "find_dead_code.py",
            "detect_smells.py",
            "analyze_complexity.py",
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for script in scripts:
                result = subprocess.run(
                    [sys.executable, str(HERE / script), tmp, "--max-findings", "-1"],
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 2, (script, result.stderr))
                self.assertIn("--max-findings", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
