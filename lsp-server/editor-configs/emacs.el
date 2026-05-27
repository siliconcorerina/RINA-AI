;;; rina-ai.el --- RINA AI LSP integration for Emacs -*- lexical-binding: t; -*-
;;
;; Author: Silicon Core <hello@plateforme-rina.com>
;; URL: https://github.com/siliconcorerina/RINA-AI
;; Package-Requires: ((emacs "27.1"))
;; License: MIT
;;
;;; Commentary:
;;
;; Drop this file in your load-path and `(require 'rina-ai)` from your init.el,
;; or copy the relevant block directly into your config.
;;
;; Prerequisites:
;;   1. `npm install -g @siliconcore/rina-lsp-server` (provides `rina-lsp` binary)
;;   2. export OPENAI_API_KEY=... (or ANTHROPIC_API_KEY / MISTRAL_API_KEY / RINA_API_KEY)
;;
;; Two flavours below — pick the one matching your LSP client.
;;
;;; Code:

;; ─── Variant 1: lsp-mode ───────────────────────────────────────────

(with-eval-after-load 'lsp-mode
  (lsp-register-client
   (make-lsp-client
    :new-connection (lsp-stdio-connection '("rina-lsp" "--stdio"))
    :activation-fn (lsp-activate-on
                    "python" "javascript" "typescript"
                    "rust" "go" "java" "ruby")
    :server-id 'rina-ai
    :initialization-options
    (lambda ()
      '(:backend "openai:gpt-4o-mini"
        :language "fr"
        :completion (:enabled t :trigger "manual")
        :maxTokens 1024
        :temperature 0.2))
    ;; Negative priority so rina-ai cohabits with the primary LSP
    ;; (pyright, tsserver, gopls, ...) instead of stealing focus.
    :priority -1)))

;; Invoke with: M-x lsp-execute-code-action

;; ─── Variant 2: eglot ──────────────────────────────────────────────

(with-eval-after-load 'eglot
  (add-to-list
   'eglot-server-programs
   '((python-mode typescript-mode js-mode rust-mode go-mode ruby-mode)
     . ("rina-lsp" "--stdio"
        :initializationOptions
        (:backend "openai:gpt-4o-mini"
         :language "fr"
         :completion (:enabled t :trigger "manual")
         :maxTokens 1024
         :temperature 0.2)))))

;; Invoke with: M-x eglot-code-actions

(provide 'rina-ai)
;;; rina-ai.el ends here
