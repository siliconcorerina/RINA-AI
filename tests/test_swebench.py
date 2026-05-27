"""Unit tests for the SWE-bench runner's pure-function helpers.

The actual generation + Docker-grading flow needs a backend and a
machine that can run the official `swebench` harness — neither is
appropriate for CI. We test the bits that are pure:

  - patch extraction from free-form model responses (fenced, unfenced,
    prose-only, multiple blocks),
  - the well-formed-diff sniff test,
  - prompt construction (hints opt-in, missing fields tolerated),
  - the dataset shortcut → HF id mapping.
"""

from __future__ import annotations

from evaluation.swebench.run_eval import (
    DATASETS,
    build_prompt,
    extract_patch,
    is_well_formed_diff,
)

SAMPLE_DIFF = """diff --git a/src/foo.py b/src/foo.py
index 1234567..89abcde 100644
--- a/src/foo.py
+++ b/src/foo.py
@@ -1,3 +1,3 @@
-def foo():
-    return 1
+def foo():
+    return 2
"""


def test_datasets_registry_has_three_splits():
    """The three canonical SWE-bench splits — anything else is a typo."""
    assert set(DATASETS.keys()) == {"lite", "verified", "full"}
    for name, hf_id in DATASETS.items():
        assert hf_id.startswith("princeton-nlp/SWE-bench"), f"{name} → {hf_id} doesn't match the official org prefix"


def test_is_well_formed_diff_canonical_header():
    assert is_well_formed_diff(SAMPLE_DIFF) is True


def test_is_well_formed_diff_minus_plus_only():
    """git apply also accepts patches starting with ---/+++ without the
    diff --git header (e.g. patches produced by `diff -u`)."""
    text = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old\n+new\n"
    assert is_well_formed_diff(text) is True


def test_is_well_formed_diff_rejects_prose():
    """A polite refusal or a chunk of explanatory text must NOT be
    classified as a patch."""
    assert is_well_formed_diff("Sorry, I can't help with that.") is False
    assert is_well_formed_diff("") is False
    assert is_well_formed_diff("Here is what I would change: …") is False


def test_extract_patch_from_fenced_block():
    response = f"Sure! Here's the fix:\n\n```diff\n{SAMPLE_DIFF}```\n\nLet me know!"
    assert extract_patch(response).startswith("diff --git a/src/foo.py")


def test_extract_patch_picks_longest_block_when_multiple():
    """Some models emit a small example then the real diff. We want
    the real one, which is virtually always the longest."""
    small = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"
    response = f"```diff\n{small}```\n\nActually, the full fix:\n```diff\n{SAMPLE_DIFF}```\n"
    extracted = extract_patch(response)
    # Longest wins → the second (full) block.
    assert "src/foo.py" in extracted


def test_extract_patch_unfenced_raw_diff():
    """Some models forget the fence and just emit the diff. Should
    still be detected and returned."""
    assert extract_patch(SAMPLE_DIFF).startswith("diff --git")


def test_extract_patch_returns_empty_on_prose():
    """No diff in sight → empty string. The runner uses this to count
    'no patch produced' instances explicitly."""
    assert extract_patch("Apologies, I cannot solve this issue.") == ""
    assert extract_patch("") == ""


def test_extract_patch_rejects_malformed_fenced_block():
    """A ```diff``` block that doesn't actually contain a diff should
    NOT be returned — we'd rather classify it as 'no patch' than
    promise the user something that won't apply."""
    response = "```diff\nI'm not sure how to fix this.\n```"
    assert extract_patch(response) == ""


def test_build_prompt_minimal_instance():
    """A bare instance with only the required fields should still
    produce a valid prompt — no KeyErrors on optional fields."""
    instance = {
        "repo": "django/django",
        "base_commit": "deadbeef",
        "problem_statement": "Bug: foo crashes on bar.",
    }
    p = build_prompt(instance, include_hints=False)
    assert "django/django" in p
    assert "deadbeef" in p
    assert "foo crashes on bar" in p
    # When hints aren't requested, the hints section must not leak in
    # even if the instance carries them.
    assert "Maintainer hints" not in p


def test_build_prompt_hints_opt_in():
    instance = {
        "repo": "x/y",
        "base_commit": "abc",
        "problem_statement": "Issue.",
        "hints_text": "Look at module Z.",
    }
    with_hints = build_prompt(instance, include_hints=True)
    assert "Maintainer hints" in with_hints
    assert "module Z" in with_hints

    without = build_prompt(instance, include_hints=False)
    assert "Maintainer hints" not in without


def test_build_prompt_empty_hints_collapse():
    """An instance with `hints_text=""` shouldn't render an empty
    hints section even with `--include-hints`."""
    instance = {
        "repo": "x/y",
        "base_commit": "abc",
        "problem_statement": "Issue.",
        "hints_text": "   ",
    }
    p = build_prompt(instance, include_hints=True)
    assert "Maintainer hints" not in p
