#!/usr/bin/env python3
"""
Generate a larger training dataset for RINA Coder fine-tuning.

Produces a JSONL file with prompt/completion pairs based on common
coding patterns across Python, JavaScript, TypeScript, Rust and Go.

Usage:
    python scripts/generate_training_data.py --count 500 --output finetune/data/train.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

SEED = 42
random.seed(SEED)

# ---------------------------------------------------------------------------
# Templates: each is a (prompt_template, completion_template) tuple
# Variables are substituted with randomly selected values.
# ---------------------------------------------------------------------------

PYTHON_EXAMPLES: list[tuple[str, str]] = [
    # functions
    ('def {name}({params}):\n    """{docstring}"""\n    ', "return {expr}\n"),
    ('def {name}({params}):\n    """{docstring}"""\n    result = {expr}', "\n    return result\n"),
    ('async def {name}({params}):\n    """{docstring}"""\n    ', "return await {expr}\n"),
    # classes
    (
        'class {classname}:\n    """{docstring}"""\n\n    def __init__(self, {params}):\n        ',
        "self.{attr} = {attr}\n",
    ),
    (  # noqa: E501
        'class {classname}:\n    """{docstring}"""\n\n    def {method}(self, {params}):\n        """{method_doc}"""\n        ',
        "return {expr}\n",
    ),
    # lambda / comprehensions — just prompt
    (
        "# Renvoie les elements pairs d une liste\ndef filter_even(lst):\n    ",
        "return [x for x in lst if x % 2 == 0]\n",
    ),
    ("# Compte les occurrences\ndef count_occurrences(lst, target):\n    ", "return lst.count(target)\n"),
    ("# Fusionne deux dictionnaires\ndef merge_dicts(d1, d2):\n    ", "return {{**d1, **d2}}\n"),
    (
        "# Lit un fichier JSON\ndef load_json(path):\n    import json\n    ",
        'with open(path, "r") as f:\n        return json.load(f)\n',
    ),
    (
        "# Ecrit une liste dans un fichier CSV\ndef write_csv(path, rows):\n    import csv\n    ",
        'with open(path, "w", newline="") as f:\n        writer = csv.writer(f)\n        writer.writerows(rows)\n',
    ),
]

JS_EXAMPLES: list[tuple[str, str]] = [
    ("function {name}({params}) {{\n    // {docstring}\n    ", "return {expr};\n}}\n"),
    ("const {name} = ({params}) => {{\n    // {docstring}\n    ", "return {expr};\n}};\n"),
    ("async function {name}({params}) {{\n    // {docstring}\n    ", "return await {expr};\n}}\n"),
    ("class {classname} {{\n    constructor({params}) {{\n        ", "this.{attr} = {attr};\n    }}\n}}\n"),
    ("// Filtrer les elements pairs\nfunction filterEven(arr) {{\n    ", "return arr.filter(x => x % 2 === 0);\n}}\n"),
    ("// Deep clone d un objet\nfunction deepClone(obj) {{\n    ", "return JSON.parse(JSON.stringify(obj));\n}}\n"),
]

TS_EXAMPLES: list[tuple[str, str]] = [
    ("function {name}({params}): {rtype} {{\n    // {docstring}\n    ", "return {expr};\n}}\n"),
    ("const {name} = ({params}): {rtype} => {{\n    // {docstring}\n    ", "return {expr};\n}};\n"),
    (
        "interface {classname} {{\n    {attr}: {rtype};\n}}\n\nfunction create{classname}(data: Partial<{classname}>): {classname} {{\n    ",
        "return {{ ...data }} as {classname};\n}}\n",
    ),
]

RUST_EXAMPLES: list[tuple[str, str]] = [
    ("fn {name}({params}) -> {rtype} {{\n    // {docstring}\n    ", "{expr}\n}}\n"),
    ("pub fn {name}({params}) -> {rtype} {{\n    // {docstring}\n    ", "{expr}\n}}\n"),
    (
        "struct {classname} {{\n    {attr}: {rtype},\n}}\n\nimpl {classname} {{\n    fn new({attr}: {rtype}) -> Self {{\n        ",
        "Self {{ {attr} }}\n    }}\n}}\n",
    ),
]

GO_EXAMPLES: list[tuple[str, str]] = [
    ("func {name}({params}) {rtype} {{\n    // {docstring}\n    ", "return {expr}\n}}\n"),
    (
        "type {classname} struct {{\n    {attr} {rtype}\n}}\n\nfunc New{classname}({attr} {rtype}) *{classname} {{\n    ",
        "return &{classname}{{{attr}: {attr}}}\n}}\n",
    ),
]

ALL_LANGS = [
    ("python", PYTHON_EXAMPLES),
    ("javascript", JS_EXAMPLES),
    ("typescript", TS_EXAMPLES),
    ("rust", RUST_EXAMPLES),
    ("go", GO_EXAMPLES),
]

# Value pools
FUNC_NAMES = [
    "compute",
    "calculate",
    "parse",
    "validate",
    "format",
    "transform",
    "merge",
    "split",
    "filter",
    "map",
    "reduce",
    "sort",
    "find",
    "group",
    "flatten",
    "chunk",
    "deduplicate",
    "normalize",
    "sanitize",
    "escape",
    "tokenize",
    "hash",
    "encrypt",
    "decrypt",
    "compress",
    "decompress",
    "serialize",
    "deserialize",
    "paginate",
    "retry",
]

CLASS_NAMES = [
    "User",
    "Account",
    "Transaction",
    "Session",
    "Config",
    "Logger",
    "Cache",
    "Database",
    "Queue",
    "Worker",
    "Task",
    "Event",
    "Handler",
    "Middleware",
    "Router",
    "Controller",
    "Service",
    "Repository",
    "Factory",
    "Builder",
    "Parser",
    "Generator",
    "Validator",
    "Tokenizer",
]

PARAMS_POOL = [
    "value",
    "items",
    "data",
    "input",
    "key",
    "threshold",
    "limit",
    "offset",
    "config",
    "options",
    "callback",
    "error",
    "message",
    "tag",
    "source",
    "target",
    "min_val",
    "max_val",
    "name",
    "size",
]

EXPR_POOL = [
    "result",
    "value * 2",
    "sum(values)",
    "len(items)",
    "max(values)",
    "min(values)",
    "sorted(items)",
    "reversed(items)",
    "list(set(items))",
    '"".join(items)',
    "items[:limit]",
    "data.get(key, default)",
    "config.merge(options)",
    "self.cache.get(key)",
]

DOC_POOL = [
    "Compute the result.",
    "Parse the input string.",
    "Validate the given data.",
    "Format the output.",
    "Transform items into a new structure.",
    "Merge two values together.",
    "Filter out invalid entries.",
    "Sort items in ascending order.",
    "Find the first matching element.",
    "Normalize the input values.",
    "Tokenize the text input.",
    "Hash the value securely.",
    "Encrypt the plaintext.",
    "Generate a unique identifier.",
    "Paginate through the dataset.",
]


def random_params() -> str:
    count = random.randint(1, 3)
    chosen = random.sample(PARAMS_POOL, count)
    return ", ".join(chosen)


def rtype_for_lang(lang: str) -> str:
    mapping = {
        "typescript": random.choice(["string", "number", "boolean", "string[]", "number[]", "void", "Promise<void>"]),
        "rust": random.choice(
            ["String", "i32", "u64", "bool", "Vec<String>", "Result<(), Box<dyn std::error::Error>>"]
        ),
        "go": random.choice(["string", "int", "bool", "[]string", "error", "interface{}"]),
    }
    return mapping.get(lang, "")


def fill_template(tmpl: str, lang: str) -> str:
    """Substitute template vars with random values."""
    tmpl.count("{") // 2  # rough, but fine
    subs = {
        "name": random.choice(FUNC_NAMES),
        "classname": random.choice(CLASS_NAMES),
        "params": random_params(),
        "docstring": random.choice(DOC_POOL),
        "method": random.choice(FUNC_NAMES),
        "method_doc": random.choice(DOC_POOL),
        "expr": random.choice(EXPR_POOL),
        "attr": random.choice(PARAMS_POOL),
        "rtype": rtype_for_lang(lang),
    }
    return tmpl.format(**subs)


def build_pair(lang: str, templates: list[tuple[str, str]]) -> dict:
    prompt_tmpl, comp_tmpl = random.choice(templates)
    prompt = fill_template(prompt_tmpl, lang)
    completion = fill_template(comp_tmpl, lang)
    return {"prompt": prompt, "completion": completion}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--output", default="finetune/data/train.jsonl")
    parser.add_argument("--eval-output", default="finetune/data/eval.jsonl")
    args = parser.parse_args()

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)

    items = []
    for _ in range(args.count):
        lang, templates = random.choice(ALL_LANGS)
        items.append(build_pair(lang, templates))

    # Shuffle for randomness
    random.shuffle(items)

    # Split 90/10 train/eval
    split = int(len(items) * 0.9)
    train, eval_data = items[:split], items[split:]

    with open(args.output, "w", encoding="utf-8") as f:
        for item in train:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(f"Train: {len(train)} examples -> {args.output}")

    with open(args.eval_output, "w", encoding="utf-8") as f:
        for item in eval_data:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(f"Eval: {len(eval_data)} examples -> {args.eval_output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
