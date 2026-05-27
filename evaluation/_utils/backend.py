"""Pluggable model backends for the evaluation framework.

Every benchmark runner takes a `Backend` and calls `.generate(prompt, ...)`.
This decouples *what we're testing* (RINA, GPT-4, Claude, Codestral, …)
from *how we run the benchmark*.

Backends are addressed by a single string spec so the CLI stays clean:

    hf:siliconcorerina/rina-coder-base       → HuggingFace local checkpoint
    hf:/path/to/local/dir                    → Same, from a local path
    openai:gpt-4o-mini                       → OpenAI chat completions
    openai:gpt-4o                            → ditto
    anthropic:claude-3-7-sonnet-latest       → Anthropic messages API
    mistral:codestral-latest                 → Mistral chat completions
    mistral:mistral-large-latest             → ditto

`Backend.from_spec("hf:…")` returns a ready-to-call object. Each backend
reads its API key from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY,
MISTRAL_API_KEY) and raises an explicit error if it's missing — better
than silently authenticating to nobody.
"""

from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class GenerationConfig:
    """Decoding parameters shared across every backend.

    Not every backend honors every field (e.g. OpenAI ignores `top_k`),
    but the interface is uniform so a benchmark runner only has to pass
    one config object.
    """

    max_new_tokens: int = 512
    temperature: float = 0.2
    top_p: float = 0.95
    top_k: int = 50
    stop: list[str] = field(default_factory=list)
    seed: int | None = None


class Backend(ABC):
    """Generate completions for a single prompt.

    Subclasses implement `_generate_one`; the public `generate` wraps it
    with a coarse-grained retry on transient failures so a CI run isn't
    killed by a single 503.
    """

    name: str = "backend"
    spec: str = ""

    @abstractmethod
    def _generate_one(self, prompt: str, config: GenerationConfig) -> str:
        """Return the model's completion for `prompt`."""

    def generate(self, prompt: str, config: GenerationConfig | None = None, retries: int = 2) -> str:
        cfg = config or GenerationConfig()
        last_exc: Exception | None = None
        for attempt in range(retries + 1):
            try:
                return self._generate_one(prompt, cfg)
            except Exception as exc:  # noqa: BLE001 — every backend wraps to its own exception type
                last_exc = exc
                # Brief exponential backoff: 1s, 2s, 4s.
                if attempt < retries:
                    time.sleep(2 ** attempt)
        # All retries exhausted — re-raise the most recent error so the
        # benchmark loop can record it and keep going.
        raise last_exc  # type: ignore[misc]

    @staticmethod
    def from_spec(spec: str) -> "Backend":
        """Parse a `<provider>:<model>` spec into a concrete backend.

        Raises ValueError on unknown providers so a typo in the CLI fails
        loudly rather than silently picking the wrong model.
        """
        if ":" not in spec:
            # Bare model name → assume HuggingFace, the original behaviour.
            return HuggingFaceBackend(spec)

        provider, model = spec.split(":", 1)
        provider = provider.lower().strip()

        if provider in {"hf", "huggingface"}:
            return HuggingFaceBackend(model)
        if provider == "openai":
            return OpenAIBackend(model)
        if provider == "anthropic":
            return AnthropicBackend(model)
        if provider == "mistral":
            return MistralBackend(model)

        raise ValueError(
            f"Unknown backend provider '{provider}'. "
            "Supported: hf, openai, anthropic, mistral."
        )


# ─────────────────────────────────────────────────────────────────────
# HuggingFace local backend — the original behaviour of run_eval.py
# ─────────────────────────────────────────────────────────────────────

class HuggingFaceBackend(Backend):
    """Runs a checkpoint locally via `transformers`.

    Loads the model once at construction time so subsequent generations
    only pay tokenization + forward-pass cost. `device_map="auto"` lets
    HF route layers to GPU/CPU; pass an explicit device string if you
    need finer control.
    """

    name = "huggingface"

    def __init__(self, model_id: str, device: str = "auto", dtype: str | None = None) -> None:
        try:
            import torch  # noqa: F401  (only to surface the missing-dep error here)
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError(
                "HuggingFace backend requires `torch` and `transformers`. "
                "Install via `pip install -r requirements.txt`."
            ) from exc

        self.spec = f"hf:{model_id}"
        self.model_id = model_id

        load_kwargs: dict[str, Any] = {"device_map": device}
        if dtype is not None:
            import torch as _torch
            load_kwargs["torch_dtype"] = getattr(_torch, dtype)

        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = AutoModelForCausalLM.from_pretrained(model_id, **load_kwargs)

    def _generate_one(self, prompt: str, config: GenerationConfig) -> str:
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.model.device)
        gen_kwargs: dict[str, Any] = {
            "max_new_tokens": config.max_new_tokens,
            "temperature": config.temperature,
            "top_p": config.top_p,
            "top_k": config.top_k,
            "do_sample": config.temperature > 0,
            "pad_token_id": self.tokenizer.eos_token_id,
        }
        outputs = self.model.generate(**inputs, **gen_kwargs)
        text = self.tokenizer.decode(
            outputs[0][inputs["input_ids"].shape[1] :],
            skip_special_tokens=True,
        )
        return _truncate_on_stops(text, config.stop)


# ─────────────────────────────────────────────────────────────────────
# Hosted API backends
# ─────────────────────────────────────────────────────────────────────

def _require_env(key: str, backend_name: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(
            f"{backend_name} backend requires the {key} environment variable. "
            f"Export it before running the benchmark."
        )
    return value


class OpenAIBackend(Backend):
    """Uses OpenAI's Chat Completions API.

    Treats the entire prompt as a single user message — code-completion-
    style benchmarks (HumanEval, MBPP) are designed to work fine in that
    shape. For chat-style benchmarks the runner should adapt the prompt
    on its side rather than reshape it here.
    """

    name = "openai"

    def __init__(self, model: str) -> None:
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError(
                "OpenAI backend requires the `openai` package. "
                "Install via `pip install openai`."
            ) from exc

        api_key = _require_env("OPENAI_API_KEY", "OpenAI")
        self.spec = f"openai:{model}"
        self.model = model
        self.client = OpenAI(api_key=api_key)

    def _generate_one(self, prompt: str, config: GenerationConfig) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=config.max_new_tokens,
            temperature=config.temperature,
            top_p=config.top_p,
            stop=config.stop or None,
            seed=config.seed,
        )
        text = response.choices[0].message.content or ""
        return text


class AnthropicBackend(Backend):
    """Uses Anthropic's Messages API."""

    name = "anthropic"

    def __init__(self, model: str) -> None:
        try:
            from anthropic import Anthropic
        except ImportError as exc:
            raise RuntimeError(
                "Anthropic backend requires the `anthropic` package. "
                "Install via `pip install anthropic`."
            ) from exc

        api_key = _require_env("ANTHROPIC_API_KEY", "Anthropic")
        self.spec = f"anthropic:{model}"
        self.model = model
        self.client = Anthropic(api_key=api_key)

    def _generate_one(self, prompt: str, config: GenerationConfig) -> str:
        response = self.client.messages.create(
            model=self.model,
            max_tokens=config.max_new_tokens,
            temperature=config.temperature,
            top_p=config.top_p,
            stop_sequences=config.stop or None,
            messages=[{"role": "user", "content": prompt}],
        )
        # Anthropic's content is a list of content blocks; for plain text
        # responses we expect a single TextBlock.
        parts: list[str] = []
        for block in response.content:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)  # type: ignore[union-attr]
        return "".join(parts)


class MistralBackend(Backend):
    """Uses Mistral's Chat Completions API.

    Codestral is just a specialised model on the same endpoint, so the
    same backend class covers both general Mistral models and Codestral.
    """

    name = "mistral"

    def __init__(self, model: str) -> None:
        try:
            from mistralai import Mistral
        except ImportError as exc:
            raise RuntimeError(
                "Mistral backend requires the `mistralai` package. "
                "Install via `pip install mistralai`."
            ) from exc

        api_key = _require_env("MISTRAL_API_KEY", "Mistral")
        self.spec = f"mistral:{model}"
        self.model = model
        self.client = Mistral(api_key=api_key)

    def _generate_one(self, prompt: str, config: GenerationConfig) -> str:
        response = self.client.chat.complete(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=config.max_new_tokens,
            temperature=config.temperature,
            top_p=config.top_p,
            stop=config.stop or None,
            random_seed=config.seed,
        )
        return response.choices[0].message.content or ""


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _truncate_on_stops(text: str, stops: list[str]) -> str:
    """Cut the generation at the first occurrence of any stop string.

    HuggingFace's `generate` doesn't natively support multi-token stop
    sequences for arbitrary tokenizers, so we apply them post-hoc.
    No-op when `stops` is empty.
    """
    if not stops:
        return text
    earliest = len(text)
    for s in stops:
        if not s:
            continue
        idx = text.find(s)
        if 0 <= idx < earliest:
            earliest = idx
    return text[:earliest]
