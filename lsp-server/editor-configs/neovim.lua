-- RINA AI LSP — Neovim configuration via nvim-lspconfig.
--
-- Drop this in your init.lua (or require it as a module). Prerequisites:
--   1. `npm install -g @siliconcorerina/rina-lsp-server`
--   2. export OPENAI_API_KEY=...  (or ANTHROPIC_API_KEY / MISTRAL_API_KEY / RINA_API_KEY)
--   3. nvim-lspconfig installed

local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

if not configs.rina_ai then
  configs.rina_ai = {
    default_config = {
      cmd = { "rina-lsp", "--stdio" },
      filetypes = {
        "python", "javascript", "typescript", "typescriptreact", "javascriptreact",
        "rust", "go", "java", "kotlin", "cpp", "c", "lua", "ruby", "php",
      },
      root_dir = lspconfig.util.find_git_ancestor,
      single_file_support = true,
      init_options = {
        backend = "openai:gpt-4o-mini",  -- change to your preferred backend
        language = "fr",                  -- "en" or "fr"
        completion = { enabled = true, trigger = "manual" },
        maxTokens = 1024,
        temperature = 0.2,
      },
    },
  }
end

lspconfig.rina_ai.setup({
  on_attach = function(_, bufnr)
    -- Bind code-action menu to <leader>ai in visual mode.
    vim.keymap.set("v", "<leader>ai", vim.lsp.buf.code_action,
      { buffer = bufnr, desc = "RINA AI: actions" })
  end,
})
