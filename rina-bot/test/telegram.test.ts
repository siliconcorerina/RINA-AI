/**
 * Tests for the Telegram channel adapter.
 *
 * We don't hit the real Telegram API — that would need a live token
 * and rate-limit us. Instead we test the pure helpers
 * (updateToIncoming, chunkText) and the token validation in the
 * adapter constructor.
 */

import { describe, expect, test } from "vitest";
import { TelegramAdapter, chunkText, updateToIncoming } from "../src/channels/telegram.js";

describe("TelegramAdapter constructor", () => {
  test("accepts a well-formed token", () => {
    expect(() => new TelegramAdapter("123456789:ABC-DEF1234ghIkl_zyx57W2v1u123ew11")).not.toThrow();
  });

  test("rejects an empty / obviously-wrong token", () => {
    expect(() => new TelegramAdapter("")).toThrow(/doesn't look right/i);
    expect(() => new TelegramAdapter("not-a-token")).toThrow(/doesn't look right/i);
    expect(() => new TelegramAdapter("123456:short")).toThrow(/doesn't look right/i);
  });
});

describe("updateToIncoming", () => {
  test("extracts text + chat + user from a typical update", () => {
    const msg = updateToIncoming({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 12345, type: "private" },
        from: { id: 99, username: "alice" },
        text: "hello",
      },
    });
    expect(msg).toEqual({
      chatId: "12345",
      userId: "99",
      userDisplay: "alice",
      text: "hello",
    });
  });

  test("falls back to first_name when username is missing", () => {
    const msg = updateToIncoming({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 12345, type: "private" },
        from: { id: 99, first_name: "Bob" },
        text: "hi",
      },
    });
    expect(msg?.userDisplay).toBe("Bob");
  });

  test("returns null for updates without a message body", () => {
    expect(updateToIncoming({ update_id: 1 })).toBeNull();
  });

  test("returns null when the message has no text (e.g. photo, sticker)", () => {
    const msg = updateToIncoming({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        // text omitted on purpose
      },
    });
    expect(msg).toBeNull();
  });
});

describe("chunkText", () => {
  test("returns one chunk when under the limit", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  test("splits long text into multiple chunks", () => {
    const long = "a".repeat(250);
    const chunks = chunkText(long, 100);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(long);
  });

  test("prefers line boundaries when they fall in the back half of the window", () => {
    const text = "a".repeat(60) + "\n" + "b".repeat(60);
    const chunks = chunkText(text, 80);
    expect(chunks[0]).toBe("a".repeat(60));
    expect(chunks[1]).toBe("\n" + "b".repeat(60));
  });

  test("falls back to a hard cut when no nearby newline exists", () => {
    const text = "x".repeat(150);
    const chunks = chunkText(text, 50);
    expect(chunks[0].length).toBe(50);
    expect(chunks.join("")).toBe(text);
  });
});
