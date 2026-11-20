#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { serveStdio } from './agent.ts';

// stdout carries the protocol; anything diagnostic goes to stderr.
const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

const connection = serveStdio(stream, {
  ...(process.env.ADE_FAKE_STATE_DIR ? { stateDir: process.env.ADE_FAKE_STATE_DIR } : {}),
  chunkDelayMs: Number(process.env.ADE_FAKE_CHUNK_DELAY_MS ?? 1),
});

void connection.closed.then(() => process.exit(0));
process.stdin.on('end', () => process.exit(0));
