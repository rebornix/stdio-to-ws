# stdio-to-ws

Bridge any stdio process to a WebSocket server. Optionally expose it to the internet via [Microsoft Dev Tunnels](https://aka.ms/devtunnels/docs) — no reverse proxy or DNS required.

## Usage

```bash
npx stdio-to-ws "stdio command" --port 3000
```

Example:

```bash
npx stdio-to-ws "npx @google/gemini-cli --experimental-acp" --port 3000
```

### Options

```
-p, --port <port>              Port to listen on (default: 3000)
--persist                      Keep child process alive during disconnections
-g, --grace-period <seconds>   Time in seconds before killing disconnected process (default: 30, -1 for infinite)
--tunnel                       Expose the server via a Dev Tunnel (auto-creates a wss:// URL)
--tunnel-name <name>           Use a named Dev Tunnel (reusable across restarts, implies --tunnel)
--ping <ms>                    Send WebSocket ping frames every <ms> milliseconds (default: 0, disabled)
-q, --quiet                    Suppress logging output
-h, --help                     Show help message
```

### Persistence Mode

Use `--persist` to keep the child process alive during brief disconnections (e.g., iOS app backgrounding):

```bash
npx stdio-to-ws --persist "python my-script.py"
```

When enabled:

- Server sends `{"type": "connected", "clientId": "..."}` on new connection
- Client saves the `clientId` and sends it via `X-Client-Id` header on reconnect
- Messages are buffered during disconnection and replayed on reconnect

### Dev Tunnels

Add `--tunnel` to make the WebSocket server accessible from anywhere over `wss://`, with no manual TLS or proxy setup:

```bash
npx stdio-to-ws --tunnel "copilot --acp"
```

On first run you'll be prompted to authenticate with GitHub via device code flow. The token is cached at `~/.config/stdio-to-ws/tunnel-auth.json` for subsequent runs.

Once connected the tunnel URL is printed to the console:

```
  Tunnel URL: https://<id>-3000.<cluster>.devtunnels.ms
```

Connect to this URL from any WebSocket client (e.g. [Agmente](https://github.com/rebornix/Agmente)).

#### Named tunnels

Use `--tunnel-name` to create a reusable tunnel that keeps the same URL across restarts:

```bash
npx stdio-to-ws --tunnel-name my-agent --persist --grace-period 604800 "copilot --acp"
```

If a tunnel with that name already exists it will be reused; otherwise a new one is created.

#### How it works

1. Authenticates with GitHub (device code flow, same OAuth app as VS Code).
2. Creates (or finds) a Dev Tunnel via the management API.
3. Registers the WebSocket port with anonymous connect access.
4. Starts a `TunnelRelayTunnelHost` that forwards incoming relay connections to `localhost:<port>`.

The tunnel is cleaned up automatically on SIGINT/SIGTERM.

## License

Apache 2.0
