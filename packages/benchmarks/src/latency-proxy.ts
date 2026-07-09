import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * In-process TCP proxy that delays every chunk by a fixed one-way latency,
 * simulating a remote link (RTT ≈ 2 × delayMs per round trip). Keeps the
 * benchmark self-contained — no extra containers, no system config.
 */
export class LatencyProxy {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  constructor(
    private readonly upstreamHost: string,
    private readonly upstreamPort: number,
    private readonly delayMs: number,
  ) {}

  async listen(): Promise<number> {
    this.server = createServer((client) => {
      const upstream = connect({ host: this.upstreamHost, port: this.upstreamPort });
      this.sockets.add(client).add(upstream);
      client.setNoDelay(true);
      upstream.setNoDelay(true);

      const forward = (from: Socket, to: Socket) => {
        from.on('data', (chunk: Buffer) => {
          if (this.delayMs === 0) {
            to.write(chunk);
          } else {
            setTimeout(() => {
              if (!to.destroyed) to.write(chunk);
            }, this.delayMs);
          }
        });
        from.on('close', () => setTimeout(() => to.destroy(), this.delayMs + 5));
        from.on('error', () => to.destroy());
      };
      forward(client, upstream);
      forward(upstream, client);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server!.address();
    if (addr === null || typeof addr === 'string') throw new Error('proxy listen failed');
    return addr.port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
