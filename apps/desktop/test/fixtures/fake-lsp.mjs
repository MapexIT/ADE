// A tiny language server for tests (LSP framing over stdio): one diagnostic per opened file, a fixed hover and
// a definition on line 3 of the same file.
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
};
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    if (msg.method === 'initialize') send({ id: msg.id, result: { capabilities: { hoverProvider: true, definitionProvider: true, textDocumentSync: 1 } } });
    else if (msg.method === 'textDocument/didOpen' || msg.method === 'textDocument/didChange') {
      const uri = msg.params.textDocument.uri;
      const text = msg.params.textDocument.text ?? msg.params.contentChanges[0].text;
      send({
        method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics: text.includes('bad') ? [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, severity: 1, message: 'Unknown name "bad".', source: 'fake' }] : [] },
      });
    } else if (msg.method === 'textDocument/hover') send({ id: msg.id, result: { contents: { kind: 'markdown', value: '**const** answer: number' } } });
    else if (msg.method === 'textDocument/definition') {
      send({ id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } }] });
    } else if (msg.method === 'shutdown') send({ id: msg.id, result: null });
    else if (msg.method === 'exit') process.exit(0);
  }
});
