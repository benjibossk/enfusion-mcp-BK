# Local changes (steffenbk fork, patched on this machine)

## 2026-11-19 — unattended Workbench dialogs
- `wb_compile`: `discardSavePrompt` (bool) replaced by `savePrompt: "save" | "discard" | "leave"` (default **save**).
  `discardSavePrompt` kept as a deprecated alias (true = discard, false = leave). Buttons matched by label,
  English or French (Yes/Oui/Save/Enregistrer, No/Non/Don't save/Ne pas enregistrer).
- New tool `wb_dismiss_dialogs { savePrompt = "save", watchMs = 0 }`: scans the Workbench process's
  top-level #32770 dialogs. Save prompt -> savePrompt; assertion / "Resources are leaking!" -> Ignore;
  single OK/Close box -> click; anything else left open. Reports title, text, buttons, button clicked.
  Does not use the NET API. Never handles crash reporters, never kills processes.
- `src/utils/wb-dialogs.ts`: shared scanner + `withDialogDismissal()` helper, used by `wb_save` and
  `wb_open_resource` (both gain a `savePrompt` option, default save) and list the dialogs they handled.
- Needs an MCP restart to take effect.
