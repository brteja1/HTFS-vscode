const vscode = require('vscode');
const { exec } = require('child_process');

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

function execPromise(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, options, (err, stdout, stderr) => {
            if (err) reject(stderr || err.message);
            else resolve(stdout);
        });
    });
}

function showError(message) {
    vscode.window.showErrorMessage(`TagFS error: ${message}`);
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

// --- Registration ---

function registerCommands(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand('tagfs.init', tagfsInit),
        vscode.commands.registerCommand('tagfs.listtags', tagfsListTags),
        vscode.commands.registerCommand('tagfs.addtag', tagfsAddTag),
        vscode.commands.registerCommand('tagfs.searchbytag', tagfsSearchByTag),
        vscode.commands.registerCommand('tagfs.editfiletags', tagfsEditFileTags),
        vscode.commands.registerCommand('tagfs.showfiletags', tagfsGetTagsForFile)
    );
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Congratulations, your extension "tagfs" is now active!');
    exec('tagfs help', (err, stdout, stderr) => {
        if (err) {
            showError(stderr || err.message);
            return;
        }
        vscode.window.showInformationMessage(`TagFS version: 1.0.0`);
    });
    registerCommands(context);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};