import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

function createClient(context: vscode.ExtensionContext): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6020'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'emvus' }, { scheme: 'untitled', language: 'emvus' }],
    synchronize: { configurationSection: 'emvus' },
    outputChannelName: 'Emvus Language Server',
  };
  return new LanguageClient('emvus', 'Emvus Language Server', serverOptions, clientOptions);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = createClient(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('emvus.restartServer', async () => {
      await client?.stop();
      client = createClient(context);
      await client.start();
      vscode.window.setStatusBarMessage('Emvus language server restarted', 3000);
    }),
    vscode.commands.registerCommand('emvus.organizeImports', () => vscode.commands.executeCommand('editor.action.organizeImport')),
    vscode.commands.registerCommand('emvus.runChecker', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.document.languageId !== 'emvus') { vscode.window.showInformationMessage('Open an Emvus file first.'); return; }
      await ed.document.save();
      await client!.sendRequest('emvus/check', { uri: ed.document.uri.toString() });
    }),
  );
  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
