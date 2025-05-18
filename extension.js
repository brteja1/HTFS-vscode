const vscode = require('vscode');
const { exec } = require('child_process');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    let disposable = vscode.commands.registerCommand('tagfs.helloWorld', function () {
        // Example: Run a TagFS CLI command and show output
        exec('tagfs listtags', (err, stdout, stderr) => {
            if (err) {
                vscode.window.showErrorMessage(`TagFS error: ${stderr || err.message}`);
                return;
            }
            vscode.window.showInformationMessage(`TagFS tags:\n${stdout}`);
        });
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};