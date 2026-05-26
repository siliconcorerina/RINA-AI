"""Chat multi-tour avec un modele RINA AI au format messages.

Usage:
    python demo/chat_example.py
    python demo/chat_example.py --model siliconcorerina/rina-coder-instruct --stream

Commandes au prompt :
    :reset   reinitialise l historique
    :system <msg>   redefinit le message systeme
    :quit    sort
"""
from __future__ import annotations

import argparse
import sys

DEFAULT_SYSTEM = (
    "Tu es RINA Coder, un assistant specialise dans la generation et "
    "l explication de code. Reponds de maniere concise et avec du code "
    "fonctionnel quand c'est pertinent."
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Chat multi-tour RINA AI")
    p.add_argument("--model", default="siliconcorerina/rina-coder-base")
    p.add_argument("--system", default=DEFAULT_SYSTEM)
    p.add_argument("--max-new-tokens", type=int, default=512)
    p.add_argument("--temperature", type=float, default=0.4)
    p.add_argument("--stream", action="store_true")
    p.add_argument("--device", default="auto")
    return p.parse_args()


def render_reply(model, tokenizer, messages: list[dict], args) -> str:
    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = tokenizer(text, return_tensors="pt").to(model.device)

    if args.stream:
        try:
            from transformers import TextIteratorStreamer
        except ImportError:
            return _generate_blocking(model, tokenizer, inputs, args)

        from threading import Thread

        streamer = TextIteratorStreamer(tokenizer, skip_prompt=True, skip_special_tokens=True)
        kwargs = dict(
            **inputs,
            max_new_tokens=args.max_new_tokens,
            temperature=args.temperature,
            do_sample=args.temperature > 0,
            pad_token_id=tokenizer.eos_token_id,
            streamer=streamer,
        )
        thread = Thread(target=model.generate, kwargs=kwargs)
        thread.start()

        collected: list[str] = []
        for token in streamer:
            sys.stdout.write(token)
            sys.stdout.flush()
            collected.append(token)
        thread.join()
        print()
        return "".join(collected)

    return _generate_blocking(model, tokenizer, inputs, args)


def _generate_blocking(model, tokenizer, inputs, args) -> str:
    outputs = model.generate(
        **inputs,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        do_sample=args.temperature > 0,
        pad_token_id=tokenizer.eos_token_id,
    )
    reply = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1]:],
        skip_special_tokens=True,
    )
    print(reply)
    return reply


def main() -> int:
    args = parse_args()

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        print("Manquant : pip install -r requirements.txt", file=sys.stderr)
        return 1

    print(f"[RINA AI Chat] Modele : {args.model}")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, device_map=args.device)

    messages: list[dict] = [{"role": "system", "content": args.system}]
    print("Tape ':quit' pour sortir, ':reset' pour effacer l'historique.\n")

    while True:
        try:
            user = input("Toi> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if not user:
            continue
        if user == ":quit":
            return 0
        if user == ":reset":
            messages = [{"role": "system", "content": args.system}]
            print("[historique efface]")
            continue
        if user.startswith(":system "):
            args.system = user[len(":system "):].strip()
            messages = [{"role": "system", "content": args.system}]
            print("[message systeme mis a jour]")
            continue

        messages.append({"role": "user", "content": user})
        print("RINA> ", end="" if args.stream else "\n", flush=True)
        reply = render_reply(model, tokenizer, messages, args)
        messages.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    raise SystemExit(main())
