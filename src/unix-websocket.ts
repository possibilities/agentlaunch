import type { Socket } from "bun";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

export interface WebSocketHandlers {
  text(value: string): void;
  close(error?: string): void;
}

class Outbox {
  private readonly pending: Buffer[] = [];

  constructor(private readonly writeBytes: (data: Buffer) => number) {}

  write(data: Buffer): void {
    if (this.pending.length > 0) {
      this.pending.push(data);
      return;
    }
    const written = this.writeBytes(data);
    if (written < data.length) this.pending.push(data.subarray(Math.max(0, written)));
  }

  flush(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0] as Buffer;
      const written = this.writeBytes(head);
      if (written < head.length) {
        this.pending[0] = head.subarray(Math.max(0, written));
        return;
      }
      this.pending.shift();
    }
  }
}

interface Header {
  fin: boolean;
  opcode: number;
  length: number;
  bytes: number;
  mask: Buffer | null;
}

class Decoder {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;

  feed(chunk: Uint8Array): Array<{ opcode: number; payload: Buffer }> {
    const copied = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? copied : Buffer.concat([this.buffer, copied]);
    const messages: Array<{ opcode: number; payload: Buffer }> = [];
    for (;;) {
      const header = parseHeader(this.buffer);
      if (header === null || this.buffer.length < header.bytes + header.length) break;
      const payload = Buffer.from(this.buffer.subarray(header.bytes, header.bytes + header.length));
      this.buffer = this.buffer.subarray(header.bytes + header.length);
      if (header.mask !== null) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] =
            ((payload[i] as number) ^ (header.mask[i % header.mask.length] as number)) & 0xff;
        }
      }
      if (header.opcode === 0x0) {
        if (this.fragmentOpcode === null) throw new Error("continuation without a message");
        this.push(payload);
        if (!header.fin) continue;
        messages.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = null;
        continue;
      }
      if ((header.opcode === 0x1 || header.opcode === 0x2) && !header.fin) {
        if (this.fragmentOpcode !== null) throw new Error("nested fragmented message");
        this.fragmentOpcode = header.opcode;
        this.push(payload);
        continue;
      }
      messages.push({ opcode: header.opcode, payload });
    }
    return messages;
  }

  private push(payload: Buffer): void {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new Error("fragmented message exceeds cap");
    this.fragments.push(payload);
  }
}

function parseHeader(buffer: Buffer): Header | null {
  if (buffer.length < 2) return null;
  const first = buffer[0] as number;
  const second = buffer[1] as number;
  let bytes = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    bytes = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const large = buffer.readBigUInt64BE(2);
    if (large > BigInt(MAX_MESSAGE_BYTES)) throw new Error(`frame ${large} exceeds cap`);
    length = Number(large);
    bytes = 10;
  }
  let mask: Buffer | null = null;
  if ((second & 0x80) !== 0) {
    if (buffer.length < bytes + 4) return null;
    mask = buffer.subarray(bytes, bytes + 4);
    bytes += 4;
  }
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, length, bytes, mask };
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  const length = payload.length;
  const extended = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  if (extended === 0) header[1] = 0x80 | length;
  else if (extended === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskAt = 2 + extended;
  header.set(mask, maskAt);
  const encoded = Buffer.alloc(header.length + length);
  header.copy(encoded);
  for (let i = 0; i < length; i++) {
    encoded[header.length + i] =
      ((payload[i] as number) ^ (mask[i % mask.length] as number)) & 0xff;
  }
  return encoded;
}

function acceptValue(key: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(key + GUID);
  return hasher.digest("base64");
}

export class UnixWebSocket {
  private socket: Socket | null = null;
  private outbox: Outbox | null = null;
  private readonly decoder = new Decoder();
  private handshake = Buffer.alloc(0);
  private upgraded = false;
  private ended = false;

  private constructor(private readonly handlers: WebSocketHandlers) {}

  static async connect(path: string, handlers: WebSocketHandlers): Promise<UnixWebSocket> {
    const client = new UnixWebSocket(handlers);
    await client.open(path);
    return client;
  }

  sendText(value: string): void {
    this.write(frame(0x1, new TextEncoder().encode(value)));
  }

  close(): void {
    if (this.ended) return;
    try {
      this.write(frame(0x8, Buffer.from([0x03, 0xe8])));
      this.socket?.end();
    } catch {
      this.finish();
    }
  }

  private async open(path: string): Promise<void> {
    const keyBytes = new Uint8Array(16);
    crypto.getRandomValues(keyBytes);
    const key = Buffer.from(keyBytes).toString("base64");
    const expected = acceptValue(key);
    let resolveHandshake: (() => void) | null = null;
    let rejectHandshake: ((error: Error) => void) | null = null;
    const handshake = new Promise<void>((resolve, reject) => {
      resolveHandshake = resolve;
      rejectHandshake = reject;
    });
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_socket, chunk) => {
          try {
            if (!this.upgraded) {
              this.handshake = Buffer.concat([this.handshake, Buffer.from(chunk)]);
              const end = this.handshake.indexOf("\r\n\r\n");
              if (end < 0) return;
              const head = this.handshake.subarray(0, end).toString("utf8");
              if (!head.startsWith("HTTP/1.1 101 "))
                throw new Error(`handshake rejected: ${head.split("\r\n", 1)[0]}`);
              const actual = head.match(/\r\nsec-websocket-accept:\s*([^\r\n]+)/i)?.[1]?.trim();
              if (actual !== expected) throw new Error("websocket accept header mismatched");
              this.upgraded = true;
              resolveHandshake?.();
              const rest = this.handshake.subarray(end + 4);
              this.handshake = Buffer.alloc(0);
              if (rest.length > 0) this.handleFrames(rest);
              return;
            }
            this.handleFrames(chunk);
          } catch (error) {
            const problem = error instanceof Error ? error : new Error(String(error));
            rejectHandshake?.(problem);
            this.finish(problem.message);
          }
        },
        drain: () => this.outbox?.flush(),
        close: () => {
          rejectHandshake?.(new Error("connection closed during websocket handshake"));
          this.finish();
        },
        error: (_socket, error) => {
          rejectHandshake?.(error);
          this.finish(error.message);
        },
      },
    });
    this.socket = socket;
    this.outbox = new Outbox((data) => socket.write(data));
    this.write(
      Buffer.from(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      ),
    );
    const timer = setTimeout(
      () => rejectHandshake?.(new Error("websocket handshake timed out")),
      10_000,
    );
    try {
      await handshake;
    } catch (error) {
      socket.end();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleFrames(chunk: Uint8Array): void {
    for (const message of this.decoder.feed(chunk)) {
      if (message.opcode === 0x1) this.handlers.text(message.payload.toString("utf8"));
      else if (message.opcode === 0x8) this.close();
      else if (message.opcode === 0x9) this.write(frame(0xa, message.payload));
    }
  }

  private write(data: Buffer): void {
    if (this.ended || this.outbox === null) throw new Error("websocket is closed");
    this.outbox.write(data);
  }

  private finish(error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.socket = null;
    this.outbox = null;
    this.handlers.close(error);
  }
}
