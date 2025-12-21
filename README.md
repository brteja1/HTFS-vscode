# HTFS VS Code Extension

VS Code integration for [HTFS](https://github.com/brteja1/HTFS) (Hierarchical Tagging File System). This extension lets you manage hierarchical tags for workspace files using the `tagfs` CLI from inside VS Code.

## Key features
- Register and manage tags (`tagfs init`, `addtags`, `lstags`)
- Add/remove tags from the active file
- Search files by tag expressions
- Show file tags in a webview and inline decorations
- Completion provider: type `##` then pick a tag to insert and apply it to the current file
- Link tags (creates parent-child relationships) via `tagfs.linktags`

## Requirements
- `tagfs` CLI must be installed and reachable. Configure its path in the workspace settings `tagfs.path` if it's not on system standard PATH.


Common commands (Command Palette)
- `HTFS: Initialize` — run `tagfs init` in the workspace
- `HTFS: Show All Tags` — list all tags (`tagfs lstags`)
- `HTFS: Add New Tag` — create a new tag (`tagfs addtags`)
- `HTFS: Add/Remove Tags to File` — edit tags on the active file
- `HTFS: Search for Files with Tags` — run `tagfs lsresources <expr>` and open selected file
- `HTFS: Link Tags` — link an existing tag to a parent tag (`tagfs linktags`)
- `HTFS: Show Tags for File` — quick view tags on the active file
- `HTFS: Set tagfs path` — save `tagfs.path` workspace setting

Decoration & completion notes
- Type `##` in any file to trigger tag completion and apply the selected tag to the current file.
- Inline decorations and a tags webview display file tags. The default decorations are configurable in code.


License
- See [LICENSE](https://github.com/brteja1/HTFS-vscode/blob/main/LICENSE) in repository root.

Acknowledgments
- This project was originally scaffolded with help from AI tools and iteratively refined.

