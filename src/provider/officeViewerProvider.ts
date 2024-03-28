import { ZipService } from '@/service/zip/zipService';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, extname, parse, resolve } from 'path';
import { TextEncoder } from 'util';
import * as vscode from 'vscode';
import { Handler } from '../common/handler';
import { Output } from '../common/Output';
import { Util } from '../common/util';
import { ReactApp } from '@/common/reactApp';

/**
 * support view office files
 */
export class OfficeViewerProvider implements vscode.CustomReadonlyEditorProvider {

    private extensionPath: string;

    constructor(private context: vscode.ExtensionContext) {
        this.extensionPath = context.extensionPath;
    }

    public openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext, token: vscode.CancellationToken): vscode.CustomDocument | Thenable<vscode.CustomDocument> {
        return { uri, dispose: (): void => { } };
    }
    public resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void | Thenable<void> {
        const uri = document.uri;
        const webview = webviewPanel.webview;
        const folderPath = vscode.Uri.joinPath(uri, '..')
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(this.extensionPath), folderPath]
        }

        const ext = extname(uri.fsPath).toLowerCase()
        let htmlPath: string | null = null;


        const send = () => {
            handler.emit("open", {
                ext: extname(uri.fsPath),
                path: handler.panel.webview.asWebviewUri(uri).with({ query: `nonce=${Date.now().toString()}` }).toString(),
            })
        }

        let route: string;
        const handler = Handler.bind(webviewPanel, uri);
        handler
            .on("editInVSCode", (full: boolean) => {
                const side = full ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
                vscode.commands.executeCommand('vscode.openWith', uri, "default", side);
            })
            .on('developerTool', () => vscode.commands.executeCommand('workbench.action.toggleDevTools'))
            .on("init", send)

        if (ext.match(/\.(jpg|png|svg|gif|apng|bmp|ico|cur|jpeg|pjpeg|pjp|tif|webp)$/i)) {
            const sendImageList = () => {
                const images = this.handleImage(uri, webview)
                handler.emit("images", images)
            }
            handler.on('images', () => sendImageList())
            handler.on('fileChange', () => sendImageList())
            return ReactApp.view(webview, { route: 'image' })
        }

        switch (ext) {
            case ".xlsx":
            case ".xlsm":
            case ".xls":
            case ".csv":
            case ".ods":
                route = 'excel';
                this.handleXlsx(uri, handler)
                handler.on("fileChange", send)
                break;
            case ".docx":
            case ".dotx":
                htmlPath = 'word.html'
                handler.on("fileChange", send)
                break;
            case ".jar":
            case ".zip":
            case ".apk":
            case ".vsix":
                route = 'zip';
                this.handleZip(uri, handler);
                break;
            case ".pdf":
                this.handlePdf(webview);
                handler.on("fileChange", send)
                break;
            case ".ttf":
            case ".woff":
            case ".woff2":
            case ".otf":
                this.handleFont(handler)
                break;
            case ".class":
                this.handleClass(uri, webviewPanel);
                break;
            case ".htm":
            case ".html":
                webview.html = Util.buildPath(readFileSync(uri.fsPath, 'utf8'), webview, folderPath.fsPath);
                Util.listen(webviewPanel, uri, () => {
                    webviewPanel.webview.html = Util.buildPath(readFileSync(uri.fsPath, 'utf8'), webviewPanel.webview, folderPath.fsPath);
                })
                break;
            default:
                vscode.commands.executeCommand('vscode.openWith', uri, "default");
        }
        if (route) return ReactApp.view(webview, { route })

        if (htmlPath != null) {
            webview.html = Util.buildPath(readFileSync(this.extensionPath + "/resource/" + htmlPath, 'utf8'), webview, this.extensionPath + "/resource")
        }

    }

    async handleZip(uri: vscode.Uri, handler: Handler) {
        new ZipService(uri, handler).bind();
    }

    private handleImage(uri: vscode.Uri, webview: vscode.Webview) {
        if (uri.scheme != 'file') {
            const href = webview.asWebviewUri(uri);
            return [{
                src: href,
                title: basename(uri.fsPath)
            }]
        }
        const folderPath = vscode.Uri.file(resolve(uri.fsPath, ".."));
        const files = readdirSync(folderPath.fsPath)
        let current = 0;
        const currentFile = basename(uri.fsPath)
        const images = files.filter(file => file.match(/\.(jpg|png|svg|gif|apng|bmp|ico|cur|jpeg|pjpeg|pjp|tif|webp)$/i))
            .map((file, i) => {
                if (currentFile == file) current = i;
                const resUri = vscode.Uri.file(`${folderPath.fsPath}/${file}`);
                const resource = webview.asWebviewUri(resUri).with({ query: `nonce=${Date.now().toString()}` }).toString();
                return {
                    src: resource,
                    title: basename(uri.fsPath)
                }
            })
        return { images, current };
    }


    private handlePdf(webview: vscode.Webview) {
        const baseUrl = this.getBaseUrl(webview, 'pdf')
        webview.html = readFileSync(this.extensionPath + "/resource/pdf/viewer.html", 'utf8').replace("{{baseUrl}}", baseUrl)
    }

    private handleFont(handler: Handler) {
        const webview = handler.panel.webview;
        const baseUrl = this.getBaseUrl(webview, 'font')
        webview.html = readFileSync(`${this.extensionPath}/resource/font/index.html`, 'utf8')
            .replace('{{baseUrl}}', baseUrl)
    }

    private getBaseUrl(webview: vscode.Webview, path: string) {
        const baseUrl = webview.asWebviewUri(vscode.Uri.file(`${this.extensionPath}/resource/${path}`))
            .toString().replace(/\?.+$/, '').replace('https://git', 'https://file')
        return baseUrl;
    }

    private handleXlsx(uri: vscode.Uri, handler: Handler) {
        const enc = new TextEncoder();
        handler.on("save", async (content) => {
            Util.confirm(`Save confirm`, 'Are you sure you want to save? this will lose all formatting.', async () => {
                await vscode.workspace.fs.writeFile(uri, new Uint8Array(content))
                handler.emit("saveDone")
            })
        }).on("saveCsv", async (content) => {
            await vscode.workspace.fs.writeFile(uri, enc.encode(content))
            handler.emit("saveDone")
        })
    }


    private async handleClass(uri: vscode.Uri, panel: vscode.WebviewPanel) {
        if (uri.scheme != "file") {
            vscode.commands.executeCommand('vscode.openWith', uri, "default");
            return;
        }

        const tempPath = `${tmpdir()}/office_temp_java`
        if (!existsSync(tempPath)) {
            mkdirSync(tempPath)
        }

        const java = spawn("java", ['-cp', '../resource/java-decompiler.jar', 'org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler', uri.fsPath, tempPath], { cwd: __dirname })
        java.stdout.on('data', (data) => {
            console.log(data.toString("utf8"))
            if (data.toString("utf8").indexOf("done") == -1) {
                return;
            }
            const fileName = `${tempPath}/${parse(uri.fsPath).name}.java`;
            setTimeout(() => {
                vscode.window.showTextDocument(vscode.Uri.file(fileName).with({ scheme: "decompile_java", query: new Date().getTime().toString() }));
            }, 10);
        });

        java.stderr.on('data', (data) => {
            Output.log(data.toString("utf8"))
        });

    }

}