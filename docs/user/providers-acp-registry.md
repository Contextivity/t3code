# ACP Registry

ACP Registry is a generic provider for Agent Client Protocol (ACP) agents. Use it when you have an
ACP-speaking CLI that is not one of the built-in providers (Codex, Claude, Cursor, Grok, OpenCode).
The first supported example is Contextivity.

ACP Registry is off until you add an instance. T3 Code does not create a default one.

For first-time T3 Code setup, see [Install T3 Code](./install.md).

## Add An Instance

In **Settings** → **Add provider**, choose **ACP Registry**. Give it a display name, then set:

```text
Binary path: contextivity-agent
Launch arguments: --mode acp
Auth method ID: empty unless the agent requires a specific authenticate method
Attach T3 MCP when supported: on
```

The binary must be on the T3 Code server's `PATH`, or use an absolute path. Launch arguments are a
normal CLI string; T3 Code tokenizes them before spawning the agent.

For Contextivity, the launch command is:

```bash
contextivity-agent --mode acp
```

Set **Binary path** to `contextivity-agent` (or the full path) and **Launch arguments** to
`--mode acp`.

## Auth

Leave **Auth method ID** empty in the usual case. T3 Code then uses the first method the agent
advertises during ACP initialize. If the agent advertises none, T3 Code skips authenticate.

Set the field only when the agent advertises several methods and you need a specific one.

Run any login the agent needs on the machine that runs the T3 Code server, not on the device you
browse from.

## Models And Config

ACP Registry discovers models from the live ACP session. You can switch models on the current
thread; a new thread is not required.

Config options the agent advertises (modes, thinking, and similar session settings) are applied on
the live session when T3 Code has a matching UI control.

## MCP

T3 Code can offer its HTTP MCP server to an ACP agent. ACP Registry only sends that descriptor when
**Attach T3 MCP when supported** is on _and_ the initialized agent advertises compatible HTTP MCP.

Contextivity currently does not advertise ACP MCP and rejects a non-empty MCP server list. Leave the
switch on: T3 Code still omits MCP for that agent. Turn the switch off if you never want T3 MCP sent
to this instance.

## What You See In Chat

Standard ACP session traffic shows up in the thread: assistant text, reasoning, plans, tool calls,
permissions, image attachments, and cancel. Namespaced metadata on tool calls is kept on the tool
payload so the activity stays visible as an ACP tool.

## Limitations

- The native **Agents** panel does not reconstruct ACP subagent lineage. A Contextivity subagent
  still runs and appears as ACP tool activity in the thread; it does not become a nested T3 agent
  row.
- ACP `available_commands` updates have no T3 command palette or slash-command surface. Commands
  the agent advertises stay on the agent side.
- ACP Registry does not implement Grok's private x.ai extensions. Use the Grok provider for Grok.

## More Than One Agent

Add another ACP Registry instance for a second executable or a different argument set. Each instance
keeps its own binary path, launch arguments, auth method, and MCP switch.
