const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

// --- Helpers ---

function getWorkspaceFolder() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length ? folders[0].uri.fsPath : null;
}

function getRelativeFilePath(filePath, workspaceFolder) {
    let relativeFilePath = filePath.replace(workspaceFolder, '');
    relativeFilePath = relativeFilePath.replace(/\\/g, '/');
    return `.${relativeFilePath}`;
}

let tagfsExecutable = null;
let extensionInitialized = false;
let statusBarItem = null;

// Update status bar with tag count (module-level so features can call it)
async function updateTagCount() {
    const workspaceFolder = getWorkspaceFolder();
    if (!statusBarItem) return;
    const cfg = vscode.workspace.getConfiguration('tagfs');
    const configured = cfg.get('path');
    if (!configured || typeof configured !== 'string' || configured.trim() === '') {
        statusBarItem.text = 'HTFS: Not Configured';
        return;
    }
    if (!workspaceFolder) {
        statusBarItem.text = 'HTFS: Not Initialized';
        return;
    }
    try {
        const tags = await fetchTags(workspaceFolder);
        statusBarItem.text = `HTFS: ${tags.length} tags`;
    } catch (error) {
        statusBarItem.text = 'HTFS: Error';
    }
}

function execPromise(command, options = {}) {
    return new Promise((resolve, reject) => {
        const execOptions = { ...options };

        // Use login shell on Unix so user PATH is loaded
        if (process.platform === 'win32') execOptions.shell = 'cmd.exe';
        else execOptions.shell = '/usr/bin/bash';

        try {
            const cfg = vscode.workspace.getConfiguration('tagfs');
            const configured = cfg.get('path');
            if (configured && typeof configured === 'string' && configured.trim() !== '') {
                tagfsExecutable = configured.trim();
            }
        } catch (e) {
            vscode.window.showErrorMessage(`HTFS configuration error: ${e.message || e}`);
        }

        const customDir = tagfsExecutable ? path.dirname(tagfsExecutable) : '/linuxdev/github/HTFS/';
        execOptions.env = { ...process.env, PATH: `${customDir}:${process.env.PATH}` };

        exec(command, execOptions, (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve(stdout);
        });
    });
}

function showError(message) {
    vscode.window.showErrorMessage(`HTFS error: ${message}`);
}

async function getWorkspaceOrShowError() {
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) showError('No workspace folder found.');
    return workspaceFolder;
}

async function getActiveEditorOrShowError() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) showError('No active editor found.');
    return editor;
}

async function fetchTags(workspaceFolder) {
    const stdout = await execPromise('tagfs lstags', { cwd: workspaceFolder });
    return stdout.split('\n').filter(tag => tag.trim() !== '');
}

// Show a quick pick with tags and a "create new" option, returns the tag name or null
async function showQuickPickWithCreate(tags, placeHolder = 'Select or create a tag') {
    const quickPickItems = [
        ...tags.map(tag => ({ label: tag })),
        { label: '$(plus) Create new tag...', alwaysShow: true }
    ];
    const selected = await vscode.window.showQuickPick(quickPickItems, { placeHolder });
    if (!selected) return null;
    if (selected.label === '$(plus) Create new tag...') {
        const newTag = await vscode.window.showInputBox({ prompt: 'Enter new tag name' });
        if (newTag && !tags.includes(newTag)) {
            //create new tag in tagfs
            try {
                await execPromise(`tagfs addtags ${newTag}`, { cwd: getWorkspaceFolder() });
                vscode.window.showInformationMessage(`Created new tag: ${newTag}`);
            } catch (error) {
                showError(error);
            }
            return newTag;
        }
        if (newTag) return newTag; // Even if duplicate, allow tagging
        return null;
    }
    return selected.label;
}

// --- Commands ---

// function to initialize the tagfs
async function tagfsInit() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    try {
        const stdout = await execPromise('tagfs init', { cwd: workspaceFolder });
        vscode.window.showInformationMessage(`${stdout}`);
    } catch (error) {
        showError(error);
    }
}

async function tagfsListTags() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    try {
        const tags = await fetchTags(workspaceFolder);
        const selectedTag = await vscode.window.showQuickPick(tags, { placeHolder: 'Select a tag' });
        if (selectedTag) vscode.window.showInformationMessage(`Selected tag: ${selectedTag}`);
    } catch (error) {
        showError(error);
    }
}

async function tagfsAddTag() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const tagName = await vscode.window.showInputBox({ prompt: 'Enter tag name' });
    if (!tagName) return;
    try {
        const stdout = await execPromise(`tagfs addtags ${tagName}`, { cwd: workspaceFolder });
        vscode.window.showInformationMessage(`${stdout}`);
    } catch (error) {
        showError(error);
    }
}

// Add a tag to a file resource
async function tagFileWithTag(workspaceFolder, relativeFilePath, tagName) {
    try {
        await execPromise(`tagfs addresource ${relativeFilePath}`, { cwd: workspaceFolder });
        await execPromise(`tagfs tagresource ${relativeFilePath} ${tagName}`, { cwd: workspaceFolder });
        vscode.window.showInformationMessage(`Tagged file: ${relativeFilePath} with tag: ${tagName}`);
    } catch (error) {
        showError(error);
    }
}

// Remove a tag from a file resource
async function untagFileWithTag(workspaceFolder, relativeFilePath, tagName) {
    try {
        await execPromise(`tagfs untagresource ${relativeFilePath} ${tagName}`, { cwd: workspaceFolder });
        vscode.window.showInformationMessage(`Removed tag: ${tagName} from file: ${relativeFilePath}`);
    } catch (error) {
        showError(error);
    }
}

async function tagfsSearchByTag() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const tagExpr = await vscode.window.showInputBox({ prompt: 'Enter tag expr:' });
    if (!tagExpr) return;
    try {
        const stdout = await execPromise(`tagfs lsresources ${tagExpr}`, { cwd: workspaceFolder });
        const files = stdout.split('\n').filter(file => file.trim() !== '');
        const selectedFile = await vscode.window.showQuickPick(files, { placeHolder: 'Select a file' });
        if (selectedFile) {
            const cleanFile = selectedFile.replace(/\r?\n|\r/g, '');
            const doc = await vscode.workspace.openTextDocument(cleanFile);
            vscode.window.showTextDocument(doc);
        }
    } catch (error) {
        showError(error);
    }
}

async function tagfsGetTagsForFile() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const editor = await getActiveEditorOrShowError();
    if (!editor) return;
    const filePath = editor.document.fileName;
    const relativeFilePath = getRelativeFilePath(filePath, workspaceFolder);

    try {
        const stdout = await execPromise(`tagfs getresourcetags ${relativeFilePath}`, { cwd: workspaceFolder });
        const tags = stdout.split('\n').filter(tag => tag.trim() !== '');
        const selectedTag = await vscode.window.showQuickPick(tags, { placeHolder: 'File tags' });       
    } catch (error) {
        showError(error);
    }
}

async function tagfsEditFileTags() {
    const workspaceFolder = await getWorkspaceOrShowError();
    if (!workspaceFolder) return;
    const editor = await getActiveEditorOrShowError();
    if (!editor) return;
    const filePath = editor.document.fileName;
    const relativeFilePath = getRelativeFilePath(filePath, workspaceFolder);

    const action = await vscode.window.showQuickPick(['Add Tag', 'Remove Tag'], { placeHolder: 'What do you want to do?' });
    if (!action) return;

    if (action === 'Add Tag') {
        try {
            const tags = await fetchTags(workspaceFolder);
            const tagName = await showQuickPickWithCreate(tags, 'Select or create a tag');
            if (!tagName) return;

            // If tag doesn't exist, add it
            if (!tags.includes(tagName)) {
                try {
                    const stdout = await execPromise(`tagfs addtags ${tagName}`, { cwd: workspaceFolder });
                    vscode.window.showInformationMessage(`${stdout}`);
                } catch (error) {
                    showError(error);
                    return;
                }
            }
            await tagFileWithTag(workspaceFolder, relativeFilePath, tagName);
        } catch (error) {
            showError(error);
        }
    } else if (action === 'Remove Tag') {
        try {
            const stdout = await execPromise(`tagfs getresourcetags ${relativeFilePath}`, { cwd: workspaceFolder });
            const tags = stdout.split('\n').filter(tag => tag.trim() !== '');
            if (tags.length === 0) {
                vscode.window.showInformationMessage('No tags to remove from this file.');
                return;
            }
            const selectedTag = await vscode.window.showQuickPick(tags, { placeHolder: 'Select a tag to remove' });
            if (!selectedTag) return;
            // Use the new helper here:
            await untagFileWithTag(workspaceFolder, relativeFilePath, selectedTag);
        } catch (error) {
            showError(error);
        }
    }
}

// -- Webview for showing tags ---
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
        const stdout = await execPromise(`tagfs getresourcetags ${relativeFilePath}`, { cwd: workspaceFolder });
        tags = stdout.split('\n').filter(tag => tag.trim() !== '');
    } catch (error) {
        tags = ['(Error fetching tags)'];
    }

    const panel = vscode.window.createWebviewPanel(
        'tagfsTagsPanel',
        `Tags: ${editor.document.fileName.split(/[\\/]/).pop()}`,
        vscode.ViewColumn.Beside,
        {}
    );

    panel.webview.html = getTagsPanelHtml(tags, editor.document.fileName);
}

function getTagsPanelHtml(tags, filename) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: sans-serif; padding: 1em; }
                h2 { margin-top: 0; }
                ul { padding-left: 1.2em; }
                .tag { background: #eee; border-radius: 4px; padding: 2px 8px; margin: 2px; display: inline-block; }
            </style>
        </head>
        <body>
            <h2>Tags for <code>${filename.split(/[\\/]/).pop()}</code></h2>
            <ul>
                ${tags.length ? tags.map(tag => `<li class="tag">${tag}</li>`).join('') : '<li>No tags</li>'}
            </ul>
        </body>
        </html>
    `;
}




// --- Tag decoration setup ---
const tagDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        color: new vscode.ThemeColor('descriptionForeground'),
        margin: '0 0 0 1em',
    },
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
});

async function updateTagDecorations(editor) {
    if (!editor) return;
    const workspaceFolder = getWorkspaceFolder();
    if (!workspaceFolder) return;
    const relativeFilePath = getRelativeFilePath(editor.document.fileName, workspaceFolder);
    try {
        const stdout = await execPromise(`tagfs getresourcetags ${relativeFilePath}`, { cwd: workspaceFolder });
        const tags = stdout.split('\n').filter(tag => tag.trim() !== '');
        if (tags.length === 0) {
            editor.setDecorations(tagDecorationType, []);
            return;
        }
        const decoration = {
            range: new vscode.Range(0, 0, 0, 0),
            renderOptions: {
                after: {
                    contentText: `🏷️ ${tags.join(', ')}`
                }
            }
        };
        editor.setDecorations(tagDecorationType, [decoration]);
    } catch {
        editor.setDecorations(tagDecorationType, []);
    }
}

// --- CodeLens ---

class TagFsCodeLensProvider {
    async provideCodeLenses(document, token) {
        const workspaceFolder = getWorkspaceFolder();
        if (!workspaceFolder) return [];
        const relativeFilePath = getRelativeFilePath(document.fileName, workspaceFolder);
        try {
            const stdout = await execPromise(`tagfs getresourcetags ${relativeFilePath}`, { cwd: workspaceFolder });
            const tags = stdout.split('\n').filter(tag => tag.trim() !== '');
            if (tags.length === 0) return [];
            return [
                new vscode.CodeLens(
                    new vscode.Range(0, 0, 0, 0),
                    {
                        title: `🏷️ ${tags.join(', ')}`,
                        command: ''
                    }
                )
            ];
        } catch {
            return [];
        }
    }
}

// --- Commands Registration ---

function registerCommands(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.init', tagfsInit),
        vscode.commands.registerCommand('tagfs.listtags', tagfsListTags),
        vscode.commands.registerCommand('tagfs.addtag', tagfsAddTag),
        vscode.commands.registerCommand('tagfs.searchbytag', tagfsSearchByTag),
        vscode.commands.registerCommand('tagfs.editfiletags', tagfsEditFileTags),
        vscode.commands.registerCommand('tagfs.showfiletags', tagfsGetTagsForFile),
    );
}

// Register the configuration command separately (always available)
function registerConfigCommand(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.setPath', async () => {
            const cfg = vscode.workspace.getConfiguration('tagfs');
            const current = cfg.get('path') || '';
            const input = await vscode.window.showInputBox({
                prompt: 'Enter full path to tagfs executable',
                value: current
            });
            if (!input) return;
            try {
                await cfg.update('path', input.trim(), vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage('HTFS path saved. Reloading extension features...');
                // After setting, attempt to initialize features
                tryInitFeatures(context);
            } catch (e) {
                showError(e.message || e);
            }
        })
    );
}

async function tryInitFeatures(context) {
    if (extensionInitialized) return;
    const cfg = vscode.workspace.getConfiguration('tagfs');
    const configured = cfg.get('path');
    if (!configured || typeof configured !== 'string' || configured.trim() === '') {
        // not configured yet
        return;
    }
    tagfsExecutable = configured.trim();
    // safe-guard: mark initialized before registering to avoid dupes
    extensionInitialized = true;

    // Register the rest of commands and providers
    registerCommands(context);

    // Register completion provider and related command only after configuration provided
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', language: '*' },
        {
            async provideCompletionItems(document, position) {
                const line = document.lineAt(position).text;
                const before = line.substring(0, position.character);

                // Debug: log what the provider sees
                //console.log(`[tagfs] provideCompletionItems before='${before}'`);

                // Only show after double-hash
                if (!before.endsWith('##')) return [];

                const workspaceFolder = getWorkspaceFolder();
                if (!workspaceFolder) return [];

                let tags = [];
                try {
                    tags = await fetchTags(workspaceFolder);
                } catch (e) {
                    console.error('[tagfs] Error fetching tags:', e);
                    tags = [];
                }

                // Create range to replace the '##' we just typed
                const startPos = position.translate(0, -2);
                const range = new vscode.Range(startPos, position);

                const items = tags.map(tag => {
                    const item = new vscode.CompletionItem(tag, vscode.CompletionItemKind.Text);
                    // Insert '##tag' replacing the '##'
                    item.insertText = tag;
                    item.filterText = `##${tag}`;
                    item.range = range;
                    item.command = { command: 'tagfs.applyTagFromCompletion', title: 'Apply Tag', arguments: [tag] };
                    return item;
                });

                // If no tags available, provide a helpful placeholder so popup appears for debugging
                if (items.length === 0) {
                    const placeholder = new vscode.CompletionItem('(no tags found)', vscode.CompletionItemKind.Text);
                    placeholder.insertText = '##';
                    placeholder.range = range;
                    return new vscode.CompletionList([placeholder], false);
                }

                //console.log(`[tagfs] returning ${items.length} completion items`);
                return new vscode.CompletionList(items, false);
            }
        },
        '#', '#'
    );

    context.subscriptions.push(completionProvider);

    // Command triggered after a completion is accepted to tag the current file
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.applyTagFromCompletion', async (tagName) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const workspaceFolder = getWorkspaceFolder();
            if (!workspaceFolder) return;
            const relativeFilePath = getRelativeFilePath(editor.document.fileName, workspaceFolder);
            try {
                await tagFileWithTag(workspaceFolder, relativeFilePath, tagName);
                //updateTagDecorations(editor);
                await updateTagCount();
            } catch (e) {
                // errors already handled by helpers
            }
        })
    );

    // Update on active editor change
    vscode.window.onDidChangeActiveTextEditor(updateTagCount, null, context.subscriptions);

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new TagFsCodeLensProvider())
    );

    // Re-create any UI that depends on tagfs
    //try {
    //    // Update status quickly
    //    const editor = vscode.window.activeTextEditor;
    //    if (editor) await updateTagDecorations(editor);
    //} catch {}
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Congratulations, your extension "tagfs" is now active!');

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = 'HTFS: Loading...';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Don't enable features until user provides `tagfs.path` in settings.
    // Register only the configuration command so user can set the path.
    registerConfigCommand(context);

    // Attempt to initialize features now if configuration exists
    tryInitFeatures(context);

    // Update initial status
    updateTagCount();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};