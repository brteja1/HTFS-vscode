const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const CONFIG = {
    NAMESPACE: 'tagfs',
    SETTING_PATH: 'path',
    DEFAULT_FALLBACK_DIR: '/linuxdev/github/HTFS/',
    STATUS_BAR_POSITION: vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY: 100,
};

const STATUS_MESSAGES = {
    NOT_CONFIGURED: 'HTFS: Not Configured',
    NOT_INITIALIZED: 'HTFS: Not Initialized',
    ERROR: 'HTFS: Error',
    LOADING: 'HTFS: Loading...',
};

const TAG_MARKER = '#'
const COMPLETION_TRIGGER = '##';
const TAG_DECORATION_EMOJI = '🏷';

// ============================================================================
// GLOBAL STATE
// ============================================================================

let tagfsExecutable = null;
let extensionInitialized = false;
let statusBarItem = null;
let cachedTags = null;
let execQueue = Promise.resolve();
let cachedFileTags = new Map();

// ============================================================================
// UTILITY HELPERS
// ============================================================================

/**
 * Get the first workspace folder's path
 */
function getWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

/**
 * Convert absolute file path to relative path with dot prefix
 */
function getRelativeFilePath(filePath, workspaceFolder) {
    let relativeFilePath = filePath.replace(workspaceFolder, '');
    relativeFilePath = relativeFilePath.replace(/\\/g, '/');
    return `.${relativeFilePath}`;
}

/**
 * Parse multiline CLI output into array of trimmed non-empty strings
 */
function parseOutputLines(output) {
    if (!output || typeof output !== 'string') return [];
    // Normalize CRLF and LF, trim each line and remove empty lines
    return output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
}

/**
 * Show error message to user
 */
function showError(message) {
    vscode.window.showErrorMessage(`HTFS error: ${message}`);
}

/**
 * Show info message to user
 */
function showInfo(message) {
    vscode.window.showInformationMessage(message);
}

/**
 * Get workspace folder or show error and return null
 */
async function getWorkspaceOrShowError() {
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) showError('No workspace folder found.');
    return workspaceFolder;
}

/**
 * Get active editor or show error and return null
 */
async function getActiveEditorOrShowError() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) showError('No active editor found.');
    return editor;
}

// ============================================================================
// TAGFS CLI EXECUTION
// ============================================================================

/**
 * Execute shell command with proper environment and platform configuration
 */
function execPromise(command, options = {}) {
    const result = execQueue.then(() => {
        return new Promise((resolve, reject) => {
            const execOptions = { ...options };

            // Use login shell on Unix so user PATH is loaded
            if (process.platform === 'win32') {
                execOptions.shell = 'cmd.exe';
            } else {
                execOptions.shell = '/usr/bin/bash';
            }

            try {
                const cfg = vscode.workspace.getConfiguration(CONFIG.NAMESPACE);
                const configured = cfg.get(CONFIG.SETTING_PATH);
                if (configured && typeof configured === 'string' && configured.trim() !== '') {
                    tagfsExecutable = configured.trim();
                }
            } catch (e) {
                showError(`Configuration error: ${e.message || e}`);
            }

            const customDir = tagfsExecutable ? path.dirname(tagfsExecutable) : CONFIG.DEFAULT_FALLBACK_DIR;
            execOptions.env = { ...process.env, PATH: `${customDir}:${process.env.PATH}` };

            console.log(command);

            exec(command, execOptions, (err, stdout, stderr) => {
                if (err) reject(stderr || err.message);
                else resolve(stdout);
            });
        });
    });
    execQueue = result.catch(() => {}); // Continue chain even on error
    return result;
}

/**
 * Fetch all tags from workspace (with caching)
 */
async function fetchTags(workspaceFolder) {
    if (cachedTags) return cachedTags;
    const stdout = await execPromise('tagfs lstags', { cwd: workspaceFolder });
    cachedTags = parseOutputLines(stdout);
    return cachedTags;
}

// ============================================================================
// UI HELPERS
// ============================================================================

/**
 * Show quick pick with existing tags and option to create new tag
 */
async function showQuickPickWithCreate(tags, placeHolder = 'Select or create a tag') {
    const quickPickItems = [
        ...tags.map(tag => ({ label: tag })),
        { label: '$(plus) Create new tag...', alwaysShow: true }
    ];
    const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder });
    if (!selected) return null;

    if (selected.label === '$(plus) Create new tag...') {
        const newTag = await vscode.window.showInputBox({ prompt: 'Enter new tag name' });
        if (!newTag) return null;

        // Create tag if it doesn't exist
        if (!tags.includes(newTag)) {
            try {
                await execPromise(`tagfs addtags ${newTag}`, { cwd: getWorkspaceFolder() });
                showInfo(`Created new tag: ${newTag}`);
            } catch (error) {
                showError(error);
            }
        }
        return newTag;
    }

    return selected.label;
}

// ============================================================================
// TAG OPERATIONS
// ============================================================================

/**
 * Add a tag to a file resource
 */
async function tagFileWithTag(workspaceFolder, relativeFilePath, tagName) {
    try {
        await execPromise(`tagfs addresource ${relativeFilePath}`, { cwd: workspaceFolder });
        await execPromise(`tagfs tagresource ${relativeFilePath} ${tagName}`, { cwd: workspaceFolder });
        showInfo(`Tagged file: ${relativeFilePath} with tag: ${tagName}`);
        cachedFileTags.delete(relativeFilePath); // Invalidate cache
        try { await _refreshAfterTagChange(workspaceFolder, relativeFilePath); } catch (e) {}
    } catch (error) {
        showError(error);
    }
}

/**
 * Simple debounce helper
 */
function debounce(fn, ms = 300) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

// Refresh UI after tagging
async function _refreshAfterTagChange(workspaceFolder, relativeFilePath) {
    try {
        await updateTagCount();
    } catch (e) {
        // ignore
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && getRelativeFilePath(editor.document.fileName, workspaceFolder) === relativeFilePath) {
        try { await updateTagDecorations(editor); } catch (e) { /* ignore */ }
    }
}

/**
 * Remove a tag from a file resource
 */
async function untagFileWithTag(workspaceFolder, relativeFilePath, tagName) {
    try {
        await execPromise(`tagfs untagresource ${relativeFilePath} ${tagName}`, { cwd: workspaceFolder });
        showInfo(`Removed tag: ${tagName} from file: ${relativeFilePath}`);
        cachedFileTags.delete(relativeFilePath); // Invalidate cache
        try { await _refreshAfterTagChange(workspaceFolder, relativeFilePath); } catch (e) {}
    } catch (error) {
        showError(error);
    }
}

/**
 * Get all tags for a file (with caching)
 */
async function getFileTags(workspaceFolder, relativeFilePath) {
    if (cachedFileTags.has(relativeFilePath)) {
        return cachedFileTags.get(relativeFilePath);
    }
    const stdout = await execPromise(`tagfs getresourcetags ${relativeFilePath}`, { cwd: workspaceFolder });
    const tags = parseOutputLines(stdout);
    cachedFileTags.set(relativeFilePath, tags);
    return tags;
}

/**
 * Update status bar with tag count for current file
 */
async function updateTagCount() {
    const workspaceFolder = getWorkspaceFolder();
    if (!statusBarItem) return;

    const cfg = vscode.workspace.getConfiguration(CONFIG.NAMESPACE);
    const configured = cfg.get(CONFIG.SETTING_PATH);
    if (!configured || typeof configured !== 'string' || configured.trim() === '') {
        statusBarItem.text = STATUS_MESSAGES.NOT_CONFIGURED;
        return;
    }

    if (!workspaceFolder) {
        statusBarItem.text = STATUS_MESSAGES.NOT_INITIALIZED;
        return;
    }

    try {
        const tags = await fetchTags(workspaceFolder);
        statusBarItem.text = `HTFS: ${tags.length} tags`;
    } catch (error) {
        statusBarItem.text = STATUS_MESSAGES.ERROR;
    }
}

// ============================================================================
// WORKSPACE COMMANDS
// ============================================================================

/**
 * Initialize HTFS in the current workspace
 */
async function tagfsInit() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    try {
        const stdout = await execPromise('tagfs init', { cwd: workspaceFolder });
        showInfo(stdout);
    } catch (error) {
        showError(error);
    }
}

/**
 * List all tags in the workspace
 */
async function tagfsListTags() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    try {
        const tags = await fetchTags(workspaceFolder);
        await vscode.window.showQuickPick(tags, { placeHolder: 'Select a tag' });
    } catch (error) {
        showError(error);
    }
}

/**
 * Create a new tag
 */
async function tagfsAddTag() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const tagName = await vscode.window.showInputBox({ prompt: 'Enter tag name' });
    if (!tagName) return;
    try {
        const stdout = await execPromise(`tagfs addtags ${tagName}`, { cwd: workspaceFolder });
        showInfo(stdout);
        cachedTags = null; // Invalidate cache
    } catch (error) {
        showError(error);
    }
}

/**
 * Search for files by tag expression
 */
async function tagfsSearchByTag(optionalTagExpr) {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;

    // If caller passes argument → use it; else → prompt the user
    const tagExpr =
        optionalTagExpr ||
        await vscode.window.showInputBox({
            prompt: 'Enter tag expression (e.g., "tag1 & ~tag2")'
        });

    if (!tagExpr) return;

    try {
        const stdout = await execPromise(`tagfs lsresources ${tagExpr}`, {
            cwd: workspaceFolder
        });

        const files = parseOutputLines(stdout);
        const selectedFile = await vscode.window.showQuickPick(files, {
            placeHolder: 'Select a file'
        });

        if (selectedFile) {
            const cleanFile = selectedFile.replace(/\r?\n|\r/g, '');
            const doc = await vscode.workspace.openTextDocument(cleanFile);
            await vscode.window.showTextDocument(doc);
        }
    } catch (error) {
        showError(error);
    }
}


/**
 * Link one tag to another tag as a parent
 */
async function tagfsLinkTags() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;

    try {
        const tags = await fetchTags(workspaceFolder);
        if (tags.length === 0) {
            showInfo('No tags avakilable to link.');
            return;
        }

        // Select the child tag
        const childTag = await vscode.window.showQuickPick(
            tags,
            { placeHolder: 'Select child tag' }
        );
        if (!childTag) return;

        // Select the parent tag
        const parentTag = await vscode.window.showQuickPick(
            tags.filter(tag => tag !== childTag),
            { placeHolder: 'Select parent tag' }
        );
        if (!parentTag) return;

        // Link the tags
        const stdout = await execPromise(`tagfs linktags ${childTag} ${parentTag}`, { cwd: workspaceFolder });
        showInfo(`Linked tag '${childTag}' to parent tag '${parentTag}'`);
    } catch (error) {
        showError(error);
    }
}

// ============================================================================
// FILE/EDITOR COMMANDS
// ============================================================================

/**
 * Show tags for the current file in a quick pick
 */
async function tagfsGetTagsForFile() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const editor = await getActiveEditorOrShowError();
    if (!editor) return;

    const filePath = editor.document.fileName;
    const relativeFilePath = getRelativeFilePath(filePath, workspaceFolder);

    try {
        const tags = await getFileTags(workspaceFolder, relativeFilePath);
        await vscode.window.showQuickPick(tags, { placeHolder: 'File tags' });
    } catch (error) {
        showError(error);
    }
}

/**
 * Add or remove tags from the current file
 */
async function tagfsEditFileTags() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const editor = await getActiveEditorOrShowError();
    if (!editor) return;

    const filePath = editor.document.fileName;
    const relativeFilePath = getRelativeFilePath(filePath, workspaceFolder);

    const action = await vscode.window.showQuickPick(
        ['Add Tag', 'Remove Tag'],
        { placeHolder: 'What do you want to do?' }
    );
    if (!action) return;

    if (action === 'Add Tag') {
        await handleAddTagToFile(workspaceFolder, relativeFilePath);
    } else {
        await handleRemoveTagFromFile(workspaceFolder, relativeFilePath);
    }
}

/**
 * Helper: Add tag to file with creation option
 */
async function handleAddTagToFile(workspaceFolder, relativeFilePath) {
    try {
        const tags = await fetchTags(workspaceFolder);
        const tagName = await showQuickPickWithCreate(tags, 'Select or create a tag');
        if (!tagName) return;

        // Create tag if it doesn't exist
        if (!tags.includes(tagName)) {
            try {
                const stdout = await execPromise(`tagfs addtags ${tagName}`, { cwd: workspaceFolder });
                showInfo(stdout);
                cachedTags = null; // Invalidate cache
            } catch (error) {
                showError(error);
                return;
            }
        }

        await tagFileWithTag(workspaceFolder, relativeFilePath, tagName);
    } catch (error) {
        showError(error);
    }
}

/**
 * Helper: Remove tag from file
 */
async function handleRemoveTagFromFile(workspaceFolder, relativeFilePath) {
    try {
        const tags = await getFileTags(workspaceFolder, relativeFilePath);
        if (tags.length === 0) {
            showInfo('No tags to remove from this file.');
            return;
        }

        const selectedTag = await vscode.window.showQuickPick(
            tags,
            { placeHolder: 'Select a tag to remove' }
        );
        if (!selectedTag) return;

        await untagFileWithTag(workspaceFolder, relativeFilePath, selectedTag);
    } catch (error) {
        showError(error);
    }
}

// ============================================================================
// WEBVIEW & UI FEATURES
// ============================================================================

/**
 * Show tags for current file in a webview panel
 */
async function showTagsWebviewPanel() {
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) {
        showError('No workspace folder found.');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        showError('No active editor found.');
        return;
    }

    const filePath = editor.document.fileName;
    const relativeFilePath = getRelativeFilePath(filePath, workspaceFolder);

    let tags = [];
    try {
        tags = await getFileTags(workspaceFolder, relativeFilePath);
    } catch (error) {
        tags = ['(Error fetching tags)'];
    }

    const filename = editor.document.fileName.split(/[\\/]/).pop();
    const panel = vscode.window.createWebviewPanel(
        'tagfsTagsPanel',
        `Tags: ${filename}`,
        vscode.ViewColumn.Beside,
        {}
    );

    panel.webview.html = getTagsPanelHtml(tags, filename);
}

/**
 * Generate HTML for tags webview panel
 */
function getTagsPanelHtml(tags, filename) {
    const tagItems = tags.length
        ? tags.map(tag => `<li class="tag">${tag}</li>`).join('')
        : '<li>No tags</li>';

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: sans-serif; padding: 1em; }
                h2 { margin-top: 0; }
                ul { padding-left: 1.2em; }
                .tag { 
                    background: #eee; 
                    border-radius: 4px; 
                    padding: 2px 8px; 
                    margin: 2px; 
                    display: inline-block; 
                }
            </style>
        </head>
        <body>
            <h2>Tags for <code>${filename}</code></h2>
            <ul>
                ${tagItems}
            </ul>
        </body>
        </html>
    `;
}

// ============================================================================
// DECORATIONS & CODELENS
// ============================================================================

const tagUnderlineDecorationType = vscode.window.createTextEditorDecorationType({
    // Add a small underline offset so the underline has some vertical padding
    // `text-underline-offset` provides the visual padding beneath the text
    textDecoration: 'underline; text-underline-offset: 3px',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});

/**
 * Escape string for use in RegExp
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

/**
 * Update inline underline decorations for every tag occurrence in the document
 */
async function updateTagDecorations(editor) {
    if (!editor || !editor.document) return;

    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) return;

    const relativeFilePath = getRelativeFilePath(editor.document.fileName, workspaceFolder);

    try {
        const tags = await getFileTags(workspaceFolder, relativeFilePath);
        if (!tags || tags.length === 0) {
            editor.setDecorations(tagUnderlineDecorationType, []);
            return;
        }

        const docText = editor.document.getText();
        const decorations = [];

        // For each tag, find every occurrence and add an underline decoration with hover
        for (const tag of tags) {
            if (!tag || typeof tag !== 'string') continue;
            const esc = '(?:^|[ \\n\\t])' + escapeRegExp(tag) + '(?:$|\\r?[ \\n\\t])';
            const re = new RegExp(esc, 'g');
            let match;
            while ((match = re.exec(docText)) !== null) {
                const fullMatch = match[0];
                const tagStartInMatch = fullMatch.indexOf(tag);
                const startOffset = match.index + tagStartInMatch;
                const endOffset = startOffset + tag.length;
                const startPos = editor.document.positionAt(startOffset);
                const endPos = editor.document.positionAt(endOffset);
                const range = new vscode.Range(startPos, endPos);                

                const searchCommandUri = vscode.Uri.parse(
                   `command:tagfs.searchbytag?${
                    encodeURIComponent(JSON.stringify([tag]))}`
                );

                const hoverString = new vscode.MarkdownString(                            
                    `[Search files with ${TAG_MARKER}${tag} tag](${searchCommandUri})`
                );                
                hoverString.isTrusted = true;

                const decoration = {
                    range,
                    hoverMessage: hoverString,
                    renderOptions: {
                        before: {
                            contentText: TAG_MARKER,
                            margin: '0 0.0em 0 0',
                            color: new vscode.ThemeColor('descriptionForeground')
                        }
                    },
                    backgroundColor: new vscode.ThemeColor('editorHoverWidget.background')
                };

                decorations.push(decoration);                
            }
        }

        editor.setDecorations(tagUnderlineDecorationType, decorations);
    } catch (e) {
        editor.setDecorations(tagUnderlineDecorationType, []);
    }
}

/**
 * Code lens provider for showing tags on the first line
 */
class TagFsCodeLensProvider {
    async provideCodeLenses(document, token) {
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder) return [];

        const relativeFilePath = getRelativeFilePath(document.fileName, workspaceFolder);

        try {
            const tags = await getFileTags(workspaceFolder, relativeFilePath);
            if (tags.length === 0) return [];

            return [
                new vscode.CodeLens(
                    new vscode.Range(0, 0, 0, 0),
                    {
                        title: `${TAG_DECORATION_EMOJI}: \{ #${tags.join(', #')} \}`,
                        command: ''
                    }
                )
            ];
        } catch {
            return [];
        }
    }
}

// ============================================================================
// COMMAND REGISTRATION
// ============================================================================

/**
 * Register all HTFS commands (called after configuration is set)
 */
function registerCommands(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.init', tagfsInit),
        vscode.commands.registerCommand('tagfs.listtags', tagfsListTags),
        vscode.commands.registerCommand('tagfs.addtag', tagfsAddTag),
        vscode.commands.registerCommand('tagfs.searchbytag', tagfsSearchByTag),
        vscode.commands.registerCommand('tagfs.linktags', tagfsLinkTags),
        vscode.commands.registerCommand('tagfs.editfiletags', tagfsEditFileTags),
        vscode.commands.registerCommand('tagfs.showfiletags', tagfsGetTagsForFile),
    );
}

/**
 * Register the configuration command (always available)
 */
function registerConfigCommand(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.setPath', async () => {
            const cfg = vscode.workspace.getConfiguration(CONFIG.NAMESPACE);
            const current = cfg.get(CONFIG.SETTING_PATH) || '';
            const input = await vscode.window.showInputBox({
                prompt: 'Enter full path to tagfs executable',
                value: current
            });
            if (!input) return;

            try {
                await cfg.update(CONFIG.SETTING_PATH, input.trim(), vscode.ConfigurationTarget.Workspace);
                showInfo('HTFS path saved. Reloading extension features...');
                tryInitFeatures(context);
            } catch (e) {
                showError(e.message || e);
            }
        })
    );
}

// ============================================================================
// EXTENSION INITIALIZATION
// ============================================================================

/**
 * Register completion provider for tag insertion with ## trigger
 */
function registerCompletionProvider(context) {
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: '*' },
        {
            async provideCompletionItems(document, position) {
                const line = document.lineAt(position).text;
                const before = line.substring(0, position.character);

                // Only show completions after double-hash trigger
                if (!before.endsWith(COMPLETION_TRIGGER)) return [];

                const workspaceFolder = getWorkspaceFolder();
                if (!workspaceFolder) return [];

                let tags = [];
                try {
                    tags = await fetchTags(workspaceFolder);
                } catch (e) {
                    console.error('[tagfs] Error fetching tags:', e);
                }

                // Create range to replace the trigger characters
                const startPos = position.translate(0, -COMPLETION_TRIGGER.length);
                const range = new vscode.Range(startPos, position);

                const items = tags.map(tag => {
                    const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Text);
                    item.insertText = tag;
                    item.filterText = `${COMPLETION_TRIGGER}${tag}`;
                    item.range = range;
                    item.command = {
                        command: 'tagfs.applyTagFromCompletion',
                        title: 'Apply Tag',
                        arguments: [tag]
                    };
                    return item;
                });

                if (items.length === 0) {
                    const placeholder = new vscode.CompletionItem('(no tags found)', vscode.CompletionItemKind.Text);
                    placeholder.insertText = COMPLETION_TRIGGER;
                    placeholder.range = range;
                    return new vscode.CompletionList([placeholder], false);
                }

                return new vscode.CompletionList(items, false);
            }
        },
        ...COMPLETION_TRIGGER.split('')  // Split trigger into individual chars
    );

    context.subscriptions.push(completionProvider);
}

/**
 * Register command to apply tag from completion
 */
function registerTagCompletionCommand(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.applyTagFromCompletion', async (tagName) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const workspaceFolder = getWorkspaceFolder();
            if (!workspaceFolder) return;

            const relativeFilePath = getRelativeFilePath(editor.document.fileName, workspaceFolder);
            try {
                await tagFileWithTag(workspaceFolder, relativeFilePath, tagName);
                await updateTagCount();
            } catch (e) {
                // Errors already handled by tagFileWithTag
            }
        })
    );
}

/**
 * Register event listeners for editor changes
 */
function registerEventListeners(context) {
    // Refresh decorations and status when active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            try { await updateTagCount(); } catch (e) {}
            try { await updateTagDecorations(editor); } catch (e) {}
        })
    );

    // Debounced document change -> refresh decorations for active editor
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(debounce((e) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) {
                try { updateTagDecorations(editor); } catch (e) {}
            }
        }, 300))
    );

    // CodeLens provider
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new TagFsCodeLensProvider())
    );

   
    vscode.workspace.onDidRenameFiles(async (event) => {
        for (const file of event.files) {
            const oldPath = file.oldUri.fsPath;
            const newPath = file.newUri.fsPath;

            // TODO: update your DB here
            await updateTagDatabaseOnRename(oldPath, newPath);
        }}
    );

    vscode.workspace.onDidDeleteFiles(async (event) => {
        for (const file of event.files) {
            const deletedPath = file.fsPath;
            
            await updateTagDatabaseOnDelete(deletedPath);
        }
    });

    // Invalidate file tag cache when document is closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            const workspaceFolder = getWorkspaceFolder();
            if (workspaceFolder) {
                const relativePath = getRelativeFilePath(document.fileName, workspaceFolder);
                cachedFileTags.delete(relativePath);
            }
        })
    );
}

/**
 * Function to update tag database on file delete
 */
async function updateTagDatabaseOnDelete(deletedPath) {
    try {
        // Example: call your CLI / internal DB update function
        const output = await execPromise(`tagfs rmresource ${deletedPath} false`, { cwd: getWorkspaceFolder() });
        showInfo(output);
        // Invalidate cache
        const workspaceFolder = getWorkspaceFolder();
        if (workspaceFolder) {
            const relativePath = getRelativeFilePath(deletedPath, workspaceFolder);
            cachedFileTags.delete(relativePath);
        }
    } catch (err) {
        vscode.window.showErrorMessage("Failed to update tag DB: " + err.message);
    }
}

/**
 * Function to update tag database on file rename
 */
async function updateTagDatabaseOnRename(oldPath, newPath) {
    try {
        // Example: call your CLI / internal DB update function
        const output = await execPromise(`tagfs mvresource ${oldPath} ${newPath} false`, { cwd: getWorkspaceFolder() });
        showInfo(output);
        // Invalidate cache for old path
        const workspaceFolder = getWorkspaceFolder();
        if (workspaceFolder) {
            const relativeOldPath = getRelativeFilePath(oldPath, workspaceFolder);
            cachedFileTags.delete(relativeOldPath);
        }
    } catch (err) {
        vscode.window.showErrorMessage("Failed to update tag DB: " + err.message);
    }
}

/**
 * Initialize features after configuration is provided
 */
async function tryInitFeatures(context) {
    if (extensionInitialized) return;

    const cfg = vscode.workspace.getConfiguration(CONFIG.NAMESPACE);
    const configured = cfg.get(CONFIG.SETTING_PATH);
    if (!configured || typeof configured !== 'string' || configured.trim() === '') {
        // Configuration not set yet
        return;
    }

    tagfsExecutable = configured.trim();
    extensionInitialized = true;  // Mark initialized before registering to avoid duplicates

    // Register all features
    registerCommands(context);
    registerCompletionProvider(context);
    registerTagCompletionCommand(context);
    registerEventListeners(context);
}

// ============================================================================
// EXTENSION ACTIVATION & DEACTIVATION
// ============================================================================

/**
 * Extension activation entry point
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('HTFS extension activated');

    // Create and show status bar item
    statusBarItem = vscode.window.createStatusBarItem(CONFIG.STATUS_BAR_POSITION, CONFIG.STATUS_BAR_PRIORITY);
    statusBarItem.text = STATUS_MESSAGES.LOADING;
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Register configuration command (always available)
    registerConfigCommand(context);

    // Attempt to initialize features if configuration already exists
    tryInitFeatures(context);

    // Update status bar
    updateTagCount();
    // Initial decorations for active editor
    try {
        const editor = vscode.window.activeTextEditor;
        if (editor) updateTagDecorations(editor);
    } catch (e) {}
}

/**
 * Extension deactivation entry point
 */
function deactivate() {}

module.exports = {
    activate,
    deactivate
};