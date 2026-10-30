# Remote Ports

[![Release](https://img.shields.io/github/actions/workflow/status/00INDEX/RemotePortForward/release.yml?event=push&style=flat-square&logo=github&logoColor=white&label=Release&labelColor=24292f)](https://github.com/00INDEX/RemotePortForward/actions/workflows/release.yml)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-Install-007acc?style=flat-square&labelColor=24292f)](https://marketplace.visualstudio.com/items?itemName=00index.remote-port-forward)
[![Open VSX](https://img.shields.io/open-vsx/v/00index/remote-port-forward?style=flat-square&label=Open%20VSX&color=a855f7&labelColor=24292f)](https://open-vsx.org/extension/00index/remote-port-forward)
[![License](https://img.shields.io/github/license/00INDEX/RemotePortForward?style=flat-square&label=License&color=14b8a6&labelColor=24292f)](LICENSE)

Remote Ports makes TCP services on your computer or local network accessible from a Remote-SSH workspace. A remote application connects to a loopback port on the SSH host, and the extension forwards that connection to the configured target address.

For example, a service at `192.168.1.20:8080` can be accessed from the remote workspace at `127.0.0.1:18080`.

## Features

- Forward TCP connections to local or LAN services, including HTTP, HTTPS, WebSocket, and database endpoints.
- Configure targets using IPv4 addresses, hostnames, or bracketed IPv6 addresses such as `[::1]:3000`.
- Manage mappings in a **Remote Ports** panel with editable addresses and ports, start/stop controls, labels, and clipboard actions.
- Display the process name and PID for listeners on the local computer. Targets on other devices are identified as **Remote device**.
- Persist mappings per workspace, with optional startup activation.
- Support TCP half-close, per-connection flow control, bounded buffers, and up to 64 concurrent connections per session.
- Reuse the IDE's remote connection without starting another SSH session or using a public relay.

Target ports may range from 1 to 65535. Remote listeners bind exclusively to `127.0.0.1`, on ports from 1024 to 65535. UDP, browser-based IDEs, and forwarding after the IDE exits are not supported.

## Installation

Requires desktop VS Code 1.95 or later, Remote-SSH, and a trusted remote workspace. Functional verification covers a macOS client with a Linux SSH host. Compatibility with other VS Code-based IDEs is not yet established.

### VSIX installation

For offline installation, build the packages from source with Node.js 22.13 or later:

```sh
npm ci
npm run package
```

The packages and their SHA-256 checksums are written to `artifacts/`.

1. Install `remote-ports-local-0.1.0.vsix` on the local computer using **Extensions: Install from VSIX...**.
2. Connect to the SSH workspace and install `remote-ports-remote-0.1.0.vsix` on the remote host.
3. Open the **Remote Ports** panel and select **Forward an Address**.
4. Enter the target address and the remote port, then connect to `127.0.0.1:<forwarded-port>` from the remote application.

**Address** is resolved and connected from the local computer. **Forwarded Port** is the port exposed on the remote host. The row's copy button copies the port number; the context menu can also copy the complete remote address. A listening status confirms that the remote port is bound, not that the target service is available.

### Registry installation

Install **Remote Ports** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=00index.remote-port-forward) or [Open VSX](https://open-vsx.org/extension/00index/remote-port-forward) while connected to the SSH workspace. The extension pack installs **Remote Ports Companion** locally. Both components must be available in the registry used by the IDE.

Remove earlier `local-dev` packages before installing the registry distribution to avoid duplicate command registrations.

## Architecture

The extension consists of a remote workspace component and a local UI companion. The remote component creates the loopback listeners; the companion opens connections to the configured services.

```text
Remote application -> Remote loopback port -> Remote component
                                                    |
                                               IDE tunnel
                                                    |
Target service <--------- Local companion <---------+
```

The components establish a session through VS Code commands. The remote relay is made reachable through `vscode.env.asExternalUri`, and a persistent WebSocket carries bidirectional TCP traffic. Business data does not pass through commands or the webview.

Each TCP connection has a distinct stream identifier. Binary frames carry data, receive-window credits, half-close notifications, and resets. Per-stream receive windows are 256 KiB, with payload frames limited to 64 KiB. Flow control prevents a slow consumer from creating an unbounded application queue.

A per-session challenge-response handshake authenticates the relay. The local companion accepts connection requests only for explicitly configured mappings. Credentials remain in memory. Remote loopback listeners are accessible to other users on the same remote machine; target services should retain their own application-level authentication where required.

Stopping a mapping releases its listener and associated connections. Transport loss terminates existing TCP streams; application requests are not replayed. The IDE owns the auxiliary forward created by `asExternalUri`, so its entry may remain in the native Ports panel until the IDE or user closes it.

## Performance

The following measurements were recorded on 2026-10-30. They are single-run samples, not performance guarantees.

### Transport overhead

The transport-only workload ran on an Apple M3 Pro with 12 logical cores, macOS ARM64, and Node.js 22.13.1. It included 300 steady-state 64-byte echo samples, 100 new-connection samples, and a 128 MiB echo transfer. The client, service, and relay ran in one Node.js process over loopback.

| Metric | Direct TCP | Remote Ports transport |
| --- | ---: | ---: |
| Echo payload throughput | 1,447.24 MiB/s | 158.74 MiB/s |
| Steady-state echo RTT, p50 | 0.055 ms | 0.126 ms |
| Steady-state echo RTT, p95 | 0.120 ms | 0.157 ms |
| Connection to first echo, p50 | 0.139 ms | 0.340 ms |
| Complete workload wall time | 129.4 ms | 963.7 ms |
| Process CPU time, user + system | 194.9 ms | 1,281.2 ms |
| Average process CPU utilization | 150.6% | 132.9% |

CPU utilization is process CPU time divided by wall time, with 100% representing one logical core. It can exceed 100% because process CPU time includes multiple threads. These measurements cover all roles in the same process and are not isolated extension-host CPU measurements. The total CPU time, rather than average utilization alone, indicates the additional work performed by the relay.

### Comparison with native Port Forward

A separate VS Code 1.140.0 Remote-SSH baseline used a macOS ARM64 client, a Linux SSH host, 100 steady-state echo samples, 100 new-connection samples, and a 32 MiB echo transfer.

| Native VS Code Port Forward metric | Observed result |
| --- | ---: |
| Echo payload throughput | 25.47 MiB/s |
| Steady-state echo RTT, p50 | 42.477 ms |
| Steady-state echo RTT, p95 | 169.112 ms |
| Connection to first echo, p50 | 210.949 ms |
| Average benchmark-client CPU utilization | 0.53% of one logical core |

The native baseline and the loopback results use different network paths and workloads and must not be compared numerically. The native CPU figure covers only the benchmark client, excluding the IDE and remote host. A matched comparison of native Port Forward and Remote Ports, including combined endpoint CPU consumption, is not yet available. Performance parity has not been established.
