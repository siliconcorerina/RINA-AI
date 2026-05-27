"""Unit tests for the pluggable backend layer.

We can't reach OpenAI/Anthropic/Mistral from CI without spending money on
API calls (and CI shouldn't depend on third-party uptime anyway), so the
tests focus on three things:
  - `from_spec` parsing is strict and unambiguous,
  - missing API-key envs fail loudly with a useful message,
  - `_truncate_on_stops` correctly cuts on the earliest match.

The actual HF / API generation paths are exercised by the benchmark
runners themselves — pointless to mock the network here.
"""

from __future__ import annotations

import os

import pytest

from evaluation._utils.backend import (
    AnthropicBackend,
    Backend,
    GenerationConfig,
    HuggingFaceBackend,
    MistralBackend,
    OpenAIBackend,
    _truncate_on_stops,
)


def test_truncate_on_stops_no_stops():
    assert _truncate_on_stops("hello world", []) == "hello world"


def test_truncate_on_stops_single_match():
    assert _truncate_on_stops("def f():\n    pass\n\ndef g():\n    pass", ["\n\ndef "]) == "def f():\n    pass"


def test_truncate_on_stops_earliest_match_wins():
    # \n\n appears at index 8, "STOP" appears at 14 → \n\n should win.
    text = "hello x\n\nworld STOP tail"
    assert _truncate_on_stops(text, ["STOP", "\n\n"]) == "hello x"


def test_truncate_on_stops_empty_strings_ignored():
    assert _truncate_on_stops("abc", ["", "b"]) == "a"


def test_generation_config_defaults():
    c = GenerationConfig()
    assert c.max_new_tokens == 512
    assert 0 < c.temperature <= 1
    assert c.stop == []


def test_from_spec_bare_string_means_huggingface(monkeypatch):
    """A spec without a `provider:` prefix should be treated as HF — the
    legacy CLI behaviour before this refactor."""
    # We monkeypatch the constructor so we don't actually load the model.
    captured: dict[str, str] = {}

    class _Stub(HuggingFaceBackend):
        def __init__(self, model_id, device="auto", dtype=None):
            captured["model_id"] = model_id

    monkeypatch.setattr("evaluation._utils.backend.HuggingFaceBackend", _Stub)

    Backend.from_spec("siliconcorerina/rina-coder-base")
    assert captured["model_id"] == "siliconcorerina/rina-coder-base"


def test_from_spec_unknown_provider_raises():
    with pytest.raises(ValueError, match="Unknown backend provider 'cohere'"):
        Backend.from_spec("cohere:command-r")


def test_from_spec_dispatches_to_huggingface(monkeypatch):
    captured: dict[str, str] = {}

    class _Stub(HuggingFaceBackend):
        def __init__(self, model_id, device="auto", dtype=None):
            captured["model_id"] = model_id

    monkeypatch.setattr("evaluation._utils.backend.HuggingFaceBackend", _Stub)

    Backend.from_spec("hf:siliconcorerina/rina-coder-base")
    assert captured["model_id"] == "siliconcorerina/rina-coder-base"

    Backend.from_spec("huggingface:siliconcorerina/rina-coder-base")
    assert captured["model_id"] == "siliconcorerina/rina-coder-base"


def test_openai_backend_missing_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        OpenAIBackend("gpt-4o-mini")


def test_anthropic_backend_missing_api_key(monkeypatch):
    """If the `anthropic` package isn't installed in CI we'll hit the
    import error first; both failure modes are user-actionable so we
    accept either pattern. The key thing is that we never silently
    construct an unconfigured backend."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match=r"ANTHROPIC_API_KEY|anthropic"):
        AnthropicBackend("claude-3-7-sonnet-latest")


def test_mistral_backend_missing_api_key(monkeypatch):
    """Same logic as the Anthropic test — package-missing or key-missing,
    either way we must refuse to construct the backend."""
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match=r"MISTRAL_API_KEY|mistralai"):
        MistralBackend("codestral-latest")


def test_backend_retries_then_propagates(monkeypatch):
    """The `generate` wrapper should retry on transient errors and
    re-raise the last one once exhausted."""
    monkeypatch.setattr("evaluation._utils.backend.time.sleep", lambda _x: None)

    class _Flaky(Backend):
        name = "flaky"

        def __init__(self):
            self.calls = 0

        def _generate_one(self, prompt, config):
            self.calls += 1
            raise RuntimeError(f"boom #{self.calls}")

    b = _Flaky()
    with pytest.raises(RuntimeError, match="boom #3"):
        b.generate("x", retries=2)
    assert b.calls == 3  # original + 2 retries


def test_backend_succeeds_after_retry(monkeypatch):
    monkeypatch.setattr("evaluation._utils.backend.time.sleep", lambda _x: None)

    class _RecoversOnSecondCall(Backend):
        name = "ok-eventually"

        def __init__(self):
            self.calls = 0

        def _generate_one(self, prompt, config):
            self.calls += 1
            if self.calls < 2:
                raise RuntimeError("not yet")
            return "ok"

    b = _RecoversOnSecondCall()
    assert b.generate("x", retries=2) == "ok"
    assert b.calls == 2
