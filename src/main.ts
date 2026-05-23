#!/usr/bin/env node
import minimist from "minimist";
import { parseArgsStringToArgv } from "string-argv";
import { startWebSocketServer } from "./stdio-to-ws.js";
import { startTunnelHost } from "./tunnel-host.js";

const argv = minimist(process.argv.slice(2), {
  alias: { p: "port", h: "help", q: "quiet", g: "grace-period" },
  default: { port: 3000, "grace-period": "30", ping: 0 },
  boolean: ["quiet", "persist", "1", "tunnel"],  // Treat -1 as a boolean so we can detect it
  string: ["grace-period", "tunnel-name"],
});

const help = `Usage: stdio-to-ws [options] <command>

Options:
  -p, --port <port>              Port to listen on (default: 3000)
  --persist                      Enable process persistence for reconnections
  -g, --grace-period <seconds>   Grace period in seconds before killing child process on disconnect (default: 30, -1 for infinite, requires --persist)
  -q, --quiet                    Suppress logging output
  --tunnel                       Expose the WebSocket server via a Dev Tunnel (auto-creates wss:// URL)
  --tunnel-name <name>           Use a named tunnel (reusable across restarts, implies --tunnel)
  --ping <ms>                    Send WebSocket ping frames every <ms> milliseconds (default: 0, disabled)
  -h, --help                     Show this help message

Example:
  stdio-to-ws -p 8080 "python my-script.py"
  stdio-to-ws --persist --grace-period 60 "python my-script.py"
  stdio-to-ws --persist --grace-period -1 "python my-script.py"  # infinite persistence
  stdio-to-ws --quiet "python my-script.py"
  stdio-to-ws --tunnel "copilot --acp"                           # expose via Dev Tunnel
  stdio-to-ws --tunnel-name my-agent "copilot --acp"             # reusable named tunnel
  `;

if (argv.help) {
  console.log(help);
  process.exit(0);
}

const [cmd] = argv._;

if (!cmd) {
  console.error("No command provided.");
  // Show help message if no command is provided
  console.log(help);
  process.exit(1);
}

// Parse grace period in seconds, handling -1 as infinite
// minimist parses `--grace-period -1` as grace-period=true and -1 flag set
let gracePeriodMs: number;
if (argv["1"] === true || argv["grace-period"] === "-1") {
  gracePeriodMs = -1;
} else {
  const gracePeriodSeconds = parseInt(argv["grace-period"], 10);
  if (isNaN(gracePeriodSeconds)) {
    console.error("Grace period must be a number (in seconds) or -1 for infinite.");
    process.exit(1);
  }
  gracePeriodMs = gracePeriodSeconds * 1000;
}

if (typeof argv.ping !== "number" || argv.ping < 0) {
  console.error(`Invalid ping interval: ${argv.ping}`);
  process.exit(1);
}

void startWebSocketServer({
  command: parseArgsStringToArgv(cmd),
  port: argv.port,
  quiet: argv.quiet,
  persist: argv.persist,
  gracePeriodMs,
  pingIntervalMs: argv.ping,
});

// Start tunnel host if --tunnel or --tunnel-name is provided
const useTunnel = argv.tunnel || argv["tunnel-name"];
if (useTunnel) {
  void startTunnelHost({
    port: argv.port,
    quiet: argv.quiet,
    tunnelName: typeof argv["tunnel-name"] === "string" ? argv["tunnel-name"] : undefined,
  });
}
